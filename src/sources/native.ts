/**
 * The `native` Source: local bridge for the MMAgent macOS app.
 *
 * It owns an independent loopback-only HTTP server (never the DSH connection
 * gate, so the app can talk to it without a browser session) and writes a
 * discovery file for the app. Tokens are random, never logged and never part
 * of an API response. Outbound messages are persisted to a bounded inbox file
 * and broadcast over Server-Sent Events, so the app can reconnect or backfill.
 *
 * The Source itself owns no domain state: task creation, replies, actions,
 * ticket projections and state snapshots are delegated to the `NativeBridge`
 * the runtime injects; the Source only translates HTTP <-> Trigger/Outbound.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFile, chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, isAbsolute, join } from 'node:path'

import type {
  ChannelAddress,
  IsoTime,
  OutboundMessage,
  ReceiveDisposition,
  SendOutcome,
  SourceId,
  ThreadKey,
  Trigger,
} from '../core/model.js'
import { makeTrigger, type Source, type SourceContext } from './kind.js'

export const NATIVE_SOURCE = 'native'
export const NATIVE_API_PREFIX = '/superagent/native/v1'
export const NATIVE_DISCOVERY_FILE = 'native.json'
export const NATIVE_VERSION = '1.1.0'
export const NATIVE_DEFAULT_PORT = 47821
export const NATIVE_INBOX_FILE = 'native-inbox.jsonl'

const MAX_BODY_BYTES = 1_000_000
const REQUESTS_PER_SECOND = 200
const INBOX_LIMIT = 500
const EVENT_BACKLOG = 500
const DEFAULT_THREAD_PREFIX = 'native:task:'

// ---------------------------------------------------------------------------
// Bridge types (implemented by the runtime)
// ---------------------------------------------------------------------------

export interface NativeTicketSummary {
  id: string
  title: string
  stage: string
  lastReport: string | null
  at: IsoTime
}

export interface NativeTicketListItem {
  id: string
  title: string
  state: string
  stage: string
  source: string
  thread: string
  lastReport: string | null
  createdAt: IsoTime
  updatedAt: IsoTime
  endsAt?: IsoTime
}

export interface NativeTicketQuery {
  query?: string
  status?: 'all' | 'attention' | 'active' | 'history'
  source?: string
  /** Cursor from a previous page's `nextBefore` (`<updatedAt>|<id>`). */
  before?: string
  limit?: number
}

export interface NativeTicketPage {
  items: NativeTicketListItem[]
  nextBefore?: string
  total: number
}

export interface NativeTicketDetail {
  id: string
  title: string
  state: string
  stage: string
  source: string
  thread: ThreadKey
  createdAt: IsoTime
  updatedAt: IsoTime
  paused?: boolean
  waitingForPerson?: boolean
  inputs: Array<{ id: string; kind: string; at: IsoTime; person?: boolean; text?: string; readAt?: IsoTime }>
  reports: Array<{ kind: string; summary: string; at: IsoTime; question?: string }>
  files: Array<{ path: string; name?: string; kind?: string; caption?: string }>
  attachments: Array<{ path: string; name?: string; kind?: string; caption?: string }>
  assignments: Array<{ id: string; state: string; createdAt: IsoTime; startedAt?: IsoTime; endedAt?: IsoTime; sessionId?: string }>
  ends?: { reason: string; at: IsoTime }
}

export interface NativeState {
  ok: true
  plugin: { status: string; detail: string | null; version: string }
  paused: boolean
  native: { version: string; port: number; pid: number; startedAt: IsoTime }
  tickets: {
    active: NativeTicketSummary[]
    attention: NativeTicketSummary[]
    history: NativeTicketSummary[]
  }
  sources: Array<{ id: string; health: string; detail: string | null; at: IsoTime | null }>
  health: Array<{ name: string; state: string; detail: string | null }>
}

/** One validated local attachment from a native task request. */
export interface NativeTaskAttachment {
  path: string
  name: string
  kind: 'photo' | 'document'
  size: number
}

