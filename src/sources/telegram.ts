/**
 * Telegram Source.
 *
 * One Bot API long-polling loop per configured bot. The loop owns its offset
 * in `ctx.kv`, filters by the configured user/chat allowlist, translates
 * messages into Triggers and handles the local slash commands without spending
 * a model call.
 *
 * Identity mapping:
 * - private message from user `<id>` -> Thread `telegram:dm:<id>`, addressed
 *   `direct`;
 * - message in a configured group chat -> Thread `telegram:chat:<chatId>`,
 *   addressed `mention` when the bot is addressed (an `@username` mention, a
 *   reply to the bot, or a `/command@bot`), otherwise `none` and only admitted
 *   when `observeAllChatMessages` is on;
 * - Trigger/Channel ids are derived from the native message, so replaying a
 *   long-poll window is idempotent.
 *
 * Failure isolation: the token is read lazily, failures become health entries,
 * and `start()` returns immediately while a background loop (started by the
 * caller) is fully guarded. `stop()` aborts the in-flight long poll.
 */

import type {
  ChannelAddress,
  IsoTime,
  OutboundMessage,
  ReceiveDisposition,
  SendOutcome,
  ThreadRef,
  Trigger,
} from '../core/model.js'
import { lstat, realpath } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'

import type { Source, SourceContext, SourceHealthState, SourceKind } from './kind.js'
import { makeTrigger } from './kind.js'
import {
  TelegramApi,
  TelegramApiError,
  TelegramTokenError,
  abortError,
  createTokenProvider,
  isAbortError,
  sleepWithSignal,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser,
} from './telegram-api.js'

/** Stable Source id; also the prefix of Thread keys and the Channel source. */
export const TELEGRAM_SOURCE = 'telegram'
const OFFSET_KEY = 'telegram:offset'
const DEFAULT_ENV = 'SUPERAGENT_TELEGRAM_TOKEN'
/** Persistent crash-replay guard for local commands and inline buttons. */
const ACTION_DEDUPE_KEY = 'telegram:seen-actions'
const ACTION_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const ACTION_DEDUPE_MAX = 500
const COMMAND_UNAVAILABLE = '命令处理暂不可用（runtime 尚未接线）。'
const HELP_TEXT = [
  '/status — 运行状态与待处理',
  '/tickets — 活跃与需关注的 Ticket',
  '/pause — 暂停接单',
  '/resume — 恢复接单',
  '/stop <ticketId> — 停止一个 Ticket',
  '/retry <ticketId> — 重试一个 Ticket',
  '/help — 显示这条帮助',
].join('\n')

/** Commands registered with the Bot API (`setMyCommands`) at start-up. */
const BOT_COMMANDS = [
  { command: 'status', description: '运行状态' },
  { command: 'pause', description: '暂停接单' },
  { command: 'resume', description: '恢复接单' },
  { command: 'tickets', description: '查看 Ticket' },
  { command: 'stop', description: '停止 Ticket' },
  { command: 'retry', description: '重试 Ticket' },
  { command: 'help', description: '帮助' },
]

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration of one Telegram Source. Only `tokenEnv`/`tokenFile` (or the
 * default environment variable) are required; everything else has a safe
 * default so a half-configured Source reads nothing and reports health.
 */
export interface TelegramConfig {
  enabled?: boolean
  /** Environment variable holding the bot token. */
  tokenEnv?: string
  /** File containing the bot token; wins over `tokenEnv`. */
  tokenFile?: string
  /** Telegram user ids allowed to talk to the bot (accepts numbers too). */
  allowedUserIds?: Array<string | number>
  /** Group/supergroup chat ids the bot may listen to (accepts numbers too). */
  chats?: Array<string | number>
  /** Bot API base URL; only changed in tests. */
  apiBaseUrl?: string
  /** `getUpdates` long-poll timeout in seconds (0 makes it a plain poll). */
  pollTimeoutSeconds?: number
  /** Idle gap in seconds after an empty poll. */
  pollSeconds?: number
  /** Translate button presses into `callback` Triggers. Default false. */
  observeCallbacks?: boolean
  /** Admit unaddressed group messages (addressed `none`). Default false. */
  observeAllChatMessages?: boolean
  /** Reply under the message that caused a Trigger. Default false. */
  replyToMessages?: boolean
  /** Extra literal `@name` considered an address of the bot. */
  mentionPattern?: string
  /**
   * On the first start, drain up to 24h of Bot API backlog instead of only the
   * latest pending update. Default false: a fresh install must not turn old
   * chat history into Tickets.
   */
  processBacklog?: boolean
  /** Render `markdown: 'telegram'` messages as Telegram HTML. Default true. */
  richText?: boolean
  /**
   * Allow sending outgoing attachments and downloading incoming media.
   * Default true; false keeps the Source text-only (captions still arrive).
   */
  files?: boolean
  /**
   * Attach inline keyboards to attention/result messages and handle their
   * `sa:` button callbacks. Default true.
   */
  keyboards?: boolean
  /** Refuse to download media larger than this many bytes (default 20 MB). */
  maxDownloadBytes?: number
  /** Commands handler injected by the runtime (see {@link TelegramCommands}). */
  commands?: TelegramCommands
}

