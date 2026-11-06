/**
 * Minimal Telegram Bot API client over the built-in `fetch`.
 *
 * Design constraints (see docs/000-architecture.md and docs/dsh-api-notes.md):
 * - no third-party HTTP dependency and no long-lived sockets of our own;
 * - every request can be aborted through an `AbortSignal`, so `source.stop()`
 *   interrupts an in-flight long poll immediately;
 * - 429 (`retry_after`) and 5xx answers are retried with exponential backoff
 *   and jitter, and the final error is descriptive but NEVER contains the bot
 *   token: the token only ever appears inside the request URL, which we do not
 *   put into error messages;
 * - messages longer than Telegram's 4096-character limit are split on safe
 *   boundaries, and a chunk is rendered (optionally) as Telegram-safe HTML
 *   *after* splitting so tags cannot be cut in half.
 *
 * The client is deliberately token-efficient and predictable: one method per
 * Bot API call the source needs, no caching beyond the token itself.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** A 429/5xx answer in the shape the Bot API documents. */
export interface TelegramResponseEnvelope {
  ok: boolean
  result?: unknown
  error_code?: number
  description?: string
  parameters?: { retry_after?: number; migrate_to_chat_id?: number }
}

/** An error thrown for an unsuccessful Bot API answer or a network failure. */
export class TelegramApiError extends Error {
  /** Telegram `error_code`; `0` means a network/transport failure. */
  readonly code: number
  readonly description: string
  /** Seconds Telegram asked us to wait (429), when present. */
  readonly retryAfter?: number

  constructor(method: string, code: number, description: string, retryAfter?: number) {
    super(`Telegram ${method} failed (${code}): ${description}`)
    this.name = 'TelegramApiError'
    this.code = code
    this.description = description
    if (retryAfter !== undefined) this.retryAfter = retryAfter
  }
}

/** A token that could not be read. The message never contains the value. */
export class TelegramTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TelegramTokenError'
  }
}