export interface NativeTaskResult {
  ok: boolean
  ticketId?: string
  threadId: string
  triggerId?: string
  error?: string
}

export interface NativeReplyResult {
  ok: boolean
  triggerId?: string
  error?: string
}

export interface NativeActionResult {
  ok: boolean
  result?: string
  error?: string
}

/** One setup action result, matching the setup HTTP API status/body contract. */
export interface NativeSetupResult {
  status: number
  body: Record<string, unknown>
}

/** Config preparation result; `patch` is committed after the response is sent. */
export interface NativeSetupConfigResult extends NativeSetupResult {
  patch?: unknown
}

/**
 * Setup wizard surface backed by the runtime's `SetupService` (token validation,
 * 0600 secret writes, configEditor persistence). The Source only forwards
 * authenticated HTTP bodies and never sees a secret it did not just receive.
 */
export interface NativeSetupBridge {
  state(): Promise<NativeSetupResult>
  saveTelegram(body: unknown): Promise<NativeSetupResult>
  saveGithub(body: unknown): Promise<NativeSetupResult>
  saveOperatorToken(body: unknown): Promise<NativeSetupResult>
  generateSshKey(): Promise<NativeSetupResult>
  listModels(): Promise<NativeSetupResult>
  prepareConfig(body: unknown): Promise<NativeSetupConfigResult>
  commitConfig(patch: unknown): void
}

/** Everything the HTTP layer needs from the runtime; implemented in {@link Runtime}. */
export interface NativeBridge {
  state(): NativeState | Promise<NativeState>
  ticket(ticketId: string): NativeTicketDetail | undefined | Promise<NativeTicketDetail | undefined>
  createTask(input: {
    text: string
    clientTaskId?: string
    attachments?: NativeTaskAttachment[]
  }): Promise<NativeTaskResult>
  reply(ticketId: string, text: string): Promise<NativeReplyResult>
  action(ticketId: string, action: 'ack' | 'retry' | 'stop'): Promise<NativeActionResult>
  tickets?(options: NativeTicketQuery): Promise<NativeTicketPage>
  setup?: NativeSetupBridge
}

export interface NativeSourceConfig {
  enabled?: boolean
  /** Preferred port; 0 asks the OS for a free one. Occupied ports fall through to the next candidate. */
  port?: number
  bridge?: NativeBridge
  maxBodyBytes?: number
  requestsPerSecond?: number
  inboxLimit?: number
}

interface NativeEvent {
  id: number
  type: string
  at: IsoTime
  data: unknown
}

interface InboxEntry {
  id: number
  at: IsoTime
  message: OutboundMessage
}

// ---------------------------------------------------------------------------
// The Source
// ---------------------------------------------------------------------------

export class NativeSource implements Source {
  readonly id: SourceId = NATIVE_SOURCE
  readonly kind = 'native'

  private readonly ctx: SourceContext
  private readonly bridge: NativeBridge
  private readonly preferredPort: number
  private readonly maxBodyBytes: number
  private readonly requestsPerSecond: number
  private readonly inboxLimit: number

  private server: Server | undefined
  private port = 0
  private token = ''
  private tokenDigest: Uint8Array = new Uint8Array(0)
  private startedAt: IsoTime | undefined
  private started = false
  private stopping = false

  private readonly clients = new Set<ServerResponse>()
  private readonly events: NativeEvent[] = []
  private nextEventId = 1
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private readonly knownTickets = new Map<string, string>()
  private readonly attentionSeen = new Set<string>()
  private readonly finished = new Set<string>()

  private inbox: InboxEntry[] = []
  private nextInboxId = 1
  private requestWindow = { start: 0, count: 0 }

