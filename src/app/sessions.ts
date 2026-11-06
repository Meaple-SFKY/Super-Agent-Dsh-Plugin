/**
 * DSH Session integration: the long-lived Router session and one Worker
 * session per Ticket.
 *
 * The class is deliberately host-service-light: it needs the agent registry
 * (create/resume), the optional preset registry (to mount the role
 * composition), the optional session-persistence service (to tell a cold
 * session from a new one) and the per-agent context (prompt section + tool
 * registration). Everything else is injected, which keeps the logic testable
 * without a real DSH host.
 *
 * Recovery contract: session ids are deterministic (`superagent-router`,
 * `superagent-worker-<ticketId>`) and additionally persisted in the KV store.
 * After a host restart the session is resumed from persistence; the previous
 * conversation is the worker's memory, so a retry never starts from scratch.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as brandSessionId } from '@deepseek-ai/dsh-session'
import type { KeyValueStore } from '../core/ports.js'
import type { IsoTime, TicketId } from '../core/model.js'
import type { AppLogger } from './support.js'
import { errorMessage, nowIso, runSafely, sleep, withTimeout } from './support.js'
import {
  normalizeLanguage,
  routerSystemPrompt,
  workerSystemPrompt,
  type Language,
} from '../prompts/index.js'

// ---------------------------------------------------------------------------
// Host service shapes (only what this module uses)
// ---------------------------------------------------------------------------

/** The subset of `ctx.agents` we depend on. */
export interface HostAgentRegistry {
  get(id: SessionId): Agent | undefined
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
}

/** The subset of `ctx.agentPresets` we depend on (optional service). */
export interface AgentPresetRow {
  id: string
  name?: string
  isDefault: boolean
  broken?: string
}

export interface HostAgentPresets {
  list(): Promise<readonly AgentPresetRow[]>
  mount(ctx: Context, id?: string): Promise<{ id: string }>
}

/** The subset of `ctx.sessionPersistence` we depend on (optional service). */
export interface HostSessionPersistence {
  stat(id: SessionId): Promise<unknown | undefined>
}