/** Resolve once `ms` elapsed, or reject when `signal` aborts. Timers are unref'd. */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(abortError())
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = (): void => {
      cleanup()
      reject(abortError())
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** An Error whose `name` is `AbortError`, matching fetch/DOM conventions. */
export function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

/** Whether `error` is an abort of the caller's own signal (not an internal timeout). */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// ---------------------------------------------------------------------------
// Token provider
// ---------------------------------------------------------------------------

export interface TelegramTokenOptions {
  /** Environment variable name; defaults to `defaultEnv`. */
  tokenEnv?: string
  /** File containing the token; takes precedence over `tokenEnv` when set. */
  tokenFile?: string
  /** Environment variable used when neither field is configured. */
  defaultEnv?: string
}

/**
 * Build a lazy token provider. The token is read once and cached; read errors
 * are thrown as {@link TelegramTokenError} with a value-free message.
 *
 * File wins over environment variable: an explicit `tokenFile` is a stronger
 * statement of intent than a default environment variable name.
 */
export function createTokenProvider(options: TelegramTokenOptions = {}): () => Promise<string> {
  const defaultEnv = options.defaultEnv ?? 'SUPERAGENT_TELEGRAM_TOKEN'
  let cached: string | undefined
  return async (): Promise<string> => {
    if (cached) return cached
    if (options.tokenFile) {
      let raw: string
      try {
        raw = await readFile(options.tokenFile, 'utf8')
      } catch (error) {
        throw new TelegramTokenError(
          `Telegram token file could not be read (${options.tokenFile}): ${describeError(error)}`,
        )
      }
      const token = raw.trim()
      if (!token) throw new TelegramTokenError(`Telegram token file is empty (${options.tokenFile})`)
      cached = token
      return token
    }
    const envName = options.tokenEnv?.trim() || defaultEnv
    const value = process.env[envName]
    const token = value?.trim()
    if (!token) {
      throw new TelegramTokenError(
        `Telegram token is not set: configure tokenFile or set the environment variable ${envName}`,
      )
    }
    cached = token
    return token
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// ---------------------------------------------------------------------------
// Message splitting / rendering
// ---------------------------------------------------------------------------

/** Telegram rejects messages longer than this (UTF-16 code units). */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096

/**
 * Split `text` into chunks of at most `limit` UTF-16 code units.
 *
 * The split prefers a newline, then a space, in the last quarter of the window,
 * and never cuts a surrogate pair. Empty text yields no chunks.
 */
export function chunkText(text: string, limit: number = TELEGRAM_MAX_MESSAGE_LENGTH): string[] {
  if (!text) return []
  if (limit < 2) return [text]
  const normalized = text.replace(/\r\n/g, '\n')
  const chunks: string[] = []
  let rest = normalized
  while (rest.length > limit) {
    let end = limit
    // Do not split a surrogate pair.
    const last = rest.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end -= 1
    // Prefer a natural boundary within the last quarter of the window.
    const windowStart = Math.max(0, end - Math.floor(limit / 4))
    const probe = rest.slice(windowStart, end)
    const newline = probe.lastIndexOf('\n')
    const space = probe.lastIndexOf(' ')
    let cut = end
    if (newline >= 0) cut = windowStart + newline + 1
    else if (space >= 0) cut = windowStart + space + 1
    const chunk = rest.slice(0, cut)
    if (chunk.length > 0) chunks.push(chunk)
    rest = rest.slice(cut)
    // A consumed newline at the split boundary should not start the next chunk.
    if (rest.startsWith('\n')) rest = rest.slice(1)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** Escape text for Telegram's HTML parse mode. */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Render a Markdown subset as Telegram-safe HTML (escaping `& < >`). Supported:
 * `**bold**`, `__bold__`, `*italic*`, `_italic_`, `~~strike~~`, inline
 * `` `code` ``, fenced ```pre```, `[label](https://url)` and `-`/`*`/`1.`
 * list items (Telegram has no `<ul>`, so lists become `•` text lines).
 */
export function markdownToTelegramHtml(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const out: string[] = []
  let inFence = false
  let fenceLanguage = ''
  for (const line of lines) {
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceLanguage = fence[1] ? ` class="language-${escapeHtmlAttribute(fence[1])}"` : ''
        out.push(`<pre><code${fenceLanguage}>`)
      } else {
        inFence = false
        out.push('</code></pre>')
      }
      continue
    }
    if (inFence) {
      out.push(escapeTelegramHtml(line))
      continue
    }
    let value = line
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(value)
    if (heading) value = `**${heading[1]}**`
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(value)
    if (bullet) value = `${bullet[1]}• ${bullet[2]}`
    out.push(renderMarkdownInline(value))
  }
  if (inFence) out.push('</code></pre>')
  return out.join('\n')
}

function escapeHtmlAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderMarkdownInline(line: string): string {
  const placeholders: string[] = []
  const stash = (html: string): string => {
    placeholders.push(html)
    return `\u0000${placeholders.length - 1}\u0000`
  }
  let work = line.replace(/`([^`\n]+)`/g, (_match, code: string) => stash(`<code>${escapeTelegramHtml(code)}</code>`))
  work = work.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) => stash(`<a href="${escapeHtmlAttribute(url)}">${escapeTelegramHtml(label)}</a>`),
  )
  work = escapeTelegramHtml(work)
  work = work.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  work = work.replace(/__([^_\n]+)__/g, '<b>$1</b>')
  work = work.replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
  work = work.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>')
  work = work.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<i>$2</i>')
  return work.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => placeholders[Number(index)] ?? '')
}

/** Strip Telegram HTML back to readable plain text (fallback for parse errors). */
export function stripTelegramHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

function tagName(tag: string): string {
  const match = /^<\/?([A-Za-z0-9-]+)/.exec(tag)
  return match?.[1]?.toLowerCase() ?? ''
}

/**
 * Split rendered Telegram HTML into chunks of at most `limit` characters
 * without cutting tags or HTML entities: an open tag is closed at the end of
 * a chunk and reopened at the start of the next one, so every chunk is
 * independently parseable by Telegram.
 */
export function chunkTelegramHtml(html: string, limit: number = TELEGRAM_MAX_MESSAGE_LENGTH): string[] {
  if (!html) return []
  if (limit < 32) return [html]
  const chunks: string[] = []
  const stack: string[] = []
  let current = ''
  let length = 0
  const closing = (): string => [...stack].reverse().map(tag => `</${tagName(tag)}>`).join('')
  const flush = (): void => {
    const close = closing()
    if (current.length > 0 && current !== stack.join('')) chunks.push(`${current}${close}`)
    current = stack.join('')
    length = current.length
  }
  const room = (): number => limit - length - closing().length
  const pushText = (text: string): void => {
    let rest = text
    while (rest.length > 0) {
      const available = room()
      if (available < 8) {
        flush()
        continue
      }
      if (rest.length <= available) {
        current += rest
        length += rest.length
        return
      }
      let cut = available
      // Never cut an HTML entity or a surrogate pair.
      const amp = rest.lastIndexOf('&', cut)
      if (amp >= 0 && rest.indexOf(';', amp) >= cut) cut = amp
      const last = rest.charCodeAt(cut - 1)
      if (last >= 0xd800 && last <= 0xdbff) cut -= 1
      // Prefer whitespace/newline near the cut.
      const space = Math.max(rest.lastIndexOf(' ', cut), rest.lastIndexOf('\n', cut))
      if (space > cut - 200) cut = space + 1
      if (cut < 1) {
        flush()
        continue
      }
      current += rest.slice(0, cut)
      length += cut
      rest = rest.slice(cut)
      flush()
    }
  }
  let index = 0
  while (index < html.length) {
    const lt = html.indexOf('<', index)
    if (lt === -1) {
      pushText(html.slice(index))
      break
    }
    if (lt > index) pushText(html.slice(index, lt))
    const gt = html.indexOf('>', lt)
    if (gt === -1) {
      pushText(html.slice(lt))
      break
    }
    const tag = html.slice(lt, gt + 1)
    const isClosing = tag.startsWith('</')
    const selfClosing = /\/>$/.test(tag)
    if (isClosing) {
      const name = tagName(tag)
      const at = stack.map(item => tagName(item)).lastIndexOf(name)
      if (at >= 0) stack.splice(at, 1)
      current += tag
      length += tag.length
    } else if (!selfClosing) {
      if (length + tag.length + closing().length >= limit) flush()
      current += tag
      length += tag.length
      stack.push(tag)
    } else {
      if (length + tag.length + closing().length >= limit) flush()
      current += tag
      length += tag.length
    }
    index = gt + 1
  }
  const close = closing()
  if (current.length > 0) chunks.push(`${current}${close}`)
  return chunks
}

/**
 * Backwards-compatible single-chunk renderer: `telegram` Markdown to safe HTML,
 * everything else verbatim without a parse mode.
 */
export function renderTelegramChunk(
  text: string,
  markdown?: 'plain' | 'telegram' | 'github',
): { text: string; parseMode?: 'HTML' } {
  if (markdown !== 'telegram') return { text }
  return { text: markdownToTelegramHtml(text), parseMode: 'HTML' }
}

// ---------------------------------------------------------------------------
// Bot API types (only the fields this plugin reads)
// ---------------------------------------------------------------------------

export interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
}

export interface TelegramMessageEntity {
  type: string
  offset: number
  length: number
  url?: string
  user?: TelegramUser
}

export interface TelegramPhotoSize {
  file_id: string
  file_unique_id?: string
  width: number
  height: number
  file_size?: number
}

export interface TelegramDocument {
  file_id: string
  file_unique_id?: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export interface TelegramAudioLike {
  file_id: string
  file_unique_id?: string
  file_name?: string
  mime_type?: string
  file_size?: number
  duration?: number
}

export interface TelegramMessage {
  message_id: number
  date: number
  from?: TelegramUser
  chat: TelegramChat
  text?: string
  caption?: string
  entities?: TelegramMessageEntity[]
  caption_entities?: TelegramMessageEntity[]
  reply_to_message?: TelegramMessage
  photo?: TelegramPhotoSize[]
  document?: TelegramDocument
  voice?: TelegramAudioLike
  audio?: TelegramAudioLike
  video?: TelegramAudioLike
  media_group_id?: string
  is_topic_message?: boolean
  message_thread_id?: number
  [key: string]: unknown
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  data?: string
  message?: TelegramMessage
  chat_instance?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
  [key: string]: unknown
}

export interface TelegramFile {
  file_id: string
  file_unique_id?: string
  file_size?: number
  file_path?: string
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export interface TelegramApiOptions {
  /** Literal token or an async provider such as {@link createTokenProvider}. */
  token: string | (() => Promise<string>)
  /** Defaults to `https://api.telegram.org`. Tests point this at a fake server. */
  baseUrl?: string
  fetchImpl?: typeof fetch
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  timeoutMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

interface CallOptions {
  signal?: AbortSignal
  timeoutMs?: number
  attempts?: number
}

interface RawAnswer {
  status: number
  ok: boolean
  body: unknown
}

function isRetryableCode(code: number): boolean {
  return code === 0 || code === 409 || code === 420 || code === 429 || code >= 500
}

/** Bot API limits for outgoing files. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024

function isEntityParseError(error: unknown): boolean {
  return (
    error instanceof TelegramApiError &&
    error.code === 400 &&
    /parse|entit|tag|markup/i.test(error.description)
  )
}

function guessMimeType(fileName: string): string {
  const extension = /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? ''
  const known: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    zip: 'application/zip',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    mp4: 'video/mp4',
  }
  return known[extension] ?? 'application/octet-stream'
}

export class TelegramApi {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly maxAttempts: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly timeoutMs: number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly tokenProvider: () => Promise<string>

  constructor(options: TelegramApiOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 4)
    this.baseDelayMs = Math.max(10, options.baseDelayMs ?? 500)
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? 60_000)
    this.timeoutMs = Math.max(1000, options.timeoutMs ?? 30_000)
    this.sleep = options.sleep ?? sleepWithSignal
    if (typeof options.token === 'string') {
      const literal = options.token
      this.tokenProvider = async () => literal
    } else {
      this.tokenProvider = options.token
    }
  }

  /** Call one Bot API method, retrying 429/5xx/network failures. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> {
    const attempts = Math.max(1, options.attempts ?? this.maxAttempts)
    let attempt = 0
    let lastError: unknown
    while (attempt < attempts) {
      attempt += 1
      try {
        const answer = await this.attempt(method, params, options)
        if (!answer.ok) {
          const body = isRecord(answer.body) ? answer.body : {}
          const code = typeof body.error_code === 'number' ? body.error_code : answer.status
          const description = typeof body.description === 'string' ? body.description : `HTTP ${answer.status}`
          const parameters = isRecord(body.parameters) ? body.parameters : undefined
          const retryAfter = parameters && typeof parameters.retry_after === 'number' ? parameters.retry_after : undefined
          throw new TelegramApiError(method, code, description, retryAfter)
        }
        const envelope = isRecord(answer.body) ? answer.body : {}
        return envelope.result as T
      } catch (error) {
        lastError = error
        if (options.signal?.aborted) throw abortError()
        // Only Bot API answers are retryable here: transport failures are already
        // wrapped into `TelegramApiError` by `attempt`, and anything else (a token
        // that could not be read, an abort) must fail immediately.
        if (!(error instanceof TelegramApiError)) throw error
        if (!isRetryableCode(error.code) || attempt >= attempts) throw error
        const delay =
          error.retryAfter !== undefined
            ? Math.min(this.maxDelayMs, Math.max(0, error.retryAfter * 1000))
            : this.backoff(attempt)
        await this.sleep(delay, options.signal)
      }
    }
    throw lastError instanceof Error ? lastError : new TelegramApiError(method, 0, 'request failed')
  }

  private backoff(attempt: number): number {
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt)
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential / 4)))
    return exponential + jitter
  }

  private async attempt(
    method: string,
    params: Record<string, unknown>,
    options: CallOptions,
  ): Promise<RawAnswer> {
    const token = await this.tokenProvider()
    const url = `${this.baseUrl}/bot${token}/${method}`
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal,
      })
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) {
        // A timeout of our own is retryable; aborting the caller's signal is not.
        if (options.signal?.aborted) throw abortError()
        throw new TelegramApiError(method, 0, `network timeout after ${timeoutMs}ms`)
      }
      throw new TelegramApiError(method, 0, `network error: ${describeError(error)}`)
    }
    let text: string
    try {
      text = await response.text()
    } catch (error) {
      throw new TelegramApiError(method, 0, `network error while reading the answer: ${describeError(error)}`)
    }
    let body: unknown
    if (text.trim()) {
      try {
        body = JSON.parse(text)
      } catch {
        throw new TelegramApiError(method, response.status, 'invalid JSON answer')
      }
    }
    return { status: response.status, ok: response.ok && isRecord(body) && body.ok === true, body }
  }

  // -------------------------------------------------------------------------
  // Methods used by the source
  // -------------------------------------------------------------------------

  async getMe(signal?: AbortSignal): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe', {}, { signal })
  }

  async getUpdates(options: GetUpdatesOptions = {}): Promise<TelegramUpdate[]> {
    const timeoutSeconds = clamp(options.timeoutSeconds ?? 25, 0, 300)
    const params: Record<string, unknown> = { timeout: timeoutSeconds }
    if (options.offset !== undefined) params.offset = options.offset
    if (options.limit !== undefined) params.limit = clamp(options.limit, 1, 100)
    if (options.allowedUpdates) params.allowed_updates = options.allowedUpdates
    const result = await this.call<unknown>('getUpdates', params, {
      signal: options.signal,
      // Long polling deliberately holds the connection; leave headroom above it.
      timeoutMs: (timeoutSeconds + 15) * 1000,
      attempts: options.attempts,
    })
    if (!Array.isArray(result)) throw new TelegramApiError('getUpdates', 0, 'invalid result shape')
    return result as TelegramUpdate[]
  }

  async sendMessage(options: SendMessageOptions): Promise<TelegramMessage | undefined> {
    const text = options.text ?? ''
    if (!text.trim()) return undefined
    // Rich text: Markdown subset -> Telegram HTML, chunked so tags stay balanced.
    const rich = options.markdown === 'telegram' && options.rich !== false
    const chunks = rich ? chunkTelegramHtml(markdownToTelegramHtml(text)) : chunkText(text)
    let last: TelegramMessage | undefined
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!
      const params: Record<string, unknown> = {
        chat_id: normalizeChatId(options.chatId),
        text: chunk,
        disable_notification: options.disableNotification ?? false,
      }
      if (rich) params.parse_mode = 'HTML'
      if (options.disableWebPagePreview !== undefined) {
        params.disable_web_page_preview = options.disableWebPagePreview
      }
      if (options.messageThreadId !== undefined) params.message_thread_id = options.messageThreadId
      if (index === 0 && options.replyToMessageId !== undefined) {
        params.reply_to_message_id = options.replyToMessageId
        // The original message may be gone after a restart; do not fail the send.
        params.allow_sending_without_reply = true
      }
      if (index === 0 && options.replyMarkup !== undefined) {
        params.reply_markup = JSON.stringify(options.replyMarkup)
      }
      try {
        last = await this.call<TelegramMessage>('sendMessage', params, {
          signal: options.signal,
          attempts: options.attempts,
        })
      } catch (error) {
        // Telegram refused the HTML entity parse: degrade to plain text once.
        if (rich && isEntityParseError(error)) {
          const plain: Record<string, unknown> = { ...params, text: stripTelegramHtml(chunk) }
          delete plain.parse_mode
          last = await this.call<TelegramMessage>('sendMessage', plain, {
            signal: options.signal,
            attempts: options.attempts,
          })
        } else {
          throw error
        }
      }
    }
    return last
  }

  /** Send one local photo via multipart/form-data. */
  async sendPhoto(options: SendFileOptions): Promise<TelegramMessage | undefined> {
    return this.sendUpload('sendPhoto', 'photo', options, MAX_PHOTO_BYTES)
  }

  /** Send one local file via multipart/form-data. */
  async sendDocument(options: SendFileOptions): Promise<TelegramMessage | undefined> {
    return this.sendUpload('sendDocument', 'document', options, MAX_DOCUMENT_BYTES)
  }

  private async sendUpload(
    method: string,
    field: 'photo' | 'document',
    options: SendFileOptions,
    maxBytes: number,
  ): Promise<TelegramMessage | undefined> {
    const bytes = await readFile(options.path)
    if (bytes.byteLength === 0) throw new TelegramApiError(method, 0, `file is empty: ${basename(options.path)}`)
    if (bytes.byteLength > maxBytes) {
      throw new TelegramApiError(method, 0, `file is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB`)
    }
    const fileName = options.name?.trim() || basename(options.path)
    const mime = options.mime?.trim() || guessMimeType(fileName)
    const attempts = Math.max(1, options.attempts ?? this.maxAttempts)
    let attempt = 0
    let lastError: unknown
    while (attempt < attempts) {
      attempt += 1
      try {
        const token = await this.tokenProvider()
        const url = `${this.baseUrl}/bot${token}/${method}`
        const form = new FormData()
        form.set('chat_id', String(normalizeChatId(options.chatId)))
        if (options.caption?.trim()) form.set('caption', options.caption.trim())
        if (options.messageThreadId !== undefined) form.set('message_thread_id', String(options.messageThreadId))
        if (options.replyToMessageId !== undefined) {
          form.set('reply_to_message_id', String(options.replyToMessageId))
          form.set('allow_sending_without_reply', 'true')
        }
        if (options.replyMarkup !== undefined) form.set('reply_markup', JSON.stringify(options.replyMarkup))
        form.set(field, new Blob([bytes], { type: mime }), fileName)
        const timeout = AbortSignal.timeout(this.timeoutMs)
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
        let response: Response
        try {
          response = await this.fetchImpl(url, { method: 'POST', body: form, signal })
        } catch (error) {
          if (options.signal?.aborted) throw abortError()
          throw new TelegramApiError(method, 0, `network error: ${describeError(error)}`)
        }
        const text = await response.text()
        let body: unknown
        try {
          body = text.trim() ? JSON.parse(text) : undefined
        } catch {
          throw new TelegramApiError(method, response.status, 'invalid JSON answer')
        }
        if (response.ok && isRecord(body) && body.ok === true) return body.result as TelegramMessage
        const envelope = isRecord(body) ? body : {}
        const code = typeof envelope.error_code === 'number' ? envelope.error_code : response.status
        const description = typeof envelope.description === 'string' ? envelope.description : `HTTP ${response.status}`
        const parameters = isRecord(envelope.parameters) ? envelope.parameters : undefined
        const retryAfter = parameters && typeof parameters.retry_after === 'number' ? parameters.retry_after : undefined
        throw new TelegramApiError(method, code, description, retryAfter)
      } catch (error) {
        lastError = error
        if (options.signal?.aborted) throw abortError()
        if (!(error instanceof TelegramApiError)) throw error
        if (!isRetryableCode(error.code) || attempt >= attempts) throw error
        const delay =
          error.retryAfter !== undefined
            ? Math.min(this.maxDelayMs, Math.max(0, error.retryAfter * 1000))
            : this.backoff(attempt)
        await this.sleep(delay, options.signal)
      }
    }
    throw lastError instanceof Error ? lastError : new TelegramApiError(method, 0, 'upload failed')
  }

  /**
   * Download one Bot API file (from `getFile().file_path`) to `destination`.
   * Creates the parent directory (0700), writes the file with mode 0600 and
   * refuses bodies larger than `maxBytes`. Error messages never include the
   * token-bearing download URL.
   */
  async downloadFile(
    filePath: string,
    destination: string,
    options: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<{ bytes: number }> {
    const token = await this.tokenProvider()
    const url = `${this.baseUrl}/file/bot${token}/${filePath.replace(/^\/+/, '')}`
    const timeout = AbortSignal.timeout(Math.max(this.timeoutMs, 60_000))
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetchImpl(url, { signal })
    } catch (error) {
      if (options.signal?.aborted) throw abortError()
      throw new TelegramApiError('downloadFile', 0, `network error: ${describeError(error)}`)
    }
    if (!response.ok) {
      throw new TelegramApiError('downloadFile', response.status, 'the Bot API file could not be downloaded')
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    const maxBytes = options.maxBytes ?? 20 * 1024 * 1024
    if (bytes.byteLength > maxBytes) {
      throw new TelegramApiError('downloadFile', 0, `file exceeds the ${maxBytes} byte download limit`)
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await writeFile(destination, bytes, { mode: 0o600 })
    return { bytes: bytes.byteLength }
  }

  /** Register the bot command list (best effort). */
  async setMyCommands(
    commands: Array<{ command: string; description: string }>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.call<boolean>('setMyCommands', { commands }, { signal, attempts: 2 })
  }

  /** Remove (or replace) the inline keyboard of a sent message. */
  async editMessageReplyMarkup(
    options: { chatId: string | number; messageId: number; replyMarkup?: unknown },
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.call<boolean>(
      'editMessageReplyMarkup',
      {
        chat_id: normalizeChatId(options.chatId),
        message_id: options.messageId,
        ...(options.replyMarkup !== undefined
          ? { reply_markup: JSON.stringify(options.replyMarkup) }
          : {}),
      },
      { signal, attempts: 1 },
    )
  }

  async getFile(fileId: string, signal?: AbortSignal): Promise<TelegramFile> {
    return this.call<TelegramFile>('getFile', { file_id: fileId }, { signal })
  }

  async answerCallbackQuery(
    options: { callbackQueryId: string; text?: string; showAlert?: boolean },
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.call<boolean>(
      'answerCallbackQuery',
      {
        callback_query_id: options.callbackQueryId,
        ...(options.text ? { text: options.text } : {}),
        ...(options.showAlert ? { show_alert: true } : {}),
      },
      { signal, attempts: 1 },
    )
  }
}

export interface GetUpdatesOptions {
  /** Identifier of the first update to return; `last update_id + 1`. */
  offset?: number
  timeoutSeconds?: number
  limit?: number
  allowedUpdates?: string[]
  signal?: AbortSignal
  attempts?: number
}

/**
 * Telegram accepts both an integer id and a `@channel` string as `chat_id`.
 * Source Channels store ids as strings; send them as numbers when they are
 * numeric, which is what the Bot API documents and what fake servers expect.
 */
export function normalizeChatId(chatId: string | number): string | number {
  if (typeof chatId === 'number') return chatId
  const trimmed = chatId.trim()
  if (!/^-?\d+$/.test(trimmed)) return chatId
  const numeric = Number(trimmed)
  return Number.isSafeInteger(numeric) ? numeric : chatId
}

export interface SendMessageOptions {
  chatId: string | number
  text: string
  markdown?: 'plain' | 'telegram' | 'github'
  /** Render Markdown as Telegram HTML (default true when markdown is telegram). */
  rich?: boolean
  replyToMessageId?: number
  messageThreadId?: number
  /** Telegram inline keyboard markup, serialized as `reply_markup`. */
  replyMarkup?: unknown
  disableNotification?: boolean
  disableWebPagePreview?: boolean
  signal?: AbortSignal
  attempts?: number
}

export interface SendFileOptions {
  chatId: string | number
  /** Absolute local path of the file to upload. */
  path: string
  name?: string
  caption?: string
  mime?: string
  replyToMessageId?: number
  messageThreadId?: number
  replyMarkup?: unknown
  signal?: AbortSignal
  attempts?: number
}

// ---------------------------------------------------------------------------
// Stateless token validation (setup wizard; no ctx, no logging)
// ---------------------------------------------------------------------------

/** A token check failed. The message never contains the token. */
export class TelegramTokenValidationError extends Error {
  /** Telegram `error_code` when the Bot API answered; `0` for transport errors. */
  readonly code?: number

  constructor(message: string, code?: number) {
    super(message)
    this.name = 'TelegramTokenValidationError'
    if (code !== undefined) this.code = code
  }
}

export interface ValidateTelegramTokenOptions {
  /** Bot API base URL; only changed in tests. */
  apiBaseUrl?: string
  /** Per-request timeout in milliseconds (default 10s). */
  timeoutMs?: number
}

/**
 * Call `getMe` once to prove a bot token works, without touching any Source
 * instance, configuration or state. Stateless and safe to call from the setup
 * API via a dynamic `import()`.
 *
 * Throws {@link TelegramTokenValidationError} with a readable description on
 * any failure (the token is never included in the message).
 */
export async function validateTelegramToken(
  token: string,
  options: ValidateTelegramTokenOptions = {},
): Promise<{ ok: true; id: number; username: string }> {
  const trimmed = token.trim()
  if (!trimmed) throw new TelegramTokenValidationError('Telegram token is empty')
  const api = new TelegramApi({
    token: trimmed,
    ...(options.apiBaseUrl ? { baseUrl: options.apiBaseUrl } : {}),
    maxAttempts: 2,
    baseDelayMs: 250,
    // A setup check must stay fast: never wait minutes for a 429 retry_after.
    maxDelayMs: 2_000,
    timeoutMs: 10_000,
  })
  try {
    const user = await api.call<TelegramUser>('getMe', {}, {
      attempts: 2,
      timeoutMs: Math.max(100, options.timeoutMs ?? 10_000),
    })
    if (!user || typeof user.id !== 'number') {
      throw new TelegramTokenValidationError('Telegram returned an unexpected getMe answer')
    }
    return { ok: true, id: user.id, username: user.username ?? '' }
  } catch (error) {
    if (error instanceof TelegramTokenValidationError) throw error
    if (error instanceof TelegramApiError) {
      throw new TelegramTokenValidationError(
        `Telegram token check failed: ${error.description} (Telegram error ${error.code})`,
        error.code,
      )
    }
    throw new TelegramTokenValidationError(`Telegram token check failed: ${describeError(error)}`)
  }
}