  constructor(ctx: SourceContext, config: NativeSourceConfig) {
    this.ctx = ctx
    this.bridge = config.bridge ?? missingBridge()
    this.preferredPort = config.port ?? NATIVE_DEFAULT_PORT
    this.maxBodyBytes = config.maxBodyBytes ?? MAX_BODY_BYTES
    this.requestsPerSecond = config.requestsPerSecond ?? REQUESTS_PER_SECOND
    this.inboxLimit = config.inboxLimit ?? INBOX_LIMIT
  }

  async start(): Promise<void> {
    if (this.started || this.stopping) return
    this.ctx.health({ name: NATIVE_SOURCE, state: 'starting' })
    try {
      await mkdir(this.ctx.stateDir, { recursive: true, mode: 0o700 })
      this.token = randomBytes(32).toString('hex')
      this.tokenDigest = digest(this.token)
      await this.loadInbox()
      await this.listen()
      this.started = true
      this.startedAt = this.ctx.now()
      await this.writeDiscovery()
      this.heartbeat = setInterval(() => this.writeHeartbeat(), 15_000)
      this.heartbeat.unref?.()
      this.pollTimer = setInterval(() => void this.pollTickets(), 1_000)
      this.pollTimer.unref?.()
      this.ctx.health({ name: NATIVE_SOURCE, state: 'ready', detail: `127.0.0.1:${this.port}` })
      this.ctx.logger.info('native bridge listening', { port: this.port, discovery: join(this.ctx.stateDir, NATIVE_DISCOVERY_FILE) })
    } catch (error) {
      this.started = false
      this.ctx.health({ name: NATIVE_SOURCE, state: 'error', detail: describe(error) })
      this.ctx.logger.warn('native bridge failed to start', { error: describe(error) })
      await this.stop().catch(() => undefined)
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.started = false
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.pollTimer = undefined
    this.heartbeat = undefined
    for (const client of this.clients) {
      try {
        client.socket?.destroy()
      } catch {
        // best effort
      }
    }
    this.clients.clear()
    await this.closeServer()
    try {
      await unlink(join(this.ctx.stateDir, NATIVE_DISCOVERY_FILE))
    } catch {
      // already gone
    }
    this.ctx.health({ name: NATIVE_SOURCE, state: 'off' })
    this.stopping = false
  }

  async send(message: OutboundMessage): Promise<SendOutcome> {
    if (message.channel.source !== NATIVE_SOURCE) return 'failed'
    try {
      const entry: InboxEntry = { id: this.nextInboxId++, at: this.ctx.now(), message }
      this.inbox.push(entry)
      if (this.inbox.length > this.inboxLimit) this.inbox.splice(0, this.inbox.length - this.inboxLimit)
      await appendFile(this.inboxPath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
      this.broadcast('message', {
        message,
        inboxId: entry.id,
        thread: message.channel.thread,
        ticketId: message.ticketId ?? null,
        purpose: message.purpose,
      })
      return 'sent'
    } catch (error) {
      this.ctx.logger.warn('could not persist the native outbox message', { error: describe(error) })
      return 'failed'
    }
  }

  channelAllowed(channel: ChannelAddress): boolean {
    return channel.source === NATIVE_SOURCE && channel.thread.startsWith(DEFAULT_THREAD_PREFIX)
  }

  // -- HTTP ---------------------------------------------------------------

  private async listen(): Promise<void> {
    const candidates = this.preferredPort === 0
      ? [0]
      : [this.preferredPort, this.preferredPort + 1, this.preferredPort + 2, 0]
    let lastError: unknown
    for (const candidate of candidates) {
      try {
        const server = createServer((request, response) => {
          void this.handle(request, response)
        })
        this.server = server
        await new Promise<void>((resolve, reject) => {
          const onError = (error: unknown): void => {
            server.off('listening', onListening)
            reject(error)
          }
          const onListening = (): void => {
            server.off('error', onError)
            resolve()
          }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen({ host: '127.0.0.1', port: candidate })
        })
        const address = this.server.address()
        this.port = typeof address === 'object' && address !== null ? address.port : candidate
        return
      } catch (error) {
        lastError = error
        await this.closeServer()
      }
    }
    throw lastError ?? new Error('could not bind the native API port')
  }

  private async closeServer(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      setTimeout(() => resolve(), 2_000).unref?.()
    })
  }

