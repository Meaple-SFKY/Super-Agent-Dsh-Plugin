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
      // Edits and channel posts are intentionally ignored.
      const callback = update.callback_query
      if (callback && this.config.observeCallbacks) return this.handleCallback(callback, api, signal)
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
    const addressed = this.isAddressed(message, text, isPrivate)
    if (!isPrivate && !addressed && !this.config.observeAllChatMessages) return 'filtered'

    const command = parseTelegramCommand(text)
    if (command) {
      // A command addressed to another bot in a group is not for us.
      if (!isPrivate && !addressed) return 'filtered'
      if (command.target && this.bot?.username && command.target !== this.bot.username.toLowerCase()) {
        return 'filtered'
      }
      await this.runCommand(command, message, isPrivate)
      return 'command'
    }
    // Unknown slash commands are not conversation: ignore them instead of
    // turning a typo into a Ticket.
    if (text.startsWith('/')) return 'filtered'
    if (!text) return 'ignored'
    return this.offer(this.buildMessageTrigger(message))
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

  private buildMessageTrigger(message: TelegramMessage): Trigger {
    const from = message.from!
    const userId = String(from.id)
    const chatId = String(message.chat.id)
    const isPrivate = message.chat.type === 'private'
    const text = (message.text ?? message.caption ?? '').trim()
    const thread: ThreadRef = isPrivate
      ? { key: `telegram:dm:${userId}`, source: TELEGRAM_SOURCE, label: `DM ${displayName(from) ?? userId}` }
      : {
          key: `telegram:chat:${chatId}`,
          source: TELEGRAM_SOURCE,
          label: message.chat.title ?? `chat ${chatId}`,
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
        ...(message.reply_to_message ? { replyToMessageId: message.reply_to_message.message_id } : {}),
        ...(isPrivate ? {} : { chatTitle: chatLabel(message.chat) }),
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
    try {
      // Best effort: without an answer the client keeps a spinner.
      await api.answerCallbackQuery({ callbackQueryId: callback.id, text: '' }, signal)
    } catch (error) {
      if (isAbortError(error) && signal.aborted) throw error
      this.ctx.logger.debug('telegram: answerCallbackQuery failed', { error: describeError(error) })
    }
    if (!callback.data) return 'ignored'
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
      to: message ? String(message.chat.id) : thread.key.replace(/^telegram:(?:dm|chat):/, ''),
      ...(message && this.config.replyToMessages ? { replyTo: String(message.message_id) } : {}),
    }
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  async send(message: OutboundMessage): Promise<SendOutcome> {
    const chatId = message.channel.to
    if (!this.isAllowedChat(chatId)) return 'gone'
    const api = this.getApi()
    try {
      if (!this.bot) this.bot = await api.getMe(this.controller?.signal)
      const replyTo = this.config.replyToMessages ? Number(message.channel.replyTo) : undefined
      await api.sendMessage({
        chatId,
        text: message.text,
        markdown: message.markdown ?? 'plain',
        ...(replyTo !== undefined && Number.isFinite(replyTo) ? { replyToMessageId: replyTo } : {}),
        signal: this.controller?.signal,
      })
      return 'sent'
    } catch (error) {
      if (error instanceof TelegramTokenError) throw error
      if (error instanceof TelegramApiError) {
        // 403: the bot was blocked / kicked; 400 with these texts is permanent.
        if (error.code === 403) return 'gone'
        if (error.code === 400 && /chat not found|user is deactivated|PEER_ID_INVALID|bot was blocked/i.test(error.description)) {
          return 'gone'
        }
      }
      // Everything else is retryable by the Outbox.
      throw error
    }
  }

  channelAllowed(channel: ChannelAddress): boolean {
    return channel.source === TELEGRAM_SOURCE && this.isAllowedChat(channel.to)
  }
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