/** Resolve the host services from a Cordis context without requiring injection. */
export function hostServices(ctx: Context): {
  agents: HostAgentRegistry
  presets?: HostAgentPresets
  persistence?: HostSessionPersistence
} {
  const agents = ctx.get('agents') as HostAgentRegistry | undefined
  if (!agents) throw new Error('superagent: the DSH agent registry service (agents) is unavailable')
  return {
    agents,
    presets: ctx.get('agentPresets') as HostAgentPresets | undefined,
    persistence: ctx.get('sessionPersistence') as HostSessionPersistence | undefined,
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionRole = 'router' | 'worker'

export interface SessionInfo {
  role: SessionRole
  sessionId: SessionId
  ticketId?: TicketId
  cwd?: string
}

export interface SessionTurnEnd extends SessionInfo {
  assignmentId?: string
}

export interface SessionsOptions {
  agents: HostAgentRegistry
  presets?: HostAgentPresets
  persistence?: HostSessionPersistence
  logger: AppLogger
  kv: KeyValueStore
  now?: () => IsoTime
  /** Preset ids declared by the bundle patch. */
  presetIds?: { router: string; worker: string }
  /** Route used when the preset does not pin a model (explicit executor config). */
  agentOptions?: AgentOptions
  /**
   * Fallback route resolver for new sessions: the host default model
   * (`agentDefaultModel.currentSelection()`) or an explicit executor model.
   * A new AgentSession has no model selection of its own, so without this the
   * first turn fails with "has no provider/model".
   */
  defaultModel?: () => AgentOptions | undefined | Promise<AgentOptions | undefined>
  /** User-facing language for role prompts (default zh). */
  language?: Language
  /** Deadline for one create/resume call. */
  createTimeoutMs?: number
  /** Deadline for one whenIdle/dispose call during stop. */
  disposeTimeoutMs?: number
  /** Idle live workers kept around (LRU-disposed beyond this). */
  maxWorkers?: number
  /** Register role tools / extra prompt context in the agent's own scope. */
  decorate?: (agentCtx: Context, info: SessionInfo) => void
  /** Called whenever an agent transitioned to `idle` (turn ended). */
  onTurnEnd?: (info: SessionTurnEnd) => void
  /** Called when a session turn fails with an agent/error event. */
  onTurnError?: (info: SessionInfo, error: unknown) => void
}

interface WorkerRecord {
  info: SessionInfo
  agent: Agent
  handle?: AgentHandle
  lastUsedAt: number
  disposers: Array<() => void>
  /** True when this session was loaded from persistence (retry/recovery). */
  resumed: boolean
}

/** Mutable per-ticket binding of the currently running Assignment. */
interface AssignmentBinding {
  ticketId: TicketId
  assignmentId: string
}

const ROUTER_SESSION_KEY = 'superagent.router.sessionId'
const WORKER_SESSION_PREFIX = 'superagent.worker.sessionId.'

/** Build a user message from plain text using the official DSH constructor. */
export function userMessage(text: string): Parameters<Agent['followup']>[0] {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

export const ROUTER_SESSION_ID = 'superagent-router'

/** Deterministic worker session id; one session per ticket, resumed on retry. */
export function workerSessionId(ticketId: TicketId): SessionId {
  const safe = String(ticketId).replace(/[^A-Za-z0-9._-]/g, '-')
  return brandSessionId(`superagent-worker-${safe}`)
}

/** Deterministic router session id. */
export function routerSessionId(): SessionId {
  return brandSessionId(ROUTER_SESSION_ID)
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export class Sessions {
  private readonly options: SessionsOptions
  private readonly logger: AppLogger
  private readonly now: () => IsoTime
  private readonly workers = new Map<TicketId, WorkerRecord>()
  private readonly bindings = new Map<SessionId, AssignmentBinding>()
  private readonly startedAt = new Map<SessionId, number>()
  private router?: WorkerRecord
  private routerStarting?: Promise<WorkerRecord>
  private presetRoster?: { at: number; rows: readonly AgentPresetRow[] }
  private readonly warned = new Set<string>()
  private stopped = false

  constructor(options: SessionsOptions) {
    this.options = options
    this.logger = options.logger
    this.now = options.now ?? nowIso
  }

  get presetIds(): { router: string; worker: string } {
    return this.options.presetIds ?? { router: 'superagent-router', worker: 'superagent-worker' }
  }

  /** Whether the router session is currently live. */
  get routerLive(): boolean {
    return this.router !== undefined
  }

  /** The live router agent, when available. */
  liveRouter(): Agent | undefined {
    return this.router?.agent
  }

  /** The live worker agent for a ticket, when available. */
  liveWorker(ticketId: TicketId): Agent | undefined {
    return this.workers.get(ticketId)?.agent
  }

  hasWorker(ticketId: TicketId): boolean {
    return this.workers.has(ticketId)
  }

  /** Whether the live worker session was resumed from persistence (recovery). */
  workerWasResumed(ticketId: TicketId): boolean {
    return this.workers.get(ticketId)?.resumed ?? false
  }

  /** Whether a persisted session exists for a ticket (used by tests and recovery). */
  async hasPersistedWorker(ticketId: TicketId): Promise<boolean> {
    return this.sessionExists(this.workerSession(ticketId))
  }

  workerSession(ticketId: TicketId): SessionId {
    const kv = this.options.kv.get<string>(WORKER_SESSION_PREFIX + ticketId)
    return kv ? brandSessionId(kv) : workerSessionId(ticketId)
  }

  /** Remember / read the router session identity; deterministic by default. */
  routerSession(): SessionId {
    const stored = this.options.kv.get<string>(ROUTER_SESSION_KEY)
    return stored ? brandSessionId(stored) : routerSessionId()
  }

  /** Map a session id back to its ticket, when it is one of ours. */
  infoForSession(sessionId: SessionId): SessionInfo | undefined {
    if (this.router?.info.sessionId === sessionId) return this.router.info
    for (const record of this.workers.values()) {
      if (record.info.sessionId === sessionId) return record.info
    }
    return undefined
  }

  /** Bind the currently running Assignment to a worker session (turn-end mapping). */
  bindAssignment(ticketId: TicketId, sessionId: SessionId, assignmentId: string): void {
    this.bindings.set(sessionId, { ticketId, assignmentId })
  }

  /** Drop the assignment binding for a ticket (after interrupt/end). */
  unbindAssignment(ticketId: TicketId): void {
    for (const [sessionId, binding] of this.bindings) {
      if (binding.ticketId === ticketId) this.bindings.delete(sessionId)
    }
  }

  bindingFor(ticketId: TicketId): AssignmentBinding | undefined {
    const sessionId = this.workerSession(ticketId)
    return this.bindings.get(sessionId)
  }

  /**
   * Resolve the fallback route for a new session. Explicit `agentOptions`
   * (executor config) wins over the host default resolver.
   */
  private async resolveFallbackRoute(info: SessionInfo): Promise<AgentOptions | undefined> {
    if (this.options.agentOptions) return this.options.agentOptions
    if (!this.options.defaultModel) return undefined
    try {
      const route = await this.options.defaultModel()
      if (route && typeof route.provider === 'string' && typeof route.model === 'string') return route
    } catch (error) {
      this.logger.warn('could not resolve the default model route', { error: errorMessage(error) })
    }
    this.warnOnce(
      `no-model:${info.role}`,
      `no provider/model is available for the ${info.role} session: set executor.model in the plugin ` +
        'configuration or configure a default model in DSH settings. The session may fail its first turn.',
    )
    return undefined
  }

  /**
   * A resumed session created before the fallback existed has no durable model
   * selection. Record the fallback once, so a later turn can run; an existing
   * durable selection is never overwritten.
   */
  private ensureDurableSelection(agent: Agent, fallback: AgentOptions | undefined, resumed: boolean): void {
    // New sessions get the route through agentOptions; only a resumed session
    // created before the fallback existed (no durable selection) needs a repair.
    if (!resumed) return
    if (!fallback || typeof fallback.provider !== 'string' || typeof fallback.model !== 'string') return
    try {
      const model = (agent as unknown as { model?: { current?: () => unknown; select?: (selection: unknown) => void } }).model
      if (!model || typeof model.select !== 'function') return
      if (typeof model.current === 'function' && model.current() !== undefined) return
      model.select({
        provider: fallback.provider,
        model: fallback.model,
        ...(fallback.reasoningEffort !== undefined ? { reasoningEffort: fallback.reasoningEffort } : {}),
      })
      this.logger.info('recorded the default model selection on a session without one', {
        sessionId: String(agent.id),
      })
    } catch (error) {
      this.logger.warn('could not record a fallback model selection', {
        sessionId: String(agent.id),
        error: errorMessage(error),
      })
    }
  }

  // -- creation ------------------------------------------------------------

  /** Create or resume the long-lived Router session. Idempotent. */
  async ensureRouter(cwd?: string): Promise<Agent> {
    if (this.stopped) throw new Error('superagent sessions are stopped')
    const live = this.router?.agent
    if (live) {
      const existing = this.options.agents.get(live.id)
      if (existing) {
        this.router!.agent = existing
        return existing
      }
      this.router = undefined
    }
    this.routerStarting ??= this.openSession(
      { role: 'router', sessionId: this.routerSession(), ...(cwd ? { cwd } : {}) },
      () => this.routerSystemPromptSection(),
    )
    try {
      const record = await this.routerStarting
      this.router = record
      this.options.kv.set(ROUTER_SESSION_KEY, record.info.sessionId as unknown as string)
      return record.agent
    } finally {
      this.routerStarting = undefined
    }
  }

  /** Create or resume the Worker session for one ticket. Idempotent. */
  async ensureWorker(ticketId: TicketId, cwd: string): Promise<Agent> {
    if (this.stopped) throw new Error('superagent sessions are stopped')
    const existing = this.workers.get(ticketId)
    if (existing) {
      const live = this.options.agents.get(existing.info.sessionId)
      if (live) {
        existing.agent = live
        existing.lastUsedAt = Date.now()
        return live
      }
      this.forgetWorker(ticketId)
    }
    const sessionId = this.workerSession(ticketId)
    const record = await this.openSession({ role: 'worker', sessionId, ticketId, cwd })
    if (this.stopped) {
      await this.disposeRecord(record)
      throw new Error('superagent sessions are stopped')
    }
    this.workers.set(ticketId, record)
    this.options.kv.set(WORKER_SESSION_PREFIX + ticketId, sessionId as unknown as string)
    this.enforceWorkerCap()
    return record.agent
  }

  private async openSession(info: SessionInfo, prompt?: () => { name: string; text: string }): Promise<WorkerRecord> {
    const timeoutMs = this.options.createTimeoutMs ?? 60_000
    const sessionId = info.sessionId
    const fallbackRoute = await this.resolveFallbackRoute(info)
    const setup = async (agentCtx: Context, agent: Agent): Promise<void> => {
      await this.mountPreset(agentCtx, info)
      this.registerPrompt(agentCtx, info, prompt)
      if (this.options.decorate) {
        try {
          this.options.decorate(agentCtx, info)
        } catch (error) {
          this.logger.error('failed to decorate the agent scope', {
            sessionId: String(sessionId),
            error: errorMessage(error),
          })
        }
      }
      this.startedAt.set(agent.id, Date.now())
    }
    const persisted = await this.sessionExists(sessionId)
    let handle: AgentHandle
    if (persisted) {
      this.logger.debug('resuming session', { sessionId: String(sessionId) })
      const resumeOptions: ResumeAgentOptions = {
        resumeSessionId: sessionId,
        setup,
        // A fallback route never overrides a durable model selection; the loop
        // prefers the recorded selection. It only rescues sessions that have none.
        ...(fallbackRoute ? { agentOptions: fallbackRoute } : {}),
      }
      handle = await withTimeout(
        this.options.agents.resume(resumeOptions),
        timeoutMs,
        `resume session ${String(sessionId)}`,
      )
    } else {
      this.logger.debug('creating session', { sessionId: String(sessionId) })
      const createOptions: CreateAgentOptions = {
        sessionId,
        ...(info.cwd ? { meta: { cwd: info.cwd } } : {}),
        setup,
        ...(fallbackRoute ? { agentOptions: fallbackRoute } : {}),
      }
      handle = await withTimeout(
        this.options.agents.create(createOptions),
        timeoutMs,
        `create session ${String(sessionId)}`,
      )
    }
    const record: WorkerRecord = {
      info,
      agent: handle.agent,
      handle,
      lastUsedAt: Date.now(),
      disposers: [],
      resumed: persisted,
    }
    this.ensureDurableSelection(record.agent, fallbackRoute, persisted)
    this.watch(record)
    return record
  }

  private async sessionExists(sessionId: SessionId): Promise<boolean> {
    const persistence = this.options.persistence
    if (!persistence) return false
    try {
      const stat = await persistence.stat(sessionId)
      return stat !== undefined && stat !== null
    } catch (error) {
      this.logger.warn('could not stat the session; treating it as new', {
        sessionId: String(sessionId),
        error: errorMessage(error),
      })
      return false
    }
  }

  /** Mount the role preset on the agent's scoped context; fall back to the default. */
  private async mountPreset(agentCtx: Context, info: SessionInfo): Promise<void> {
    const presets = agentCtx.get('agentPresets') as HostAgentPresets | undefined
    if (!presets) {
      this.warnOnce('presets-missing', 'the agent-presets service is unavailable; sessions use the profile default composition')
      return
    }
    const wanted = info.role === 'router' ? this.presetIds.router : this.presetIds.worker
    let mounted: string | undefined
    try {
      const roster = await this.roster(presets)
      const row = roster.find(candidate => candidate.id === wanted)
      if (row && !row.broken) {
        await presets.mount(agentCtx, wanted)
        mounted = wanted
      } else {
        this.warnOnce(
          `preset-missing:${wanted}`,
          `agent preset "${wanted}" is ${row?.broken ? `broken (${row.broken})` : 'not installed'}; falling back to the profile default. ` +
            'Install the SuperAgent presets or the router/worker tools will be missing.',
        )
        await presets.mount(agentCtx)
      }
    } catch (error) {
      if (mounted !== undefined) {
        this.logger.warn('preset mounted but composition failed; continuing with the scoped registrations only', {
          preset: mounted,
          error: errorMessage(error),
        })
      } else {
        this.warnOnce(
          `preset-mount-failed:${wanted}`,
          `could not mount agent preset "${wanted}" (${errorMessage(error)}); continuing with the default composition`,
        )
      }
    }
  }

  private async roster(presets: HostAgentPresets): Promise<readonly AgentPresetRow[]> {
    const cached = this.presetRoster
    if (cached && Date.now() - cached.at < 60_000) return cached.rows
    try {
      const rows = await presets.list()
      this.presetRoster = { at: Date.now(), rows }
      return rows
    } catch (error) {
      this.logger.warn('could not list agent presets', { error: errorMessage(error) })
      this.presetRoster = { at: Date.now(), rows: [] }
      return []
    }
  }

  private registerPrompt(agentCtx: Context, info: SessionInfo, prompt?: () => { name: string; text: string }): void {
    try {
      const systemPrompt = (agentCtx.get('systemPrompt') ?? undefined) as
        | {
            section?: (section: { name: string; order: number; text: string; interpolate?: boolean }) => () => void
            getSectionOrder?: (name: 'DEPLOYMENT_PERSONA_PREFIX') => number
          }
        | undefined
      if (!systemPrompt?.section) return
      const resolved = prompt ? prompt() : undefined
      const language = normalizeLanguage(this.options.language)
      const text =
        resolved?.text ?? (info.role === 'router' ? routerSystemPrompt(language) : workerSystemPrompt(language))
      const base = systemPrompt.getSectionOrder ? systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') : 0
      systemPrompt.section({
        name: resolved?.name ?? (info.role === 'router' ? 'superagent:router-role' : 'superagent:worker-role'),
        order: base + 1,
        text,
        interpolate: false,
      })
    } catch (error) {
      this.logger.warn('could not register the role prompt section', { error: errorMessage(error) })
    }
  }

  private routerSystemPromptSection(): { name: string; text: string } {
    return { name: 'superagent:router-role', text: routerSystemPrompt(normalizeLanguage(this.options.language)) }
  }

  // -- delivery ------------------------------------------------------------

  /** Send text into the Router session; returns false when it is not live. */
  deliverRouter(text: string, mode: 'wake' | 'steer' | 'inject' = 'wake'): boolean {
    const record = this.router
    if (!record) return false
    return this.send(record, text, mode)
  }

  /** Send text into a worker session; `auto` wakes an idle worker and steers a running one. */
  deliverWorker(ticketId: TicketId, text: string, mode: 'auto' | 'wake' | 'steer' | 'inject' = 'auto'): boolean {
    const record = this.workers.get(ticketId)
    if (!record) return false
    record.lastUsedAt = Date.now()
    const resolved = mode === 'auto' ? (record.agent.status === 'running' ? 'steer' : 'wake') : mode
    return this.send(record, text, resolved)
  }

  /** Ask a running worker for a status report; returns whether the request was sent. */
  requestStatus(ticketId: TicketId, text: string): boolean {
    const record = this.workers.get(ticketId)
    if (!record) return false
    record.lastUsedAt = Date.now()
    return this.send(record, text, record.agent.status === 'running' ? 'steer' : 'wake')
  }

  private send(record: WorkerRecord, text: string, mode: 'wake' | 'steer' | 'inject'): boolean {
    try {
      const message = userMessage(text)
      if (mode === 'wake') record.agent.followup(message)
      else if (mode === 'steer') record.agent.steer(message)
      else record.agent.inject(message)
      return true
    } catch (error) {
      this.logger.warn('could not deliver a session message', {
        sessionId: String(record.info.sessionId),
        error: errorMessage(error),
      })
      return false
    }
  }

  // -- turn events ---------------------------------------------------------

  private watch(record: WorkerRecord): void {
    const onStatus = (payload: { status?: string }): void => {
      if (payload?.status !== 'idle') return
      // Shutdown cancels every turn; those are not turn ends the Engine should
      // record (an interrupted Assignment must stay recoverable after restart).
      if (this.stopped) return
      const binding = this.bindings.get(record.info.sessionId)
      const info: SessionTurnEnd = {
        ...record.info,
        ...(binding ? { assignmentId: binding.assignmentId, ticketId: binding.ticketId } : {}),
      }
      runSafely(this.logger, 'onTurnEnd callback', () => {
        this.options.onTurnEnd?.(info)
      })
    }
    const onError = (payload: { error?: unknown }): void => {
      runSafely(this.logger, 'onTurnError callback', () => {
        this.options.onTurnError?.(record.info, payload?.error)
      })
    }
    try {
      const ctx = record.agent.ctx as unknown as {
        on?: (event: string, listener: (payload: never) => void) => (() => void) | undefined
      }
      const disposer = ctx.on?.('agent/status', onStatus as (payload: never) => void)
      if (typeof disposer === 'function') record.disposers.push(disposer)
      const errorDisposer = ctx.on?.('agent/error', onError as (payload: never) => void)
      if (typeof errorDisposer === 'function') record.disposers.push(errorDisposer)
    } catch (error) {
      this.logger.debug('could not subscribe to session events', { error: errorMessage(error) })
    }
  }

  // -- interruption and disposal ------------------------------------------

  /** Cancel a running turn (keeps the session so it can be resumed later). */
  interrupt(ticketId: TicketId, reason: string): void {
    const record = this.workers.get(ticketId)
    if (!record) return
    this.cancel(record, reason)
  }

  /** Cancel the router's in-flight turn (used during stop/safe mode). */
  interruptRouter(reason: string): void {
    if (this.router) this.cancel(this.router, reason)
  }

  private cancel(record: WorkerRecord, reason: string): void {
    try {
      record.agent.cancel({ kind: 'hook', reason }, { keepInbox: false })
    } catch (error) {
      this.logger.warn('agent cancel failed', {
        sessionId: String(record.info.sessionId),
        error: errorMessage(error),
      })
    }
    const idle = record.agent.whenIdle?.()
    if (idle && typeof idle.then === 'function') {
      idle.catch((error: unknown) => {
        this.logger.warn('agent did not quiesce after cancel', {
          sessionId: String(record.info.sessionId),
          error: errorMessage(error),
        })
      })
    }
  }

  /** Dispose the worker session for a ticket (frees the writer and memory). */
  async disposeWorker(ticketId: TicketId, reason = 'ticket ended'): Promise<void> {
    const record = this.workers.get(ticketId)
    if (!record) return
    this.workers.delete(ticketId)
    this.unbindAssignment(ticketId)
    await this.disposeRecord(record, reason)
  }

  private forgetWorker(ticketId: TicketId): void {
    const record = this.workers.get(ticketId)
    if (!record) return
    this.workers.delete(ticketId)
    void this.disposeRecord(record, 'stale session').catch(() => undefined)
  }

  private async disposeRecord(record: WorkerRecord, reason = 'session disposal'): Promise<void> {
    this.cancel(record, reason)
    const timeoutMs = this.options.disposeTimeoutMs ?? 5_000
    try {
      const idle = record.agent.whenIdle?.()
      if (idle && typeof idle.then === 'function') await withTimeout(idle, timeoutMs, 'agent whenIdle')
    } catch (error) {
      this.logger.debug('agent did not settle before disposal', {
        sessionId: String(record.info.sessionId),
        error: errorMessage(error),
      })
    }
    for (const dispose of record.disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch (error) {
        this.logger.debug('session listener disposer failed', { error: errorMessage(error) })
      }
    }
    this.startedAt.delete(record.info.sessionId)
    if (!record.handle) return
    try {
      await withTimeout(record.handle.dispose(), timeoutMs, 'agent dispose')
    } catch (error) {
      this.logger.warn('agent disposal failed', {
        sessionId: String(record.info.sessionId),
        error: errorMessage(error),
      })
    }
  }

  /** Keep the number of live worker sessions bounded by disposing idle ones (LRU). */
  private enforceWorkerCap(): void {
    const max = this.options.maxWorkers ?? 2
    if (this.workers.size <= max) return
    const idle = [...this.workers.entries()]
      .filter(([, record]) => record.agent.status !== 'running')
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
    for (const [ticketId] of idle) {
      if (this.workers.size <= max) break
      this.logger.info('disposing an idle worker session (worker cap)', { ticketId, max })
      void this.disposeWorker(ticketId, 'worker cap').catch(() => undefined)
    }
  }

  // -- stop ----------------------------------------------------------------

  /** Cancel and dispose every session this object owns. Never throws. */
  async stop(reason = 'plugin stopped'): Promise<void> {
    this.stopped = true
    this.interruptRouter(reason)
    for (const ticketId of [...this.workers.keys()]) this.interrupt(ticketId, reason)
    await sleep(0)
    const records: WorkerRecord[] = []
    if (this.router) {
      records.push(this.router)
      this.router = undefined
    }
    for (const [ticketId, record] of [...this.workers.entries()]) {
      records.push(record)
      this.workers.delete(ticketId)
    }
    this.bindings.clear()
    await Promise.allSettled(records.map(record => this.disposeRecord(record, reason)))
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.logger.warn(message)
  }
}