  private async handle(request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    try {
      if (!this.started) {
        this.json(response, 503, { ok: false, error: 'not_ready' })
        return
      }
      const remote = request.socket.remoteAddress ?? ''
      if (!isLoopback(remote)) {
        this.json(response, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (!this.takeRequestSlot()) {
        this.json(response, 429, { ok: false, error: 'rate_limited' })
        return
      }
      if (!this.authorized(request)) {
        this.json(response, 401, { ok: false, error: 'unauthorized' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      const method = request.method ?? 'GET'
      if (path === `${NATIVE_API_PREFIX}/state` && method === 'GET') {
        this.json(response, 200, await this.bridge.state())
        return
      }
      if (path === `${NATIVE_API_PREFIX}/events` && method === 'GET') {
        await this.openStream(request, response)
        return
      }
      if (path === `${NATIVE_API_PREFIX}/tasks` && method === 'POST') {
        const body = await this.readJson(request)
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text || text.length > 20_000) {
          this.json(response, 400, { ok: false, error: 'invalid_text', description: 'text must be 1..20000 characters' })
          return
        }
        const { attachments, warnings } = validateTaskAttachments(body.attachments)
        const clientTaskId = typeof body.clientTaskId === 'string' ? body.clientTaskId.slice(0, 200) : undefined
        const result = await this.bridge.createTask({
          text,
          ...(clientTaskId ? { clientTaskId } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        })
        this.json(response, result.ok ? 200 : 400, {
          ...result,
          status: result.ticketId ? 'accepted' : 'pending',
          ...(warnings.length > 0 ? { warnings } : {}),
        })
        return
      }
      if (path === `${NATIVE_API_PREFIX}/messages` && method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? 0)
        const messages = Number.isFinite(since) ? this.inbox.filter(entry => entry.id > since) : this.inbox
        this.json(response, 200, { ok: true, messages, nextSince: this.inbox[this.inbox.length - 1]?.id ?? 0 })
        return
      }
      if (path === `${NATIVE_API_PREFIX}/actions` && method === 'POST') {
        const body = await this.readJson(request)
        const ticketId = typeof body.ticketId === 'string' ? body.ticketId : ''
        const action = body.action
        if (!ticketId || (action !== 'ack' && action !== 'retry' && action !== 'stop')) {
          this.json(response, 400, { ok: false, error: 'invalid_action', description: 'ticketId and action (ack|retry|stop) are required' })
          return
        }
        const result = await this.bridge.action(ticketId, action)
        this.json(response, result.ok ? 200 : 400, result)
        return
      }
      if (path === `${NATIVE_API_PREFIX}/tickets` && method === 'GET') {
        if (!this.bridge.tickets) {
          this.json(response, 501, { ok: false, error: 'tickets_unavailable' })
          return
        }
        const statusParam = url.searchParams.get('status') ?? 'all'
        if (!['all', 'attention', 'active', 'history'].includes(statusParam)) {
          this.json(response, 400, { ok: false, error: 'invalid_status', description: 'status must be all, attention, active or history' })
          return
        }
        const sourceParam = url.searchParams.get('source') ?? undefined
        if (sourceParam !== undefined && !/^[a-z][a-z0-9_-]{0,31}$/i.test(sourceParam)) {
          this.json(response, 400, { ok: false, error: 'invalid_source' })
          return
        }
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw === null ? 30 : Number(limitRaw)
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          this.json(response, 400, { ok: false, error: 'invalid_limit', description: 'limit must be an integer 1..100' })
          return
        }
        const query = (url.searchParams.get('query') ?? '').trim().slice(0, 200)
        const before = url.searchParams.get('before') ?? undefined
        if (before !== undefined && !/^[^|]+\|.+$/.test(before)) {
          this.json(response, 400, { ok: false, error: 'invalid_before', description: 'before must be an opaque nextBefore cursor' })
          return
        }
        const page = await this.bridge.tickets({
          status: statusParam as 'all' | 'attention' | 'active' | 'history',
          ...(query ? { query } : {}),
          ...(sourceParam ? { source: sourceParam } : {}),
          ...(before ? { before } : {}),
          limit,
        })
        this.json(response, 200, { ok: true, ...page })
        return
      }
      if (path.startsWith(`${NATIVE_API_PREFIX}/setup`)) {
        await this.handleSetup(path, method, request, response)
        return
      }
      const ticketMatch = /^\/superagent\/native\/v1\/tickets\/([^/]+)(\/reply)?$/.exec(path)
      if (ticketMatch) {
        const ticketId = decodeURIComponent(ticketMatch[1]!)
        if (ticketMatch[2] === '/reply' && method === 'POST') {
          const body = await this.readJson(request)
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          if (!text || text.length > 20_000) {
            this.json(response, 400, { ok: false, error: 'invalid_text', description: 'text must be 1..20000 characters' })
            return
          }
          const result = await this.bridge.reply(ticketId, text)
          this.json(response, result.ok ? 200 : 404, result)
          return
        }
        if (method === 'GET') {
          const ticket = await this.bridge.ticket(ticketId)
          if (!ticket) {
            this.json(response, 404, { ok: false, error: 'not_found' })
            return
          }
          this.json(response, 200, { ok: true, ticket })
          return
        }
      }
      this.json(response, 404, { ok: false, error: 'not_found' })
    } catch (error) {
      if (error instanceof NativeHttpError) {
        this.json(response, error.status, {
          ok: false,
          error: error.code,
          ...(error.description ? { description: error.description } : {}),
        })
        return
      }
      this.ctx.logger.warn('native bridge request failed', { error: describe(error) })
      try {
        this.json(response, 500, { ok: false, error: 'internal_error' })
      } catch {
        // response already closed
      }
    }
  }

  private async handleSetup(
    path: string,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const setup = this.bridge.setup
    if (!setup) {
      this.json(response, 501, { ok: false, error: 'setup_unavailable', description: 'this host exposes no setup service' })
      return
    }
    const base = `${NATIVE_API_PREFIX}/setup`
    if (path === `${base}/state` && (method === 'GET' || method === 'HEAD')) {
      const result = await setup.state()
      this.json(response, result.status, result.body)
      return
    }
    if (path === `${base}/models` && (method === 'GET' || method === 'HEAD')) {
      const result = await setup.listModels()
      this.json(response, result.status, result.body)
      return
    }
    if (path === `${base}/telegram` && method === 'POST') {
      const body = await this.readJson(request)
      const result = await setup.saveTelegram(body)
      this.json(response, result.status, result.body)
      return
    }
    if (path === `${base}/github` && method === 'POST') {
      const body = await this.readJson(request)
      const result = await setup.saveGithub(body)
      this.json(response, result.status, result.body)
      return
    }
    if (path === `${base}/github/operator` && method === 'POST') {
      const body = await this.readJson(request)
      const result = await setup.saveOperatorToken(body)
      this.json(response, result.status, result.body)
      return
    }
    if (path === `${base}/github/ssh-key` && method === 'POST') {
      const result = await setup.generateSshKey()
      this.json(response, result.status, result.body)
      return
    }
    if (path === `${base}/config` && (method === 'PUT' || method === 'POST')) {
      const body = await this.readJson(request)
      const result = await setup.prepareConfig(body)
      this.json(response, result.status, result.body)
      // The configEditor restart must happen after the response is flushed.
      if (result.body.ok === true && result.patch !== undefined) {
        try {
          setup.commitConfig(result.patch)
        } catch (error) {
          this.ctx.logger.warn('could not schedule the native setup config commit', { error: describe(error) })
        }
      }
      return
    }
    this.json(response, 404, { ok: false, error: 'not_found' })
  }

  private authorized(request: IncomingMessage): boolean {
    const rawHeader = request.headers['x-mmagent-token']
    const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader
    const authorization = request.headers.authorization
    const bearer = typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)
      ? authorization.replace(/^Bearer\s+/i, '').trim()
      : undefined
    const candidate = header ?? bearer
    if (typeof candidate !== 'string' || candidate.length === 0) return false
    const digestCandidate = digest(candidate)
    return digestCandidate.length === this.tokenDigest.length && timingSafeEqual(digestCandidate, this.tokenDigest)
  }

  private takeRequestSlot(): boolean {
    const now = Date.now()
    if (now - this.requestWindow.start >= 1_000) {
      this.requestWindow = { start: now, count: 0 }
    }
    this.requestWindow.count += 1
    return this.requestWindow.count <= this.requestsPerSecond
  }

  private async readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > this.maxBodyBytes) throw new Error('request body too large')
      chunks.push(buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (text.length === 0) return {}
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body must be a JSON object')
    return parsed as Record<string, unknown>
  }

  private json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) return
    const text = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    response.end(text)
  }

  // -- SSE ----------------------------------------------------------------

  private async openStream(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write(': connected\n\n')
    const rawLastId = request.headers['last-event-id']
    const lastEventId = Number(Array.isArray(rawLastId) ? rawLastId[0] : rawLastId ?? 0)
    if (Number.isFinite(lastEventId) && lastEventId > 0) {
      for (const event of this.events) {
        if (event.id > lastEventId) this.writeEvent(response, event)
      }
    } else {
      const snapshot = await this.bridge.state()
      response.write(`event: snapshot\ndata: ${JSON.stringify({ ok: true, snapshot })}\n\n`)
    }
    this.clients.add(response)
    request.on('close', () => {
      this.clients.delete(response)
    })
  }

  private broadcast(type: string, data: unknown): void {
    if (!this.started) return
    const event: NativeEvent = { id: this.nextEventId++, type, at: this.ctx.now(), data }
    this.events.push(event)
    if (this.events.length > EVENT_BACKLOG) this.events.splice(0, this.events.length - EVENT_BACKLOG)
    for (const response of this.clients) {
      try {
        this.writeEvent(response, event)
      } catch {
        this.clients.delete(response)
      }
    }
  }

  private writeEvent(response: ServerResponse, event: NativeEvent): void {
    if (response.writableEnded) return
    response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
  }

  private writeHeartbeat(): void {
    for (const response of this.clients) {
      try {
        response.write(': ping\n\n')
      } catch {
        this.clients.delete(response)
      }
    }
  }

  // -- ticket event polling ------------------------------------------------

  private async pollTickets(): Promise<void> {
    if (!this.started) return
    try {
      const state = await this.bridge.state()
      const seen = new Set<string>()
      for (const ticket of [...state.tickets.active, ...state.tickets.attention]) {
        seen.add(ticket.id)
        const signature = `${ticket.stage}|${ticket.lastReport ?? ''}`
        const previous = this.knownTickets.get(ticket.id)
        if (previous !== signature) {
          this.knownTickets.set(ticket.id, signature)
          if (previous === undefined) this.broadcast('ticket', { ticket })
          else this.broadcast('ticket', { ticket })
        }
        if (state.tickets.attention.some(entry => entry.id === ticket.id) && !this.attentionSeen.has(ticket.id)) {
          this.attentionSeen.add(ticket.id)
          this.broadcast('attention', { ticket })
        }
      }
      for (const ticket of state.tickets.history) {
        if (!this.finished.has(ticket.id)) {
          this.finished.add(ticket.id)
          this.broadcast('result', { ticket })
        }
      }
      for (const id of [...this.knownTickets.keys()]) {
        if (!seen.has(id) && !state.tickets.history.some(ticket => ticket.id === id)) this.knownTickets.delete(id)
      }
    } catch {
      // projections are best effort; the next tick retries
    }
  }

  // -- discovery and inbox -------------------------------------------------

  private discoveryPath(): string {
    return join(this.ctx.stateDir, NATIVE_DISCOVERY_FILE)
  }

  private inboxPath(): string {
    return join(this.ctx.stateDir, NATIVE_INBOX_FILE)
  }

  private async writeDiscovery(): Promise<void> {
    const path = this.discoveryPath()
    const temp = `${path}.tmp-${process.pid}`
    const body = JSON.stringify(
      {
        version: NATIVE_VERSION,
        port: this.port,
        token: this.token,
        pid: process.pid,
        startedAt: this.startedAt ?? this.ctx.now(),
      },
      null,
      2,
    )
    await writeFile(temp, body, { mode: 0o600 })
    await chmod(temp, 0o600)
    await rename(temp, path)
    await chmod(path, 0o600)
  }

  private async loadInbox(): Promise<void> {
    try {
      const raw = await readFile(this.inboxPath(), 'utf8')
      const entries: InboxEntry[] = []
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as InboxEntry
          if (typeof parsed.id === 'number' && parsed.message) entries.push(parsed)
        } catch {
          // skip a torn line
        }
      }
      this.inbox = entries.slice(-this.inboxLimit)
      this.nextInboxId = (this.inbox[this.inbox.length - 1]?.id ?? 0) + 1
    } catch {
      this.inbox = []
      this.nextInboxId = 1
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function missingBridge(): NativeBridge {
  return {
    state: async () => {
      throw new Error('native bridge is not wired')
    },
    ticket: () => undefined,
    createTask: async () => ({ ok: false, threadId: '', error: 'bridge_unavailable' }),
    reply: async () => ({ ok: false, error: 'bridge_unavailable' }),
    action: async () => ({ ok: false, error: 'bridge_unavailable' }),
  }
}

function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class NativeHttpError extends Error {
  readonly status: number
  readonly code: string
  readonly description?: string
  constructor(status: number, code: string, description?: string) {
    super(description ?? code)
    this.name = 'NativeHttpError'
    this.status = status
    this.code = code
    this.description = description
  }
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.bmp', '.tiff'])

/**
 * Validate `attachments` from a native task: absolute paths of existing regular
 * files, at most 10. Returns the normalized attachment list for Trigger.meta.
 */
export function validateTaskAttachments(value: unknown): { attachments: NativeTaskAttachment[]; warnings: string[] } {
  if (value === undefined || value === null) return { attachments: [], warnings: [] }
  const warnings: string[] = []
  if (!Array.isArray(value)) {
    return { attachments: [], warnings: ['attachments was ignored: expected an array of absolute paths'] }
  }
  const entries = value.slice(0, 10)
  if (value.length > 10) warnings.push(`only the first 10 attachments were used (${value.length} given)`)
  const attachments: NativeTaskAttachment[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      warnings.push('an attachment was ignored: expected a non-empty absolute path')
      continue
    }
    const path = entry.trim()
    if (!isAbsolute(path)) {
      warnings.push(`attachment ignored (not an absolute path): ${path}`)
      continue
    }
    let stat
    try {
      stat = statSync(path)
    } catch {
      warnings.push(`attachment ignored (does not exist): ${path}`)
      continue
    }
    if (!stat.isFile()) {
      warnings.push(`attachment ignored (not a regular file): ${path}`)
      continue
    }
    const name = basename(path)
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : ''
    attachments.push({
      path,
      name,
      kind: IMAGE_EXTENSIONS.has(extension) ? 'photo' : 'document',
      size: stat.size,
    })
  }
  return { attachments, warnings }
}

export function createSource(config: unknown, ctx: SourceContext): Source {
  const parsed = (config ?? {}) as NativeSourceConfig
  return new NativeSource(ctx, parsed)
}