interface NormalizedTelegramConfig {
  tokenEnv?: string
  tokenFile?: string
  allowedUserIds: string[]
  chats: string[]
  apiBaseUrl?: string
  pollTimeoutSeconds: number
  pollSeconds: number
  observeCallbacks: boolean
  observeAllChatMessages: boolean
  replyToMessages: boolean
  processBacklog: boolean
  richText: boolean
  files: boolean
  keyboards: boolean
  maxDownloadBytes: number
  mentionPattern?: string
  commands?: TelegramCommands
}

function idList(values: Array<string | number> | undefined): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  for (const value of values) {
    const id = String(value).trim()
    if (id) seen.add(id)
  }
  return [...seen]
}

/** Apply defaults and coerce ids to strings. */
export function normalizeTelegramConfig(config: TelegramConfig = {}): NormalizedTelegramConfig {
  return {
    ...(config.tokenEnv?.trim() ? { tokenEnv: config.tokenEnv.trim() } : {}),
    ...(config.tokenFile?.trim() ? { tokenFile: config.tokenFile.trim() } : {}),
    allowedUserIds: idList(config.allowedUserIds),
    chats: idList(config.chats),
    ...(config.apiBaseUrl?.trim() ? { apiBaseUrl: config.apiBaseUrl.trim().replace(/\/+$/, '') } : {}),
    pollTimeoutSeconds: clampNumber(config.pollTimeoutSeconds ?? 25, 0, 300),
    pollSeconds: clampNumber(config.pollSeconds ?? 1, 0.01, 300),
    observeCallbacks: config.observeCallbacks === true,
    observeAllChatMessages: config.observeAllChatMessages === true,
    replyToMessages: config.replyToMessages === true,
    processBacklog: config.processBacklog === true,
    richText: config.richText !== false,
    files: config.files !== false,
    keyboards: config.keyboards !== false,
    maxDownloadBytes: clampNumber(config.maxDownloadBytes ?? 20 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    ...(config.mentionPattern?.trim() ? { mentionPattern: config.mentionPattern.trim() } : {}),
    ...(config.commands ? { commands: config.commands } : {}),
  }
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

// ---------------------------------------------------------------------------
// Local command handling (implemented by the runtime, not the model)
// ---------------------------------------------------------------------------

/**
 * Slash commands handled locally by the Telegram Source. The runtime
 * implements this against EngineForPeople / Runtime and returns the short
 * reply text; the Source sends that text straight back to the chat (no Router
 * Session, no model call).
 */
export interface TelegramCommands {
  status(): Promise<string>
  pause(): Promise<string>
  resume(): Promise<string>
  tickets(): Promise<string>
  stopTicket(ticketId: string): Promise<string>
  retryTicket(ticketId: string): Promise<string>
  /** Optional: acknowledge a ticket from an inline `✅` button (toast only). */
  ack?(ticketId: string): Promise<string> | string | void
}

/**
 * Late-wiring fallback for the command handler, for embedders that create the
 * Source before they can build the handler. `config.commands` wins when set.
 */
let fallbackCommands: TelegramCommands | undefined

export function setTelegramCommands(commands: TelegramCommands | undefined): void {
  fallbackCommands = commands
}

// ---------------------------------------------------------------------------
// Update translation helpers (exported for tests and reuse)
// ---------------------------------------------------------------------------

export type ParsedCommandName = 'status' | 'pause' | 'resume' | 'stop' | 'retry' | 'tickets' | 'help'
const COMMAND_NAMES: readonly ParsedCommandName[] = ['status', 'pause', 'resume', 'stop', 'retry', 'tickets', 'help']

export interface ParsedTelegramCommand {
  name: ParsedCommandName
  /** The `@bot` target of `/status@bot`, lowercased without the `@`. */
  target?: string
  /** Everything after the command, trimmed. */
  argument?: string
}

/**
 * Parse `/status`, `/stop@bot t_1` and friends. Returns `undefined` for text
 * that is not a slash command or whose command name is not known.
 */
export function parseTelegramCommand(text: string): ParsedTelegramCommand | undefined {
  const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return undefined
  const name = match[1]!.toLowerCase() as ParsedCommandName
  if (!COMMAND_NAMES.includes(name)) return undefined
  const target = match[2]?.toLowerCase()
  const argument = match[3]?.trim()
  return {
    name,
    ...(target ? { target } : {}),
    ...(argument ? { argument } : {}),
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mentionsBot(message: TelegramMessage, bot: TelegramUser | undefined, pattern?: string): boolean {
  const text = message.text ?? message.caption ?? ''
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])]
  for (const entity of entities) {
    if (entity.type === 'text_mention' && entity.user && bot && entity.user.id === bot.id) return true
  }
  const names = new Set<string>()
  if (bot?.username) names.add(bot.username.toLowerCase())
  if (pattern) names.add(pattern.replace(/^@/, '').toLowerCase())
  for (const name of names) {
    if (!name) continue
    if (new RegExp(`(^|[^\\w])@${escapeRegExp(name)}(?![\\w])`, 'i').test(text)) return true
  }
  return false
}

function repliesToBot(message: TelegramMessage, bot: TelegramUser | undefined): boolean {
  return Boolean(bot && message.reply_to_message?.from?.id === bot.id)
}

function displayName(user: TelegramUser | undefined): string | undefined {
  if (!user) return undefined
  if (user.username) return `@${user.username}`
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  return name || undefined
}

function chatLabel(chat: TelegramMessage['chat']): string {
  if (chat.type === 'private') return `DM ${chat.id}`
  return chat.title ?? `chat ${chat.id}`
}

// ---------------------------------------------------------------------------
// Source implementation
// ---------------------------------------------------------------------------

type Handled = 'received' | 'command' | 'filtered' | 'ignored' | 'failed'

interface MediaItem {
  kind: 'photo' | 'document' | 'voice' | 'audio' | 'video'
  fileId: string
  size?: number
  name?: string
  mime?: string
}

interface MediaAttachment {
  kind: string
  path: string
  name: string
  mime?: string
  size: number
}

/** Keep only basename-safe characters; the download path is built from it. */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return (cleaned || 'file').slice(0, 80)
}

