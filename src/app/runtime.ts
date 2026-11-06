/**
 * Composition root.
 *
 * `Runtime` owns the whole application lifecycle: config validation, the
 * state directory lock, the Store, the durable effect queue, the Outbox, the
 * Engine, the Router/Worker sessions, the Sources, the management API, the
 * heartbeat and the watchdog.
 *
 * Failure policy (hard requirement): nothing here may throw out of a timer or
 * a floating promise. Component failures degrade the component, repeated
 * failures enter **safe mode** (sources and effects paused, state preserved,
 * optional Telegram notice), and `stop()` always completes.
 */

import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type {
  AcceptMode,
  Assignment,
  ChannelAddress,
  IsoTime,
  OutboundMessage,
  Policy,
  PolicyRule,
  SendOutcome,
  SourceId,
  Ticket,
  TicketId,
  Trigger,
} from '../core/model.js'
import type {
  AssessorPort,
  Clock,
  Engine,
  EngineForExecutor,
  ExecutorPort,
  PolicyProvider,
  SourceScopePort,
  Store,
} from '../core/ports.js'
import { createEngine } from '../core/engine.js'
import { createEffects } from './effects.js'
import { createOutbox } from './outbox.js'
import { openStore } from './store.js'
import { HealthRegistry, pluginStatus, type PluginStatus } from './health.js'
import { Sessions, hostServices, type SessionInfo, type SessionsOptions } from './sessions.js'
import { Executor } from './executor.js'
import { Assessor } from './assessor.js'
import { Watchdog } from './watchdog.js'
import { registerApi, API_VERSION, type ApiActionRequest, type ApiActionValue, type ApiDeps, type ApiState } from './api.js'
import { SetupService, type ConfigEditorLike } from './setup.js'
import { registerRouterTools } from '../tools/router.js'
import { registerWorkerTools } from '../tools/worker.js'
import { preloadPrompts } from '../prompts/index.js'
import type { ToolDeps } from '../tools/shared.js'
import type { AppLogger } from './support.js'
import { errorMessage, nowIso, runSafely, safeString, withTimeout } from './support.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TelegramSourceConfig {
  enabled?: boolean
  tokenEnv?: string
  tokenFile?: string
  allowedUserIds?: string[]
  chats?: string[]
  [key: string]: unknown
}

export interface GithubSourceConfig {
  enabled?: boolean
  tokenEnv?: string
  tokenFile?: string
  repositories?: string[]
  login?: string
  allowedLogins?: string[]
  botLogins?: string[]
  observeIssues?: boolean
  observePulls?: boolean
  observeComments?: boolean
  observeCi?: boolean
  [key: string]: unknown
}

export interface RuntimeConfig {
  stateDir: string
  enabled?: boolean
  sources?: { telegram?: TelegramSourceConfig; github?: GithubSourceConfig }
  policy?: { mode?: AcceptMode; rules?: Array<{ id: string; name: string; enabled?: boolean; instructions: string }> }
  executor?: {
    model?: string
    provider?: string
    maxWorkers?: number
    prepare?: string
    cloneUrl?: string
    clone?: boolean
    defaultRepo?: string
    prepareTimeoutMs?: number
    gitTimeoutMs?: number
  }
  quiet?: { maxChars?: number; minChars?: number }
  watchdog?: { stallMs?: number; escalateMs?: number; intervalMs?: number; silentMs?: number; silentMaxAttempts?: number }
  /** Explicit accept-mode acknowledgement behaviour (default false: quiet). */
  acknowledgeOnAccept?: boolean
  /** Optional override for the recurring engine pass (default 2 s). */
  passIntervalMs?: number
  /** Optional override for the heartbeat interval (default 30 s). */
  heartbeatIntervalMs?: number
}

export interface ConfigProblem {
  error: string
}

