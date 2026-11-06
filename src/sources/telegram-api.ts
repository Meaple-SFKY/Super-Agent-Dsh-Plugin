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

import { readFile } from 'node:fs/promises'

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
 * Render one already-split chunk. `telegram` means "basic Markdown people
 * actually type in a chat", converted to safe HTML; `plain`/`github` are sent
 * verbatim without a parse mode so no entity can ever fail to parse.
 */
export function renderTelegramChunk(
  text: string,
  markdown?: 'plain' | 'telegram' | 'github',
): { text: string; parseMode?: 'HTML' } {
  if (markdown !== 'telegram') return { text }
  let html = escapeTelegramHtml(text)
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  html = html.replace(/(^|[^`])`([^`\n]+)`/g, '$1<code>$2</code>')
  return { text: html, parseMode: 'HTML' }
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
    const chunks = chunkText(options.text ?? '')
    let last: TelegramMessage | undefined
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!
      const rendered = renderTelegramChunk(chunk, options.markdown)
      const params: Record<string, unknown> = {
        chat_id: normalizeChatId(options.chatId),
        text: rendered.text,
        disable_notification: options.disableNotification ?? false,
      }
      if (rendered.parseMode) params.parse_mode = rendered.parseMode
      if (options.disableWebPagePreview !== undefined) {
        params.disable_web_page_preview = options.disableWebPagePreview
      }
      if (index === 0 && options.replyToMessageId !== undefined) {
        params.reply_to_message_id = options.replyToMessageId
        // The original message may be gone after a restart; do not fail the send.
        params.allow_sending_without_reply = true
      }
      last = await this.call<TelegramMessage>('sendMessage', params, {
        signal: options.signal,
        attempts: options.attempts,
      })
    }
    return last
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
  replyToMessageId?: number
  disableNotification?: boolean
  disableWebPagePreview?: boolean
  signal?: AbortSignal
  attempts?: number
}