/** Topic (forum thread) id encoded in a group Thread key, if any. */
function threadIdOf(thread: string | undefined): number | undefined {
  const match = /:topic:(\d+)$/.exec(thread ?? '')
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : undefined
}

export interface TelegramPollResult {
  updates: number
  received: number
  commands: number
  filtered: number
}

export class TelegramSource implements Source {
  readonly id: string = TELEGRAM_SOURCE
  readonly kind: string = TELEGRAM_SOURCE

  private readonly ctx: SourceContext
  private readonly config: NormalizedTelegramConfig
  private api: TelegramApi | undefined
  private bot: TelegramUser | undefined
  private controller: AbortController | undefined
  private loopPromise: Promise<void> | undefined
  private lastHealth: SourceHealthState = 'off'
  /** `setMyCommands` is registered once per process, on the first poll. */
  private commandsRegistered = false

  constructor(config: TelegramConfig, ctx: SourceContext) {
    this.ctx = ctx
    this.config = normalizeTelegramConfig(config)
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.controller) return
    this.controller = new AbortController()
    this.report('starting', 'starting Telegram long polling')
    const signal = this.controller.signal
    // `start()` must resolve promptly; the loop is a floating promise that
    // catches every failure itself (an unhandled rejection would kill DSH).
    this.loopPromise = this.runLoop(signal).catch((error: unknown) => {
      if (!signal.aborted) this.report('error', `polling loop stopped: ${describeError(error)}`)
    })
  }

  async stop(): Promise<void> {
    this.controller?.abort()
    try {
      await this.loopPromise
    } catch {
      // The loop already reports its own failures.
    }
    this.controller = undefined
    this.loopPromise = undefined
    this.report('off', 'stopped')
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let failures = 0
    let delay = 1000
    while (!signal.aborted) {
      try {
        const result = await this.pollOnce(signal)
        failures = 0
        delay = 1000
        if (signal.aborted) break
        this.report(
          'ready',
          `${result.updates} update(s): ${result.received} trigger(s), ${result.commands} command(s), ${result.filtered} filtered`,
        )
        // Long polling already waited while idle; with fresh updates continue at once.
        if (result.updates === 0) await this.sleep(this.config.pollSeconds * 1000, signal)
      } catch (error) {
        if (signal.aborted) break
        failures += 1
        const detail = describeError(error)
        if (failures >= 3) this.report('error', `poll failed ${failures} times: ${detail}`)
        else this.report('starting', `poll retrying (${failures}): ${detail}`)
        await this.sleep(delay, signal).catch(() => undefined)
        delay = Math.min(delay * 2, 60_000)
      }
    }
    if (signal.aborted) this.report('off', 'stopped')
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return sleepWithSignal(ms, signal)
  }

  private report(state: SourceHealthState, detail: string): void {
    this.lastHealth = state
    try {
      this.ctx.health({ name: TELEGRAM_SOURCE, state, detail, at: this.ctx.now() })
    } catch {
      // Health reporting must never take the loop down.
    }
  }

  /** Last reported health state, for tests and diagnostics. */
  healthState(): SourceHealthState {
    return this.lastHealth
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  private getApi(): TelegramApi {
    if (!this.api) {
      this.api = new TelegramApi({
        token: createTokenProvider({
          ...(this.config.tokenEnv ? { tokenEnv: this.config.tokenEnv } : {}),
          ...(this.config.tokenFile ? { tokenFile: this.config.tokenFile } : {}),
          defaultEnv: DEFAULT_ENV,
        }),
        ...(this.config.apiBaseUrl ? { baseUrl: this.config.apiBaseUrl } : {}),
      })
    }
    return this.api
  }

  private readOffset(): number {
    const value = this.ctx.kv.get<number>(OFFSET_KEY)
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  }

  private writeOffset(offset: number): void {
    if (offset <= this.readOffset()) return
    this.ctx.kv.set(OFFSET_KEY, offset)
  }

  /**
   * One long-poll round. Exposed so tests (and a future health probe) can drive
   * exactly one round without the background loop.
   */
  async pollOnce(signal: AbortSignal): Promise<TelegramPollResult> {
    const api = this.getApi()
    if (!this.bot) this.bot = await api.getMe(signal)
    if (!this.commandsRegistered) {
      this.commandsRegistered = true
      try {
        await api.setMyCommands(BOT_COMMANDS, signal)
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error
        this.ctx.logger.warn('telegram: setMyCommands failed', { error: describeError(error) })
      }
    }
    // Fresh install: only the latest pending update is read (`offset = -1`),
    // so up to 24h of Bot API backlog never becomes a burst of Tickets.
    const storedOffset = this.ctx.kv.get<number>(OFFSET_KEY)
    const firstRun = typeof storedOffset !== 'number'
    const probe = firstRun && !this.config.processBacklog
    const offset = this.readOffset()
    const updates = await api.getUpdates({
      ...(probe ? { offset: -1 } : offset > 0 ? { offset } : {}),
      timeoutSeconds: probe ? 0 : this.config.pollTimeoutSeconds,
      signal,
    })
    if (probe && updates.length === 0) {
      // Mark the source initialized so the next round is a normal long poll.
      this.ctx.kv.set(OFFSET_KEY, 0)
    }
    let received = 0
    let commands = 0
    let filtered = 0
    for (const update of updates) {
      if (signal.aborted) throw abortError()
      let outcome: Handled
      try {
        outcome = await this.handleUpdate(update, api, signal)
      } catch (error) {
        // Failures outside storage (a command reply that could not be sent) are
        // poison messages: log and move on so they cannot wedge the loop.
        if (signal.aborted || isAbortError(error)) throw error
        this.ctx.logger.warn('telegram: update handling failed', {
          updateId: update.update_id,
          error: describeError(error),
        })
        filtered += 1
        this.writeOffset(update.update_id + 1)
        continue
      }
      if (outcome === 'failed') {
        // The Engine could not store the Trigger. Do NOT advance the offset, so
        // the next round reads and retries this exact update; already stored
        // updates stay deduplicated. Throwing hands control to the loop's
        // backoff/health path instead of silently dropping the event.
        if (probe) {
          // No cursor exists yet (first-run probe reads only the newest update).
          // Persist this update's id: `offset` is inclusive, so the retry reads
          // it again instead of skipping to whatever is newest by then.
          this.ctx.kv.set(OFFSET_KEY, update.update_id)
        }
        throw new Error(
          `telegram: update ${update.update_id} was not stored by the Engine; retrying on the next poll`,
        )
      }
      if (outcome === 'received') received += 1
      else if (outcome === 'command') commands += 1
      else if (outcome === 'filtered') filtered += 1
      this.writeOffset(update.update_id + 1)
    }
    return { updates: updates.length, received, commands, filtered }
  }

  private async handleUpdate(update: TelegramUpdate, api: TelegramApi, signal: AbortSignal): Promise<Handled> {
    const message = update.message
    if (!message) {
      // Edits and channel posts are intentionally ignored; button presses are
      // handled here (inline keyboard actions never become Triggers).
      const callback = update.callback_query
      if (callback) return this.handleCallback(callback, api, signal)
      return 'ignored'
    }
    const from = message.from
    if (!from || from.is_bot) return 'ignored'
    if (this.bot && from.id === this.bot.id) return 'ignored'
    const userId = String(from.id)
    if (!this.isAllowedUser(userId)) return 'filtered'
    const chatId = String(message.chat.id)
    const isPrivate = message.chat.type === 'private'
    if (!isPrivate && !this.isAllowedChat(chatId)) return 'filtered'

    const text = (message.text ?? message.caption ?? '').trim()
    const media = this.mediaOf(message)
    const addressed = this.isAddressed(message, text, isPrivate)
    if (!isPrivate && !addressed && !this.config.observeAllChatMessages) return 'filtered'

    const command = parseTelegramCommand(text)
    if (command) {
      // A command addressed to another bot in a group is not for us.
      if (!isPrivate && !addressed) return 'filtered'
      if (command.target && this.bot?.username && command.target !== this.bot.username.toLowerCase()) {
        return 'filtered'
      }
      // Persist the update id before running side effects: a crash between the
      // command and the offset write must not execute /stop or /retry twice.
      if (!this.actionAlreadyDone('command', update.update_id)) {
        this.rememberAction('command', update.update_id)
        await this.runCommand(command, message, isPrivate)
      }
      return 'command'
    }
    // Unknown slash commands are not conversation: ignore them instead of
    // turning a typo into a Ticket.
    if (text.startsWith('/')) return 'filtered'
    if (!text && (media.length === 0 || !this.config.files)) return 'ignored'
    // Media is downloaded before the Trigger is offered, so the Engine and its
    // worker can read the files from disk. A failed download never drops text.
    // `files: false` keeps the Source text-only (caption/message still arrives).
    const attachments =
      this.config.files && media.length > 0 ? await this.downloadMedia(message, media, api, signal) : []
    if (!this.config.files && media.length > 0) {
      this.ctx.logger.debug('telegram: files disabled; incoming media is not downloaded', {
        chatId,
        messageId: message.message_id,
      })
    }
    return this.offer(this.buildMessageTrigger(message, attachments))
  }

  /**
   * Offer a Trigger to the Engine. `failed` means the store write did not
   * happen and the caller must keep its read position; exceptions from a
   * misbehaving Engine are treated the same way, never swallowed as filtered.
   */
  private offer(trigger: Trigger): 'received' | 'failed' {
    let outcome: ReceiveDisposition
    try {
      outcome = this.ctx.receive(trigger)
    } catch (error) {
      this.ctx.logger.warn('telegram: receive threw; will retry', {
        triggerId: trigger.id,
        error: describeError(error),
      })
      return 'failed'
    }
    if (outcome === 'failed') {
      this.ctx.logger.warn('telegram: receive failed; will retry', { triggerId: trigger.id })
      return 'failed'
    }
    return 'received'
  }

  private buildMessageTrigger(message: TelegramMessage, attachments: MediaAttachment[] = []): Trigger {
    const from = message.from!
    const userId = String(from.id)
    const chatId = String(message.chat.id)
    const isPrivate = message.chat.type === 'private'
    const text = (message.text ?? message.caption ?? '').trim()
    const topicId = message.is_topic_message === true && typeof message.message_thread_id === 'number'
      ? message.message_thread_id
      : undefined
    const thread: ThreadRef = isPrivate
      ? { key: `telegram:dm:${userId}`, source: TELEGRAM_SOURCE, label: `DM ${displayName(from) ?? userId}` }
      : {
          key: topicId !== undefined ? `telegram:chat:${chatId}:topic:${topicId}` : `telegram:chat:${chatId}`,
          source: TELEGRAM_SOURCE,
          label: `${message.chat.title ?? `chat ${chatId}`}${topicId !== undefined ? ` · topic ${topicId}` : ''}`,
        }
    const addressed = this.isAddressed(message, text, isPrivate) ? (isPrivate ? 'direct' : 'mention') : 'none'
    return makeTrigger(`telegram:msg:${chatId}:${message.message_id}`, TELEGRAM_SOURCE, {
      kind: 'message',
      at: messageAt(message, this.ctx.now()),
      thread,
      actor: {
        id: userId,
        ...(displayName(from) ? { name: displayName(from)! } : {}),
        bot: from.is_bot === true,
      },
      addressed,
      text,
      channel: this.channelFor(thread, message),
      meta: {
        chatId,
        chatType: message.chat.type,
        messageId: message.message_id,
        userId,
        ...(from.username ? { username: from.username } : {}),
        date: message.date,
        ...(topicId !== undefined ? { messageThreadId: topicId } : {}),
        ...(message.reply_to_message ? { replyToMessageId: message.reply_to_message.message_id } : {}),
        ...(isPrivate ? {} : { chatTitle: chatLabel(message.chat) }),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    })
  }

  private async handleCallback(
    callback: TelegramCallbackQuery,
    api: TelegramApi,
    signal: AbortSignal,
  ): Promise<Handled> {
    const userId = String(callback.from.id)
    if (!this.isAllowedUser(userId)) return 'filtered'
    if (this.bot && callback.from.id === this.bot.id) return 'ignored'
    const message = callback.message
    const chatId = String(message?.chat.id ?? callback.from.id)
    const isPrivate = !message || message.chat.type === 'private'
    if (!isPrivate && !this.isAllowedChat(chatId)) return 'filtered'
    // Inline-keyboard actions (`sa:<action>:<ticketId>`) are handled locally:
    // they call TelegramCommands and never become Triggers/Evals. With
    // `keyboards: false` they are ignored entirely.
    if (callback.data?.startsWith('sa:')) {
      if (!this.config.keyboards) return 'ignored'
      // Button callbacks are at-least-once across crashes: remember the click
      // before running its side effect.
      if (this.actionAlreadyDone('callback', callback.id)) return 'command'
      this.rememberAction('callback', callback.id)
      return this.handleInlineAction(callback, api, signal)
    }
    if (!callback.data || !this.config.observeCallbacks) return 'ignored'
    try {
      // Best effort: without an answer the client keeps a spinner.
      await api.answerCallbackQuery({ callbackQueryId: callback.id, text: '' }, signal)
    } catch (error) {
      if (isAbortError(error) && signal.aborted) throw error
      this.ctx.logger.debug('telegram: answerCallbackQuery failed', { error: describeError(error) })
    }
    const thread: ThreadRef = isPrivate
      ? { key: `telegram:dm:${userId}`, source: TELEGRAM_SOURCE, label: `DM ${displayName(callback.from) ?? userId}` }
      : { key: `telegram:chat:${chatId}`, source: TELEGRAM_SOURCE, label: message?.chat.title ?? `chat ${chatId}` }
    const trigger = makeTrigger(`telegram:callback:${callback.id}`, TELEGRAM_SOURCE, {
      kind: 'callback',
      at: message ? messageAt(message, this.ctx.now()) : this.ctx.now(),
      thread,
      actor: {
        id: userId,
        ...(displayName(callback.from) ? { name: displayName(callback.from)! } : {}),
        bot: callback.from.is_bot === true,
      },
      addressed: 'direct',
      text: callback.data,
      channel: this.channelFor(thread, message),
      meta: {
        chatId,
        callbackQueryId: callback.id,
        ...(message ? { messageId: message.message_id } : {}),
        userId,
      },
    })
    return this.offer(trigger)
  }

  /** `sa:ack|retry|stop:<ticketId>` from an inline keyboard button. */
  private async handleInlineAction(
    callback: TelegramCallbackQuery,
    api: TelegramApi,
    signal: AbortSignal,
  ): Promise<Handled> {
    const match = /^sa:(ack|retry|stop):([A-Za-z0-9_-]+)$/.exec(callback.data ?? '')
    if (!match) return 'ignored'
    const action = match[1] as 'ack' | 'retry' | 'stop'
    const ticketId = match[2]!
    const handler = this.config.commands ?? fallbackCommands
    let toast = '已处理'
    try {
      if (!handler) {
        toast = COMMAND_UNAVAILABLE
      } else if (action === 'ack') {
        const text = await handler.ack?.(ticketId)
        toast = typeof text === 'string' && text.trim() ? text.trim() : '已处理'
      } else if (action === 'retry') {
        toast = (await handler.retryTicket(ticketId)).trim() || '已重试'
      } else {
        toast = (await handler.stopTicket(ticketId)).trim() || '已停止'
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error
      this.ctx.logger.warn('telegram: inline action failed', { action, ticketId, error: describeError(error) })
      toast = '操作失败，请稍后重试'
    }
    try {
      await api.answerCallbackQuery({ callbackQueryId: callback.id, text: toast.slice(0, 180) }, signal)
    } catch (error) {
      if (isAbortError(error) && signal.aborted) throw error
      this.ctx.logger.debug('telegram: answerCallbackQuery failed', { error: describeError(error) })
    }
    const message = callback.message
    if (message) {
      try {
        // The button did its job; remove the keyboard so it cannot be pressed twice.
        await api.editMessageReplyMarkup(
          { chatId: String(message.chat.id), messageId: message.message_id, replyMarkup: { inline_keyboard: [] } },
          signal,
        )
      } catch (error) {
        if (isAbortError(error) && signal.aborted) throw error
        this.ctx.logger.debug('telegram: editMessageReplyMarkup failed', { error: describeError(error) })
      }
    }
    return 'command'
  }

  // -------------------------------------------------------------------------
  // Media (incoming photo / document / voice / audio / video)
  // -------------------------------------------------------------------------

  /** Largest photo, document, voice, audio and video of one message. */
  private mediaOf(message: TelegramMessage): MediaItem[] {
    const media: MediaItem[] = []
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const largest = [...message.photo].sort((left, right) => right.width * right.height - left.width * left.height)[0]!
      media.push({
        kind: 'photo',
        fileId: largest.file_id,
        ...(largest.file_size !== undefined ? { size: largest.file_size } : {}),
        name: 'photo.jpg',
        mime: 'image/jpeg',
      })
    }
    if (message.document) {
      media.push({
        kind: 'document',
        fileId: message.document.file_id,
        ...(message.document.file_size !== undefined ? { size: message.document.file_size } : {}),
        ...(message.document.file_name ? { name: message.document.file_name } : {}),
        ...(message.document.mime_type ? { mime: message.document.mime_type } : {}),
      })
    }
    for (const [kind, item] of [
      ['voice', message.voice],
      ['audio', message.audio],
      ['video', message.video],
    ] as const) {
      if (!item) continue
      media.push({
        kind,
        fileId: item.file_id,
        ...(item.file_size !== undefined ? { size: item.file_size } : {}),
        ...(item.file_name ? { name: item.file_name } : {}),
        ...(item.mime_type ? { mime: item.mime_type } : {}),
      })
    }
    return media
  }

  /**
   * Download media into `<stateDir>/downloads/`. Each file is size-checked,
   * written 0600 in a 0700 directory, and a failure is only logged: the
   * Trigger (caption text) is still delivered.
   */
  private async downloadMedia(
    message: TelegramMessage,
    media: MediaItem[],
    api: TelegramApi,
    signal: AbortSignal,
  ): Promise<MediaAttachment[]> {
    const attachments: MediaAttachment[] = []
    for (const item of media) {
      if (signal.aborted) throw abortError()
      if (item.size !== undefined && item.size > this.config.maxDownloadBytes) {
        this.ctx.logger.warn('telegram: media exceeds maxDownloadBytes; skipped', {
          kind: item.kind,
          size: item.size,
          limit: this.config.maxDownloadBytes,
        })
        continue
      }
      try {
        const file = await api.getFile(item.fileId, signal)
        if (!file.file_path) {
          this.ctx.logger.warn('telegram: getFile returned no file_path', { kind: item.kind })
          continue
        }
        const fallbackName = file.file_path.split('/').pop() ?? `${item.kind}-${message.message_id}`
        const name = safeFileName(item.name ?? fallbackName)
        // chatId prefix: message ids are only unique inside one chat, so this
        // prevents one chat's download from overwriting another's.
        const destination = join(
          this.ctx.stateDir,
          'downloads',
          `${String(message.chat.id)}-${message.message_id}-${name}`,
        )
        const downloaded = await api.downloadFile(file.file_path, destination, {
          maxBytes: this.config.maxDownloadBytes,
          signal,
        })
        attachments.push({
          kind: item.kind,
          path: destination,
          name,
          ...(item.mime ? { mime: item.mime } : {}),
          size: downloaded.bytes,
        })
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error
        this.ctx.logger.warn('telegram: media download failed', {
          kind: item.kind,
          error: describeError(error),
        })
      }
    }
    return attachments
  }

  // -------------------------------------------------------------------------
  // Command execution
  // -------------------------------------------------------------------------

  private async runCommand(
    command: ParsedTelegramCommand,
    message: TelegramMessage,
    isPrivate: boolean,
  ): Promise<void> {
    const handler = this.config.commands ?? fallbackCommands
    const reply = async (text: string): Promise<void> => {
      await this.getApi().sendMessage({
        chatId: String(message.chat.id),
        text,
        markdown: 'plain',
        ...(this.config.replyToMessages ? { replyToMessageId: message.message_id } : {}),
      })
    }
    if (command.name === 'help') {
      await reply(HELP_TEXT)
      return
    }
    if (!handler) {
      await reply(COMMAND_UNAVAILABLE)
      return
    }
    let text: string
    switch (command.name) {
      case 'status':
        text = await handler.status()
        break
      case 'pause':
        text = await handler.pause()
        break
      case 'resume':
        text = await handler.resume()
        break
      case 'tickets':
        text = await handler.tickets()
        break
      case 'stop':
        text = command.argument ? await handler.stopTicket(command.argument) : '用法：/stop <ticketId>'
        break
      case 'retry':
        text = command.argument ? await handler.retryTicket(command.argument) : '用法：/retry <ticketId>'
        break
      default:
        text = HELP_TEXT
    }
    await reply(text.trim() || '（无内容）')
  }

  // -------------------------------------------------------------------------
  // Addressing and allowlists
  // -------------------------------------------------------------------------

  private isAllowedUser(userId: string): boolean {
    return this.config.allowedUserIds.includes(userId)
  }

  private isAllowedChat(chatId: string): boolean {
    return this.config.allowedUserIds.includes(chatId) || this.config.chats.includes(chatId)
  }

  private isAddressed(message: TelegramMessage, text: string, isPrivate: boolean): boolean {
    if (isPrivate) return true
    if (mentionsBot(message, this.bot, this.config.mentionPattern)) return true
    if (repliesToBot(message, this.bot)) return true
    const command = parseTelegramCommand(text)
    if (command?.target && command.target === this.bot?.username?.toLowerCase()) return true
    return false
  }

  private channelFor(thread: ThreadRef, message: TelegramMessage | undefined): ChannelAddress {
    return {
      source: TELEGRAM_SOURCE,
      thread: thread.key,
      to: message
        ? String(message.chat.id)
        : thread.key.replace(/^telegram:(?:dm|chat):/, '').replace(/:topic:\d+$/, ''),
      // Map the source message so outbound replies can thread under it.
      ...(message ? { replyTo: String(message.message_id) } : {}),
    }
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  async send(message: OutboundMessage): Promise<SendOutcome> {
    const chatId = message.channel.to
    if (!this.isAllowedChat(chatId)) return 'gone'
    const api = this.getApi()
    const replyTo = this.config.replyToMessages ? Number(message.channel.replyTo) : undefined
    const topicId = threadIdOf(message.channel.thread)
    const replyMarkup = this.keyboardFor(message)
    const text = message.text ?? ''
    let delivered = false
    let firstError: unknown
    if (text.trim()) {
      try {
        if (!this.bot) this.bot = await api.getMe(this.controller?.signal)
        await api.sendMessage({
          chatId,
          text,
          markdown: message.markdown ?? 'plain',
          rich: this.config.richText,
          ...(replyTo !== undefined && Number.isFinite(replyTo) ? { replyToMessageId: replyTo } : {}),
          ...(topicId !== undefined ? { messageThreadId: topicId } : {}),
          ...(replyMarkup !== undefined ? { replyMarkup } : {}),
          signal: this.controller?.signal,
        })
        delivered = true
      } catch (error) {
        firstError = error
        if (isPermanentTelegramError(error)) return 'gone'
      }
    }
    // Attachments are best effort: a failed upload never blocks the text, and
    // `files: false` skips them entirely (the text still goes out).
    const attachments = this.config.files ? (message.attachments ?? []) : []
    if (!this.config.files && (message.attachments?.length ?? 0) > 0) {
      this.ctx.logger.debug('telegram: files disabled; outgoing attachments are not sent', {
        count: message.attachments!.length,
      })
    }
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index]!
      const safePath = await this.allowedAttachmentPath(attachment.path)
      if (!safePath) {
        this.ctx.logger.warn('telegram: outgoing attachment rejected (outside state work/downloads or symlink)', {
          kind: attachment.kind,
          name: attachment.name ?? attachment.path,
        })
        continue
      }
      try {
        const options = {
          chatId,
          path: safePath,
          name: safeFileName(attachment.name ?? basename(safePath)),
          ...(attachment.caption ? { caption: attachment.caption } : {}),
          ...(attachment.mime ? { mime: attachment.mime } : {}),
          ...(topicId !== undefined ? { messageThreadId: topicId } : {}),
          ...(index === 0 && replyMarkup !== undefined ? { replyMarkup } : {}),
          signal: this.controller?.signal,
        }
        if (attachment.kind === 'photo') await api.sendPhoto(options)
        else await api.sendDocument(options)
        delivered = true
      } catch (error) {
        this.ctx.logger.warn('telegram: attachment send failed', {
          kind: attachment.kind,
          name: attachment.name ?? attachment.path,
          error: describeError(error),
        })
      }
    }
    if (delivered) return 'sent'
    if (attachments.length === 0 && !text.trim()) return 'sent'
    if (firstError) {
      if (firstError instanceof TelegramTokenError) throw firstError
      throw firstError
    }
    return 'failed'
  }

  /**
   * Outgoing attachments must be regular files inside the state work/ or
   * downloads/ trees after symlink resolution. Anything else is refused, so a
   * prompt-injected worker cannot exfiltrate arbitrary local files.
   */
  private async allowedAttachmentPath(path: string): Promise<string | undefined> {
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isFile()) return undefined
      const resolved = await realpath(path)
      // Resolve the allowed roots too: on macOS /tmp is a symlink to
      // /private/tmp, so a plain string prefix check would reject valid files.
      for (const candidate of [join(this.ctx.stateDir, 'work'), join(this.ctx.stateDir, 'downloads')]) {
        let root: string
        try {
          root = await realpath(candidate)
        } catch {
          continue
        }
        if (resolved === root || resolved.startsWith(`${root}${sep}`)) return resolved
      }
      return undefined
    } catch {
      return undefined
    }
  }

  // -----------------------------------------------------------------------
  // Crash-replay guard for local commands and inline buttons
  // -----------------------------------------------------------------------

  private actionDedupeState(): Record<string, number> {
    try {
      const stored = this.ctx.kv.get<Record<string, number>>(ACTION_DEDUPE_KEY)
      if (!stored || typeof stored !== 'object') return {}
      const state: Record<string, number> = {}
      for (const [key, value] of Object.entries(stored)) {
        if (typeof value === 'number' && Number.isFinite(value)) state[key] = value
      }
      return state
    } catch {
      return {}
    }
  }

  private actionAlreadyDone(kind: 'command' | 'callback', id: number | string): boolean {
    const key = `${kind}:${String(id)}`
    const state = this.actionDedupeState()
    const at = state[key]
    if (typeof at !== 'number') return false
    const now = this.nowMs()
    return now - at <= ACTION_DEDUPE_TTL_MS
  }

  private rememberAction(kind: 'command' | 'callback', id: number | string): void {
    try {
      const key = `${kind}:${String(id)}`
      const now = this.nowMs()
      const state = this.actionDedupeState()
      state[key] = now
      // Drop expired entries and keep the map bounded.
      const entries = Object.entries(state)
        .filter(([, at]) => now - at <= ACTION_DEDUPE_TTL_MS)
        .sort((left, right) => right[1] - left[1])
        .slice(0, ACTION_DEDUPE_MAX)
      this.ctx.kv.set(ACTION_DEDUPE_KEY, Object.fromEntries(entries))
    } catch (error) {
      this.ctx.logger.debug('telegram: could not persist action dedupe key', { error: describeError(error) })
    }
  }

  private nowMs(): number {
    const parsed = Date.parse(this.ctx.now())
    return Number.isFinite(parsed) ? parsed : Date.now()
  }

  /** Inline keyboard for messages that ask the owner to act on a Ticket. */
  private keyboardFor(message: OutboundMessage): unknown | undefined {
    if (!this.config.keyboards) return undefined
    if (!message.ticketId) return undefined
    if (message.purpose !== 'attention' && message.purpose !== 'result') return undefined
    const id = message.ticketId
    return {
      inline_keyboard: [
        [
          { text: '✅ 已处理', callback_data: `sa:ack:${id}` },
          { text: '🔁 重试', callback_data: `sa:retry:${id}` },
          { text: '⏹ 停止', callback_data: `sa:stop:${id}` },
        ],
      ],
    }
  }

  channelAllowed(channel: ChannelAddress): boolean {
    return channel.source === TELEGRAM_SOURCE && this.isAllowedChat(channel.to)
  }
}

function isPermanentTelegramError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) return false
  if (error.code === 403) return true
  return (
    error.code === 400 &&
    /chat not found|user is deactivated|PEER_ID_INVALID|bot was blocked/i.test(error.description)
  )
}

function messageAt(message: TelegramMessage, fallback: IsoTime): IsoTime {
  if (!Number.isFinite(message.date)) return fallback
  return new Date(message.date * 1000).toISOString()
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// ---------------------------------------------------------------------------
// Source kind
// ---------------------------------------------------------------------------

/** Build the Telegram Source for one configuration. */
export function createSource(config: TelegramConfig, ctx: SourceContext): Source {
  return new TelegramSource(config, ctx)
}

export const kind: SourceKind<TelegramConfig> = {
  id: TELEGRAM_SOURCE,
  title: 'Telegram',
  description:
    'Telegram bot: direct messages from allowed users and configured group chats, long-polled locally; slash commands are answered without a model call.',
  create: (config, ctx) => createSource(config, ctx),
}

export default kind