/** Validate the raw plugin config; returns a normalized config or a clear error. */
export function validateConfig(raw: unknown): { config?: RuntimeConfig; problem?: ConfigProblem } {
  if (raw === null || typeof raw !== 'object') return { problem: { error: 'configuration must be an object' } }
  const record = raw as Record<string, unknown>
  const stateDir = record.stateDir
  if (typeof stateDir !== 'string' || stateDir.trim().length === 0) {
    return { problem: { error: 'configuration.stateDir is required' } }
  }
  if (!stateDir.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(stateDir)) {
    return { problem: { error: 'configuration.stateDir must be an absolute path' } }
  }
  const config = record as unknown as RuntimeConfig
  const mode = config.policy?.mode
  if (mode !== undefined && mode !== 'off' && mode !== 'observe' && mode !== 'auto') {
    return { problem: { error: 'configuration.policy.mode must be off|observe|auto' } }
  }
  const maxWorkers = config.executor?.maxWorkers
  if (maxWorkers !== undefined && (!Number.isInteger(maxWorkers) || maxWorkers < 1)) {
    return { problem: { error: 'configuration.executor.maxWorkers must be a positive integer' } }
  }
  for (const [id, source] of Object.entries(config.sources ?? {})) {
    if (source === null || typeof source !== 'object') {
      return { problem: { error: `configuration.sources.${id} must be an object` } }
    }
  }
  return { config: { ...config, stateDir } }
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

class MutablePolicy implements PolicyProvider {
  private value: Policy

  constructor(policy: Policy) {
    this.value = policy
  }

  current(): Policy {
    return this.value
  }

  replace(policy: Policy): void {
    this.value = policy
  }
}

function buildPolicy(config: RuntimeConfig, paused: boolean): Policy {
  const rules: PolicyRule[] = (config.policy?.rules ?? []).map(rule => ({
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled !== false,
    instructions: rule.instructions,
  }))
  const telegram = config.sources?.telegram
  const github = config.sources?.github
  const sources: Policy['sources'] = {}
  if (telegram) {
    sources.telegram = {
      allowed: (telegram.allowedUserIds ?? []).map(id => ({ id, name: id })),
      ...(telegram.chats ? { chats: telegram.chats } : {}),
    }
  }
  if (github) {
    sources.github = {
      allowed: (github.allowedLogins ?? (github.login ? [github.login] : [])).map(login => ({ id: login, name: login })),
      ...(github.botLogins ? { bots: github.botLogins.map(login => ({ id: login, name: login })) } : {}),
      ...(github.repositories ? { repositories: github.repositories } : {}),
    }
  }
  return {
    version: `p1-${Date.now().toString(36)}`,
    mode: config.policy?.mode ?? 'observe',
    rules,
    sources,
    paused,
    evalTimeoutMs: 120_000,
  }
}

// ---------------------------------------------------------------------------
// Sources manager
// ---------------------------------------------------------------------------

interface SourceLike {
  readonly id: SourceId
  readonly kind: string
  start(): Promise<void>
  stop(): Promise<void>
  send(message: OutboundMessage): Promise<SendOutcome>
  channelAllowed(channel: ChannelAddress): boolean
}

interface LoadedSource {
  id: SourceId
  source: SourceLike
  healthName: string
}

class SourcesManager {
  private readonly sources = new Map<SourceId, LoadedSource>()
  private readonly health: HealthRegistry
  private readonly logger: AppLogger

  constructor(health: HealthRegistry, logger: AppLogger) {
    this.health = health
    this.logger = logger
  }

  add(id: SourceId, source: SourceLike): void {
    this.sources.set(id, { id, source, healthName: `sources:${id}` })
  }

  get(id: SourceId): SourceLike | undefined {
    return this.sources.get(id)?.source
  }

  ids(): SourceId[] {
    return [...this.sources.keys()]
  }

  async startAll(): Promise<void> {
    for (const { id, source, healthName } of this.sources.values()) {
      this.health.set(healthName, 'starting')
      try {
        await withTimeout(Promise.resolve(source.start()), 20_000, `source ${id} start`)
        this.health.set(healthName, 'ready')
      } catch (error) {
        this.health.fail(healthName, error)
        this.logger.error('source failed to start', { source: id, error: errorMessage(error) })
      }
    }
  }

  async stopAll(): Promise<void> {
    const entries = [...this.sources.values()]
    await Promise.allSettled(
      entries.map(async ({ id, source, healthName }) => {
        try {
          await withTimeout(Promise.resolve(source.stop()), 10_000, `source ${id} stop`)
          this.health.set(healthName, 'off')
        } catch (error) {
          this.health.fail(healthName, error)
          this.logger.warn('source failed to stop', { source: id, error: errorMessage(error) })
        }
      }),
    )
  }

  async send(message: OutboundMessage): Promise<SendOutcome> {
    const target = this.sources.get(message.channel.source)
    if (!target) return 'failed'
    try {
      return await target.source.send(message)
    } catch (error) {
      this.health.fail(target.healthName, error)
      this.logger.warn('source send failed', { source: message.channel.source, error: errorMessage(error) })
      return 'failed'
    }
  }

  channelAllowed(channel: ChannelAddress): boolean {
    const target = this.sources.get(channel.source)
    if (!target) return false
    try {
      return target.source.channelAllowed(channel)
    } catch {
      return false
    }
  }

  healthSnapshot(): ApiState['sources'] {
    return [...this.sources.values()].map(({ id, healthName }) => {
      const entry = this.health.get(healthName)
      const state = entry?.state === 'error' ? 'error' : entry?.state === 'starting' ? 'starting' : entry?.state === 'off' ? 'off' : 'ready'
      return { id, health: state, detail: entry?.detail ?? null, at: entry?.at ?? null }
    })
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface RuntimeHandle {
  stop(): Promise<void>
}

/** Test seams: inject a prepared store or pre-built Sources instead of the host factories. */
export interface RuntimeOverrides {
  /** Pre-opened store (tests use `createMemoryStore`); the runtime will not close it. */
  store?: Store
  /** Pre-built sources, keyed by id; skips the dynamic source imports. */
  sources?: Array<{ id: SourceId; source: SourceLike }>
  /** Skip the state-directory lock (tests that share a directory). */
  skipLock?: boolean
}

interface EffectStat {
  failures: number
  lastError?: string
  lastAt?: IsoTime
}

const SAFE_MODE_THRESHOLD = 5

export class Runtime {
  private readonly ctx: Context
  private readonly rawConfig: unknown
  private readonly logger: AppLogger
  private readonly health = new HealthRegistry()
  private readonly clock: Clock = { now: () => nowIso() }

  private config?: RuntimeConfig
  private store?: ReturnType<typeof openStore>
  private effects?: ReturnType<typeof createEffects>
  private outbox?: ReturnType<typeof createOutbox>
  private engine?: Engine
  private policy?: MutablePolicy
  private sessions?: Sessions
  private executor?: Executor
  private assessor?: Assessor
  private watchdog?: Watchdog
  private sources?: SourcesManager
  private releaseLock?: () => Promise<void>
  private apiDispose?: () => void
  private apiDeps?: ApiDeps
  private setupService?: SetupService
  /** Serialized heartbeat writes; awaited during shutdown so teardown is clean. */
  private heartbeatQueue: Promise<void> = Promise.resolve()

  private readonly timers = new Set<ReturnType<typeof setInterval>>()
  private stopped = false
  private stopping?: Promise<void>
  private passBusy = false
  private consecutiveEngineErrors = 0
  private readonly effectStats = new Map<string, EffectStat>()
  private safeMode = false
  private safeModeReason?: string
  private paused = false
  private lifecycle: 'starting' | 'ready' | 'degraded' | 'stopped' = 'starting'
  private statusDetail?: string
  private startedAt = nowIso()

  readonly ready: Promise<void>
  private readonly overrides: RuntimeOverrides
  private ownsStore = true

  constructor(ctx: Context, rawConfig: unknown, overrides: RuntimeOverrides = {}) {
    this.ctx = ctx
    this.rawConfig = rawConfig
    this.overrides = overrides
    this.logger = createLogger(ctx)
    const resolved = validateConfig(rawConfig)
    if (resolved.problem) {
      this.lifecycle = 'degraded'
      this.statusDetail = resolved.problem.error
      this.health.set('runtime', 'error', resolved.problem.error)
      this.logger.error('invalid configuration; SuperAgent stays inert', { error: resolved.problem.error })
      this.ready = Promise.resolve()
      return
    }
    this.config = resolved.config
    this.health.set('runtime', 'starting')
    this.ready = this.initialize().catch((error: unknown) => {
      this.lifecycle = 'degraded'
      this.statusDetail = errorMessage(error)
      this.health.fail('runtime', error)
      this.logger.error('SuperAgent failed to initialize; the DSH host is unaffected', { error: errorMessage(error) })
    })
  }

  /** The Engine instance (diagnostics and tests; the single writer of domain state). */
  get enginePort(): Engine | undefined {
    return this.engine
  }

  /**
   * Final lifecycle state after `ready` settles: `ready` means every required
   * component was initialized; `degraded` means startup failed or safe mode was
   * entered. The plugin entry (`src/engine.ts`) turns a non-ready runtime into a
   * thrown start() so the guardian reports `degraded` instead of `ready`.
   */
  get status(): 'starting' | 'ready' | 'degraded' | 'stopped' {
    return this.lifecycle
  }

  /** Human-readable failure detail (never contains credentials; redacted on throw). */
  get detail(): string | undefined {
    return this.statusDetail ?? this.safeModeReason
  }

  /** The API implementation handed to `registerApi`. */
  get api(): ApiDeps {
    if (!this.apiDeps) {
      this.apiDeps = {
        state: () => this.buildState(),
        action: request => this.handleAction(request),
        ...(this.setupService ? { setup: this.setupService } : {}),
        logger: this.logger,
      }
    }
    return this.apiDeps
  }

  // -- lifecycle -----------------------------------------------------------

  private async initialize(): Promise<void> {
    const config = this.config
    if (!config) return
    this.startedAt = nowIso()
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 })
    if (!this.overrides.skipLock) this.releaseLock = await this.acquireLock(config.stateDir)
    if (this.overrides.store) {
      this.store = this.overrides.store as ReturnType<typeof openStore>
      this.ownsStore = false
    } else {
      this.store = openStore({ stateDir: config.stateDir })
    }
    this.paused = this.readPaused()
    this.policy = new MutablePolicy(buildPolicy(config, this.paused))

    // Load role prompts off the first model step's path; failures fall back to
    // the embedded copies and never block startup.
    try {
      await preloadPrompts()
    } catch (error) {
      this.logger.warn('could not preload role prompts; embedded prompts will be used', { error: errorMessage(error) })
    }

    const effects = createEffects({
      store: this.store,
      logger: this.logger,
    })
    this.effects = effects

    const sourceScope: SourceScopePort = {
      channelAllowed: channel => this.sources?.channelAllowed(channel) ?? false,
      send: message => this.sources?.send(message) ?? Promise.resolve('failed' as SendOutcome),
    }
    this.outbox = createOutbox({ store: this.store, effects, sourceScope, logger: this.logger })

    this.engine = createEngine({
      store: this.store,
      policy: this.policy,
      effects,
      outbox: this.outbox,
      clock: this.clock,
      logger: this.logger,
      assessor: () => this.assessor as unknown as AssessorPort,
      executor: () => this.executor as unknown as ExecutorPort,
      acknowledgeOnAccept: config.acknowledgeOnAccept === true,
      ...(config.quiet?.maxChars !== undefined || config.quiet?.minChars !== undefined
        ? { maxMessageChars: config.quiet?.maxChars ?? config.quiet?.minChars }
        : {}),
    })

    const host = hostServices(this.ctx)
    const sessionOptions: SessionsOptions = {
      agents: host.agents,
      ...(host.presets ? { presets: host.presets } : {}),
      ...(host.persistence ? { persistence: host.persistence } : {}),
      logger: this.logger,
      kv: this.store.kv,
      now: () => this.clock.now(),
      presetIds: { router: 'superagent-router', worker: 'superagent-worker' },
      ...(config.executor?.model
        ? { agentOptions: { ...(config.executor.provider ? { provider: config.executor.provider } : {}), model: config.executor.model } }
        : {}),
      maxWorkers: config.executor?.maxWorkers ?? 2,
      createTimeoutMs: 60_000,
      decorate: (agentCtx, info) => this.decorateAgent(agentCtx, info),
      onTurnEnd: info => this.onTurnEnd(info),
      onTurnError: (info, error) => {
        this.logger.warn('a session turn failed', { sessionId: String(info.sessionId), error: errorMessage(error) })
      },
    }
    this.sessions = new Sessions(sessionOptions)

    this.assessor = new Assessor({
      sessions: this.sessions,
      engine: () => this.engine!.mainSession,
      policy: () => this.policy!.current(),
      logger: this.logger,
    })

    this.executor = new Executor({
      store: this.store,
      sessions: this.sessions,
      engine: () => this.engine!.executor,
      effects,
      logger: this.logger,
      stateDir: config.stateDir,
      now: () => this.clock.now(),
      config: {
        ...(config.executor?.prepare ? { prepare: config.executor.prepare } : {}),
        ...(config.executor?.cloneUrl ? { cloneUrl: config.executor.cloneUrl } : {}),
        ...(config.executor?.clone !== undefined ? { clone: config.executor.clone } : {}),
        ...(config.executor?.defaultRepo ? { defaultRepo: config.executor.defaultRepo } : {}),
        ...(config.executor?.prepareTimeoutMs ? { prepareTimeoutMs: config.executor.prepareTimeoutMs } : {}),
        ...(config.executor?.gitTimeoutMs ? { gitTimeoutMs: config.executor.gitTimeoutMs } : {}),
      },
    })

    this.watchdog = new Watchdog({
      store: this.store,
      executor: this.executor,
      engine: () => this.engine!,
      effects,
      logger: this.logger,
      now: () => this.clock.now(),
      isPaused: () => this.paused || this.safeMode,
      reportHealth: (name, state, detail) => this.health.set(name, state, detail),
      config: {
        ...(config.watchdog?.stallMs ? { stallMs: config.watchdog.stallMs } : {}),
        ...(config.watchdog?.escalateMs ? { escalateMs: config.watchdog.escalateMs } : {}),
        ...(config.watchdog?.intervalMs ? { intervalMs: config.watchdog.intervalMs } : {}),
        ...(config.watchdog?.silentMs ? { silentMs: config.watchdog.silentMs } : {}),
        ...(config.watchdog?.silentMaxAttempts ? { silentMaxAttempts: config.watchdog.silentMaxAttempts } : {}),
      },
    })

    this.sources = new SourcesManager(this.health, this.logger)

    // Setup wizard backend (docs/002): token files, account state, configEditor.
    this.setupService = new SetupService({
      stateDir: config.stateDir,
      kv: this.store.kv,
      logger: this.logger,
      plugin: () => ({ status: this.effectiveStatus(), detail: this.statusDetail ?? null }),
      currentConfig: () => this.config as unknown as Record<string, unknown>,
      validateConfig: candidate => validateConfig(candidate).problem?.error,
      configEditor: () => this.ctx.get('configEditor') as ConfigEditorLike | undefined,
      hostEntry: () => (this.ctx as unknown as { fiber?: { entry?: unknown } }).fiber?.entry,
      redact: redactDetail,
    })
    // A fresh runtime means the previous setup edit already restarted us.
    this.setupService.markRestarted()

    // Effects handlers (the reply handler belongs to the Outbox).
    this.installEffectHandlers()

    // Management API (optional web server).
    try {
      this.apiDispose = registerApi(this.ctx, this.api)
    } catch (error) {
      this.logger.warn('could not register the management API', { error: errorMessage(error) })
    }

    // Router session: required for assessments and replies, retried in the background.
    await this.ensureRouter()

    // Sources.
    await this.createSources()

    // Timers first so recovery and passes are already owned when they start.
    this.installTimers()

    // Start the durable effect pump.
    try {
      effects.start()
      this.health.set('effects', 'ready')
    } catch (error) {
      this.health.fail('effects', error)
      this.logger.error('effect pump failed to start', { error: errorMessage(error) })
    }

    // Post-start work is detached and guarded: the host boot must not wait.
    void this.afterStart().catch((error: unknown) => {
      this.logger.error('post-start failed', { error: errorMessage(error) })
      this.health.fail('runtime', error)
    })

    this.lifecycle = 'ready'
    this.health.set('runtime', 'ready', 'started')
    this.writeHeartbeat()
    this.logger.info('SuperAgent runtime ready', { stateDir: config.stateDir, sources: this.sources.ids() })
  }

  private async afterStart(): Promise<void> {
    if (this.stopped) return
    await this.sources?.startAll()
    if (this.stopped) return
    try {
      await this.executor!.recover()
    } catch (error) {
      this.health.fail('executor', error)
      this.logger.warn('restart recovery failed', { error: errorMessage(error) })
    }
    this.writeHeartbeat()
  }

  private async ensureRouter(): Promise<boolean> {
    if (!this.sessions) return false
    try {
      await this.sessions.ensureRouter(this.config?.stateDir)
      this.health.set('sessions:router', 'ready')
      return true
    } catch (error) {
      this.health.fail('sessions:router', error)
      this.logger.warn('router session is not available yet; will retry', { error: errorMessage(error) })
      return false
    }
  }

  // -- wiring --------------------------------------------------------------

  private decorateAgent(agentCtx: Context, info: SessionInfo): void {
    const store = this.store
    const engine = this.engine
    const sessions = this.sessions
    if (!store || !engine || !sessions) return
    const github = this.config?.sources?.github
    const deps: ToolDeps = {
      engine,
      store,
      sessions,
      logger: this.logger,
      now: () => this.clock.now(),
      ...(github
        ? {
            github: {
              ...(typeof github.tokenFile === 'string' ? { tokenFile: github.tokenFile } : {}),
              ...(typeof github.tokenEnv === 'string' ? { tokenEnv: github.tokenEnv } : {}),
              ...(typeof github.apiBaseUrl === 'string' ? { apiBaseUrl: github.apiBaseUrl } : {}),
            },
          }
        : {}),
    }
    if (info.role === 'router') registerRouterTools(agentCtx, deps)
    else registerWorkerTools(agentCtx, deps)
  }

  private onTurnEnd(info: { role: 'router' | 'worker'; sessionId: unknown; ticketId?: TicketId; assignmentId?: string }): void {
    if (!this.engine || info.role !== 'worker' || !info.ticketId || !info.assignmentId) return
    try {
      this.engine.executor.turnEnded(info.ticketId, info.assignmentId)
    } catch (error) {
      this.logger.warn('could not record the turn end', { error: errorMessage(error) })
    }
  }

  private installEffectHandlers(): void {
    const effects = this.effects
    if (!effects) return
    effects.handle('assessment', this.wrapEffect('assessment', async payload => {
      const data = payload as { evalId?: string; triggerId?: string }
      if (!data?.evalId || !data.triggerId) return
      const candidate = this.engine!.candidateOf(data.triggerId)
      if (!candidate) return
      this.assessor!.deliver(candidate)
      this.engine!.mainSession.candidateDelivered(data.evalId)
    }))
    effects.handle('launch', this.wrapEffect('launch', async payload => {
      const data = payload as { ticketId?: string; assignmentId?: string }
      if (!data?.ticketId || !data.assignmentId) return
      const ticket = this.store!.tickets.get(data.ticketId)
      if (!ticket || ticket.state === 'ended') return
      const assignment = ticket.assignments.find(item => item.id === data.assignmentId)
      if (!assignment || assignment.state !== 'pending') return
      await this.executor!.launch(ticket, assignment)
    }))
    effects.handle('delivery', this.wrapEffect('delivery', async payload => {
      const data = payload as { ticketId?: string; assignmentId?: string; inputIds?: string[] }
      if (!data?.ticketId || !data.assignmentId) return
      const ticket = this.store!.tickets.get(data.ticketId)
      if (!ticket || ticket.state === 'ended') return
      const assignment = ticket.assignments.find(item => item.id === data.assignmentId)
      if (!assignment || assignment.state === 'ended') return
      const wanted = new Set(data.inputIds ?? [])
      const inputs = ticket.inputs.filter(input => !input.readAt && (wanted.size === 0 || wanted.has(input.id)))
      if (inputs.length === 0) return
      try {
        await this.executor!.deliver(ticket, assignment, inputs)
      } catch (error) {
        this.engine!.executor.deliveryFailed(data.ticketId, data.assignmentId, errorMessage(error))
        throw error
      }
    }))
    effects.handle('relay', this.wrapEffect('relay', async payload => {
      const data = payload as { code?: string; ticketId?: string; triggerId?: string; detail?: string }
      const text = [
        '[superagent relay]',
        `code: ${data.code ?? 'relay'}`,
        data.ticketId ? `ticket: ${data.ticketId}` : '',
        data.triggerId ? `trigger: ${data.triggerId}` : '',
        data.detail ? `detail: ${data.detail}` : '',
        'Read the ticket or thread if you need the full context.',
      ]
        .filter(Boolean)
        .join('\n')
      this.sessions!.deliverRouter(text, 'wake')
    }))
    effects.handle('notice', this.wrapEffect('notice', async payload => {
      const data = payload as { code?: string; ticketId?: string; detail?: string }
      this.logger.info('engine notice', { code: data.code, ticketId: data.ticketId, detail: data.detail })
      const detail = data.detail ? `: ${data.detail}` : ''
      this.sessions!.deliverRouter(
        `[superagent notice]\ncode: ${data.code ?? 'notice'}${data.ticketId ? `\nticket: ${data.ticketId}` : ''}${detail}`,
        'inject',
      )
    }))
  }

  private wrapEffect(kind: string, fn: (payload: unknown) => Promise<void>): (payload: unknown, row?: unknown) => Promise<void> {
    return async (payload: unknown) => {
      try {
        await fn(payload)
        this.effectStats.set(kind, { failures: 0 })
        this.health.set(`effects:${kind}`, 'ready')
      } catch (error) {
        const previous = this.effectStats.get(kind)
        const failures = (previous?.failures ?? 0) + 1
        this.effectStats.set(kind, { failures, lastError: errorMessage(error), lastAt: this.clock.now() })
        this.health.set(`effects:${kind}`, 'error', errorMessage(error))
        this.logger.warn('effect handler failed', { kind, failures, error: errorMessage(error) })
        if (failures >= SAFE_MODE_THRESHOLD) {
          this.enterSafeMode(`effect ${kind} failed ${failures} times: ${errorMessage(error)}`)
        }
        throw error
      }
    }
  }

  private installTimers(): void {
    const passInterval = Math.max(500, this.config?.passIntervalMs ?? 2_000)
    this.every(passInterval, () => {
      void this.pass('timer').catch(() => undefined)
    })
    const heartbeatInterval = Math.max(5_000, this.config?.heartbeatIntervalMs ?? 30_000)
    this.every(heartbeatInterval, () => this.writeHeartbeat())
    this.watchdog?.start()
  }

  private every(ms: number, run: () => void): void {
    const timer = setInterval(() => {
      if (this.stopped) return
      try {
        run()
      } catch (error) {
        this.logger.warn('timer callback failed', { error: errorMessage(error) })
      }
    }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }

  /** One Engine pass, guarded against re-entry and never throwing. */
  async pass(reason: string): Promise<void> {
    if (this.stopped || !this.engine || this.safeMode) return
    if (this.passBusy) return
    this.passBusy = true
    try {
      this.engine.evaluateDue()
      this.consecutiveEngineErrors = 0
      this.health.set('runtime', 'ready')
    } catch (error) {
      this.consecutiveEngineErrors += 1
      this.health.set('runtime', 'error', errorMessage(error))
      this.logger.warn('engine pass failed', {
        reason,
        consecutive: this.consecutiveEngineErrors,
        error: errorMessage(error),
      })
      if (this.consecutiveEngineErrors >= SAFE_MODE_THRESHOLD) {
        this.enterSafeMode(`engine pass failed ${this.consecutiveEngineErrors} times: ${errorMessage(error)}`)
      }
    } finally {
      this.passBusy = false
    }
  }

  /** Run one durable-effect pump (diagnostics/tests; the Effects loop does this normally). */
  async pumpEffects(): Promise<void> {
    if (this.stopped) return
    try {
      await this.effects?.pump()
    } catch (error) {
      this.logger.warn('effect pump failed', { error: errorMessage(error) })
    }
  }

  // -- safe mode -----------------------------------------------------------

  private enterSafeMode(reason: string): void {
    if (this.safeMode) return
    this.safeMode = true
    this.safeModeReason = reason
    this.statusDetail = `safe mode: ${reason}`
    this.health.set('runtime', 'error', `safe mode: ${reason}`)
    this.logger.error('entering SAFE MODE: sources and effects paused', { reason })
    runSafely(this.logger, 'persist safe mode', () => {
      this.store?.kv.set('superagent.safeMode', { reason, at: this.clock.now() })
    })
    void (async () => {
      try {
        await this.sources?.stopAll()
      } catch (error) {
        this.logger.warn('could not stop sources in safe mode', { error: errorMessage(error) })
      }
      try {
        await this.effects?.stop()
      } catch (error) {
        this.logger.warn('could not stop effects in safe mode', { error: errorMessage(error) })
      }
      this.writeHeartbeat()
      await this.notifyUser(`SuperAgent paused itself: ${reason}`)
    })().catch((error: unknown) => {
      this.logger.warn('safe mode transition failed', { error: errorMessage(error) })
    })
  }

  private exitSafeMode(): void {
    if (!this.safeMode) return
    this.safeMode = false
    this.safeModeReason = undefined
    this.consecutiveEngineErrors = 0
    for (const kind of this.effectStats.keys()) this.effectStats.set(kind, { failures: 0 })
    this.health.set('runtime', 'ready', 'resumed from safe mode')
    runSafely(this.logger, 'clear safe mode', () => {
      this.store?.kv.delete('superagent.safeMode')
    })
    try {
      this.effects?.start()
    } catch (error) {
      this.logger.warn('could not restart the effect pump', { error: errorMessage(error) })
    }
    void this.sources?.startAll().catch((error: unknown) => {
      this.logger.warn('could not restart sources after safe mode', { error: errorMessage(error) })
    })
    this.logger.info('left safe mode; sources and effects restarted')
  }

  /** Best-effort user notification; silent when no channel is configured. */
  private async notifyUser(text: string): Promise<void> {
    const source = this.sources?.get('telegram')
    const chat = this.config?.sources?.telegram?.allowedUserIds?.[0]
    if (!source || !chat) return
    try {
      const message: OutboundMessage = {
        id: `msg_${Date.now().toString(36)}safe`,
        purpose: 'notice',
        channel: { source: 'telegram', thread: `telegram:dm:${chat}`, to: chat },
        text: text.length > 200 ? `${text.slice(0, 199)}…` : text,
        markdown: 'plain',
        at: this.clock.now(),
      }
      await source.send(message)
    } catch (error) {
      this.logger.warn('could not notify the user about safe mode', { error: errorMessage(error) })
    }
  }

  // -- sources -------------------------------------------------------------

  private sourceLogger(id: string): AppLogger {
    return {
      debug: (message, extra) => this.logger.debug(`[${id}] ${message}`, extra),
      info: (message, extra) => this.logger.info(`[${id}] ${message}`, extra),
      warn: (message, extra) => this.logger.warn(`[${id}] ${message}`, extra),
      error: (message, extra) => this.logger.error(`[${id}] ${message}`, extra),
    }
  }

  private sourceContext(id: SourceId): Record<string, unknown> {
    return {
      id,
      stateDir: this.config!.stateDir,
      now: () => this.clock.now(),
      newId: (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      receive: (trigger: Trigger) => {
        try {
          return this.engine!.sources.receive(trigger)
        } catch (error) {
          this.logger.warn('engine.receive failed', { error: errorMessage(error) })
          return 'failed'
        }
      },
      logger: this.sourceLogger(id),
      health: (entry: { name?: string; state?: string; detail?: string }) => {
        const name = `sources:${entry.name ?? id}`
        const state = entry.state === 'error' ? 'error' : entry.state === 'starting' ? 'starting' : entry.state === 'off' ? 'off' : 'ready'
        this.health.set(name, state as 'ready', entry.detail)
      },
      kv: this.store!.kv,
    }
  }

  private telegramCommands(): Record<string, unknown> {
    return {
      status: async () => {
        const snapshot = this.buildState()
        const open = snapshot.tickets.active.length + snapshot.tickets.attention.length
        const sourceStates = snapshot.sources.map(source => `${source.id}:${source.health}`).join(' ')
        const state = snapshot.plugin.status
        return truncateCommand(
          `${state}${this.paused ? ' · paused' : ''} · ${open} ticket(s) · ${sourceStates || 'no sources'}`,
          100,
        )
      },
      pause: async () => {
        this.setPaused(true)
        return 'Paused. Existing tickets keep their state.'
      },
      resume: async () => {
        this.setPaused(false)
        if (this.safeMode) this.exitSafeMode()
        return 'Resumed.'
      },
      tickets: async () => {
        const snapshot = this.buildState()
        const active = snapshot.tickets.active.slice(0, 3).map(ticket => `${ticket.id} ${ticket.title}`)
        const attention = snapshot.tickets.attention.slice(0, 2).map(ticket => `${ticket.id} ${ticket.kind}`)
        return truncateCommand([...active, ...attention].join(' · ') || 'No open tickets.', 100)
      },
      stopTicket: async (ticketId: string) => {
        const ticket = this.store?.tickets.get(ticketId)
        if (!ticket) return `Ticket ${ticketId} not found.`
        this.engine!.people.stopTicket(ticketId, 'stopped from chat')
        return `Stopped ${truncateCommand(ticket.title, 60)}.`
      },
      retryTicket: async (ticketId: string) => {
        const ticket = this.store?.tickets.get(ticketId)
        if (!ticket) return `Ticket ${ticketId} not found.`
        this.engine!.people.retryTicket(ticketId)
        return `Retry queued for ${truncateCommand(ticket.title, 60)}.`
      },
    }
  }

  private githubCallbacks(): Record<string, unknown> {
    return {
      pullOpened: (pull: Record<string, unknown>) => {
        try {
          this.onPullOpened(pull)
        } catch (error) {
          this.logger.warn('github pullOpened callback failed', { error: errorMessage(error) })
        }
      },
      threadClosed: (thread: string, outcome: 'merged' | 'closed', at: IsoTime) => {
        try {
          this.engine!.sources.threadClosed(thread, outcome, at)
        } catch (error) {
          this.logger.warn('github threadClosed callback failed', { error: errorMessage(error) })
        }
      },
    }
  }

  private onPullOpened(pull: Record<string, unknown>): void {
    const branch = String(pull.head ?? pull.branch ?? pull.headBranch ?? '')
    const match = /^agent\/(.+)$/.exec(branch)
    const thread = typeof pull.thread === 'string' ? pull.thread : undefined
    if (!match || !thread) return
    const ticketId = match[1]!
    const ticket = this.store!.tickets.get(ticketId)
    if (!ticket || ticket.state === 'ended') return
    this.engine!.sources.bindThread(ticketId, { key: thread, source: 'github' }, true)
  }

  /**
   * Wizard-written secrets live in `<stateDir>/secrets/`; when the config does
   * not name a token source, fall back to that file if it exists (the
   * environment-variable path stays untouched otherwise).
   */
  private withDefaultSecretFile(kind: 'telegram' | 'github', config: Record<string, unknown>): Record<string, unknown> {
    if (typeof config.tokenFile === 'string' && config.tokenFile.length > 0) return config
    if (typeof config.tokenEnv === 'string' && config.tokenEnv.length > 0) return config
    const candidate = join(this.config!.stateDir, 'secrets', kind === 'telegram' ? 'telegram-token' : 'github-token')
    try {
      if (existsSync(candidate)) return { ...config, tokenFile: candidate }
    } catch {
      // fall through: sources will report the missing token
    }
    return config
  }

  private async createSources(): Promise<void> {
    if (this.overrides.sources) {
      for (const entry of this.overrides.sources) this.sources!.add(entry.id, entry.source)
      return
    }
    const sources = this.config?.sources
    if (!sources) return
    if (sources.telegram?.enabled !== false) {
      try {
        const module = (await import('../sources/telegram.js')) as unknown as {
          createSource?: (config: Record<string, unknown>, ctx: Record<string, unknown>) => SourceLike
          kind?: { create: (config: Record<string, unknown>, ctx: Record<string, unknown>) => SourceLike }
        }
        const create = module.createSource ?? module.kind?.create
        if (!create) throw new Error('telegram source module exports no create function')
        const source = create(
          { ...this.withDefaultSecretFile('telegram', { ...sources.telegram }), commands: this.telegramCommands() },
          this.sourceContext('telegram'),
        )
        this.sources!.add('telegram', source)
      } catch (error) {
        this.health.fail('sources:telegram', error)
        this.logger.error('telegram source is unavailable', { error: errorMessage(error) })
      }
    }
    if (sources.github?.enabled !== false) {
      try {
        const module = (await import('../sources/github.js')) as unknown as {
          createSource?: (config: Record<string, unknown>, ctx: Record<string, unknown>) => SourceLike
          kind?: { create: (config: Record<string, unknown>, ctx: Record<string, unknown>) => SourceLike }
        }
        const create = module.createSource ?? module.kind?.create
        if (!create) throw new Error('github source module exports no create function')
        const source = create(
          { ...this.withDefaultSecretFile('github', { ...sources.github }), callbacks: this.githubCallbacks() },
          this.sourceContext('github'),
        )
        this.sources!.add('github', source)
      } catch (error) {
        this.health.fail('sources:github', error)
        this.logger.error('github source is unavailable', { error: errorMessage(error) })
      }
    }
  }

  // -- management API ------------------------------------------------------

  private readPaused(): boolean {
    try {
      return this.store?.kv.get<boolean>('superagent.paused') === true
    } catch {
      return false
    }
  }

  private setPaused(paused: boolean): void {
    this.paused = paused
    try {
      this.store?.kv.set('superagent.paused', paused)
    } catch {
      // best effort
    }
    try {
      this.engine?.people.pause(paused)
    } catch (error) {
      this.logger.warn('engine could not change the pause state', { error: errorMessage(error) })
    }
    this.health.set('runtime', 'ready', paused ? 'paused' : 'running')
    this.writeHeartbeat()
  }

  /** Snapshot for the panel; never throws. */
  buildState(): ApiState {
    const store = this.store
    const active: ApiState['tickets']['active'] = []
    const attention: ApiState['tickets']['attention'] = []
    if (store) {
      try {
        for (const ticket of store.tickets.open()) {
          const latest = ticket.assignments[ticket.assignments.length - 1]
          const stage =
            latest?.state === 'running'
              ? 'working'
              : latest?.state === 'pending'
                ? 'queued'
                : ticket.waitingForPerson
                  ? 'waiting'
                  : 'open'
          active.push({
            id: ticket.id,
            title: ticket.title,
            stage,
            lastReport: ticket.latestReport?.kind ?? null,
            at: ticket.updatedAt,
          })
          const report = ticket.latestReport
          if (report && (report.kind === 'blocked' || report.kind === 'ready' || report.kind === 'failed')) {
            attention.push({
              id: ticket.id,
              title: ticket.title,
              kind: report.kind,
              question: report.question ?? null,
              at: report.at,
            })
          }
        }
      } catch (error) {
        this.logger.warn('could not read tickets for the panel', { error: errorMessage(error) })
      }
    }
    return {
      ok: true,
      plugin: {
        status: this.effectiveStatus(),
        detail: this.statusDetail ?? this.safeModeReason ?? null,
        version: API_VERSION,
      },
      paused: this.paused,
      sources: this.sources?.healthSnapshot() ?? [],
      tickets: { active, attention },
      health: this.health.list().map(entry => ({
        name: entry.name,
        state: entry.state === 'error' ? 'error' : entry.state === 'degraded' ? 'degraded' : 'ready',
        detail: entry.detail ?? null,
      })),
    }
  }

  private effectiveStatus(): PluginStatus {
    if (this.safeMode) return 'degraded'
    return pluginStatus(this.lifecycle, this.health)
  }

  private async handleAction(request: ApiActionRequest): Promise<ApiActionValue> {
    try {
      switch (request.action) {
        case 'pause':
          this.setPaused(true)
          return { ok: true, result: 'paused' }
        case 'resume':
          this.setPaused(false)
          if (this.safeMode) this.exitSafeMode()
          return { ok: true, result: 'resumed' }
        case 'retry': {
          const ticket = this.store?.tickets.get(request.ticketId!)
          if (!ticket) return { ok: false, error: `ticket ${request.ticketId} not found` }
          this.engine!.people.retryTicket(ticket.id)
          this.logger.info('panel requested a retry', { ticketId: ticket.id })
          return { ok: true, result: `retry queued for ${ticket.id}` }
        }
        case 'stop': {
          const ticket = this.store?.tickets.get(request.ticketId!)
          if (!ticket) return { ok: false, error: `ticket ${request.ticketId} not found` }
          this.engine!.people.stopTicket(ticket.id, 'stopped from the panel')
          this.logger.info('panel requested a stop', { ticketId: ticket.id })
          return { ok: true, result: `stopped ${ticket.id}` }
        }
        case 'check': {
          const router = await this.ensureRouter()
          await this.pass('panel-check')
          const state = this.buildState()
          return {
            ok: true,
            result: [
              `status=${state.plugin.status}`,
              `router=${router ? 'live' : 'down'}`,
              `active=${state.tickets.active.length}`,
              `attention=${state.tickets.attention.length}`,
              `errors=${state.health.filter(entry => entry.state === 'error').map(entry => entry.name).join(',') || 'none'}`,
            ].join(' '),
          }
        }
        default:
          return { ok: false, error: 'unsupported action' }
      }
    } catch (error) {
      this.logger.warn('panel action failed', { action: request.action, error: errorMessage(error) })
      return { ok: false, error: errorMessage(error) }
    }
  }

  // -- heartbeat -----------------------------------------------------------

  private writeHeartbeat(): void {
    const stateDir = this.config?.stateDir
    if (!stateDir) return
    const body = {
      at: this.clock.now(),
      pid: process.pid,
      status: this.effectiveStatus(),
      safeMode: this.safeMode,
      paused: this.paused,
      version: API_VERSION,
      router: this.sessions?.routerLive ?? false,
      startedAt: this.startedAt,
      sources: this.sources?.healthSnapshot().map(source => ({ id: source.id, health: source.health })) ?? [],
    }
    const text = safeString(body)
    const write = async (): Promise<void> => {
      for (const name of ['superagent-heartbeat.json', 'heartbeat.json']) {
        const target = join(stateDir, name)
        const temp = `${target}.${process.pid}.tmp`
        try {
          await writeFile(temp, text, { mode: 0o600 })
          await rename(temp, target)
        } catch {
          // heartbeat is best effort; the watchdog also falls back to SQLite mtime
          try {
            await writeFile(target, text, { mode: 0o600 })
          } catch {
            // ignore
          }
        }
      }
    }
    this.heartbeatQueue = this.heartbeatQueue.then(write, write).catch(() => undefined)
  }

  // -- lock ----------------------------------------------------------------

  private async acquireLock(stateDir: string): Promise<() => Promise<void>> {
    try {
      const module = (await import('proper-lockfile')) as unknown as {
        default?: { lock: LockFn }
        lock?: LockFn
      }
      const lock = module.default?.lock ?? module.lock
      if (!lock) throw new Error('proper-lockfile has no lock()')
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await lock(stateDir, {
            realpath: false,
            stale: 120_000,
            update: 30_000,
            retries: 0,
            onCompromised: (error: Error) => {
              this.logger.error('state directory lock compromised; entering safe mode', { error: errorMessage(error) })
              this.enterSafeMode(`state directory lock compromised: ${errorMessage(error)}`)
            },
          })
        } catch (error) {
          if (attempt === 4) throw error
          await new Promise(resolve => {
            const timer = setTimeout(resolve, 300 * (attempt + 1))
            timer.unref?.()
          })
        }
      }
    } catch (error) {
      throw new Error(`could not lock the SuperAgent state directory ${stateDir}: ${errorMessage(error)}`)
    }
    throw new Error(`could not lock the SuperAgent state directory ${stateDir}`)
  }

  // -- stop ----------------------------------------------------------------

  /** Stop everything. Idempotent, never rejects. */
  stop(): Promise<void> {
    this.stopping ??= this.shutdown()
    return this.stopping
  }

  private async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.logger.info('SuperAgent runtime stopping')
    for (const timer of this.timers) clearInterval(timer)
    this.timers.clear()
    try {
      this.watchdog?.stop()
    } catch {
      // ignore
    }
    const steps: Array<[string, () => Promise<unknown> | unknown]> = [
      ['sources', async () => this.sources?.stopAll()],
      ['effects', async () => this.effects?.stop()],
      ['executor', () => this.executor?.stop()],
      ['sessions', async () => this.sessions?.stop('runtime stopped')],
      ['api', () => this.apiDispose?.()],
      ['store', () => (this.ownsStore ? this.store?.close() : undefined)],
    ]
    for (const [name, run] of steps) {
      try {
        await withTimeout(Promise.resolve(run()), 15_000, `${name} shutdown`)
      } catch (error) {
        this.logger.warn(`shutdown step failed: ${name}`, { error: errorMessage(error) })
      }
    }
    try {
      await this.releaseLock?.()
    } catch (error) {
      this.logger.warn('could not release the state directory lock', { error: errorMessage(error) })
    }
    this.releaseLock = undefined
    this.lifecycle = 'stopped'
    this.health.set('runtime', 'off', 'stopped')
    this.writeHeartbeat()
    this.logger.info('SuperAgent runtime stopped')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LockFn = (
  file: string,
  options: Record<string, unknown>,
) => Promise<() => Promise<void>>

function createLogger(ctx: Context): AppLogger {
  const logger = ctx.logger as
    | {
        debug?: (message: string) => void
        info?: (message: string) => void
        warn?: (message: string) => void
        error?: (message: string) => void
      }
    | undefined
  const emit = (level: 'debug' | 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void => {
    const suffix = extra && Object.keys(extra).length > 0 ? ` ${safeString(extra)}` : ''
    try {
      logger?.[level]?.(`${message}${suffix}`)
    } catch {
      // logging must never throw
    }
  }
  return {
    debug: (message, extra) => emit('debug', message, extra),
    info: (message, extra) => emit('info', message, extra),
    warn: (message, extra) => emit('warn', message, extra),
    error: (message, extra) => emit('error', message, extra),
  }
}

function truncateCommand(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text
}

/**
 * Redact credential-looking substrings from a failure detail before it reaches
 * the guardian log or a thrown error. Failure details can quote configuration
 * or provider errors; tokens must never leave the runtime.
 */
export function redactDetail(text: string, limit = 500): string {
  let redacted = text
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[redacted-token]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted-token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted-token]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
    .replace(/((?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
  if (redacted.length > limit) redacted = `${redacted.slice(0, Math.max(0, limit - 1))}…`
  return redacted
}

/** Start a runtime and resolve once it is ready (or degraded). */
export async function startRuntime(ctx: Context, rawConfig: unknown): Promise<RuntimeHandle & { runtime: Runtime }> {
  const runtime = new Runtime(ctx, rawConfig)
  await runtime.ready
  return {
    runtime,
    stop: () => runtime.stop(),
  }
}
