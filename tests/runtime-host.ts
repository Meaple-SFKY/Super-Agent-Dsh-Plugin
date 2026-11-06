/**
 * A simulated DSH host for runtime tests.
 *
 * Implements only the services the SuperAgent runtime actually uses:
 *   agents (create/resume/get), agentPresets (list/mount), sessionPersistence
 *   (stat), tools (scoped register), systemPrompt (scoped section), webServer
 *   (register) and a logger.
 *
 * Agents are fake: a message sent with followup/steer/inject is recorded as
 * plain text, status transitions can be simulated with `emitStatus`, and the
 * scoped tools/prompt registrations are inspectable so a test can drive the
 * Router/Worker tools like the model would.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as brandSessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

export interface FakeMessage {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'user' }
}

export function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ type: string; text?: string }> })?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text')
    .map(part => part.text ?? '')
    .join('')
}

export class FakeSystemPrompt {
  readonly sections: Array<{ name: string; order: number; text: string; interpolate?: boolean }> = []

  section(section: { name: string; order: number; text: string; interpolate?: boolean }): () => void {
    this.sections.push(section)
    return () => {
      const index = this.sections.findIndex(entry => entry.name === section.name)
      if (index >= 0) this.sections.splice(index, 1)
    }
  }

  getSectionOrder(_name: string): number {
    return 0
  }
}

export class FakeToolRegistry {
  readonly definitions = new Map<string, ToolDefinition>()

  register(definition: ToolDefinition): () => void {
    if (this.definitions.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
    this.definitions.set(definition.name, definition)
    return () => {
      this.definitions.delete(definition.name)
    }
  }

  names(): string[] {
    return [...this.definitions.keys()]
  }
}

export class FakeAgentContext {
  readonly tools = new FakeToolRegistry()
  readonly systemPrompt = new FakeSystemPrompt()
  private readonly listeners = new Map<string, Array<(payload: unknown) => void>>()
  private readonly agentPresets: FakeAgentPresets | undefined

  constructor(agentPresets?: FakeAgentPresets) {
    this.agentPresets = agentPresets
  }

  get(name: string): unknown {
    if (name === 'tools') return this.tools
    if (name === 'systemPrompt') return this.systemPrompt
    if (name === 'agentPresets') return this.agentPresets
    return undefined
  }

  on(event: string, listener: (payload: unknown) => void): () => void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return () => {
      const current = this.listeners.get(event) ?? []
      const index = current.indexOf(listener)
      if (index >= 0) current.splice(index, 1)
    }
  }

  emit(event: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload)
  }
}

export class FakeAgent {
  readonly id: SessionId
  readonly session: { id: SessionId }
  readonly ctx: FakeAgentContext
  readonly followups: FakeMessage[] = []
  readonly steers: FakeMessage[] = []
  readonly injects: FakeMessage[] = []
  readonly cancels: Array<{ cause: unknown; options: unknown }> = []
  status: 'idle' | 'running' = 'idle'
  disposeCalls = 0
  readonly options: Record<string, unknown>
  modelSelection: unknown
  readonly modelSelections: unknown[] = []
  readonly model: { current: () => unknown; select: (selection: unknown) => void }

  constructor(
    id: SessionId,
    ctx: FakeAgentContext,
    options: Record<string, unknown> = {},
    initialModel?: unknown,
    onSelect?: (selection: unknown) => void,
  ) {
    this.id = id
    this.session = { id }
    this.ctx = ctx
    this.options = options
    this.modelSelection = initialModel
    this.model = {
      current: () => this.modelSelection,
      select: (selection: unknown) => {
        this.modelSelection = selection
        this.modelSelections.push(selection)
        onSelect?.(selection)
      },
    }
  }

  followup(message: FakeMessage): void {
    this.followups.push(message)
    this.status = 'running'
    this.ctx.emit('agent/status', { agent: this, status: 'running' })
  }

  steer(message: FakeMessage): void {
    this.steers.push(message)
  }

  inject(message: FakeMessage): void {
    this.injects.push(message)
  }

  cancel(cause: unknown, options: unknown): void {
    this.cancels.push({ cause, options })
    this.status = 'idle'
    this.ctx.emit('agent/status', { agent: this, status: 'idle' })
  }

  async whenIdle(): Promise<void> {
    // The fake agent is quiescent as soon as a turn is aborted.
  }

  /** Simulate the model finishing its turn. */
  completeTurn(): void {
    this.status = 'idle'
    this.ctx.emit('agent/status', { agent: this, status: 'idle' })
  }

  /** Simulate a turn failure. */
  failTurn(error: Error): void {
    this.ctx.emit('agent/error', { agent: this, turn: 1, step: 0, error })
    this.completeTurn()
  }

  lastText(): string {
    const all = [...this.followups, ...this.steers, ...this.injects]
    return all.length > 0 ? textOf(all[all.length - 1]) : ''
  }

  allText(): string[] {
    return [...this.followups, ...this.steers, ...this.injects].map(textOf)
  }
}

export class FakeAgentRegistry {
  readonly live = new Map<string, FakeAgent>()
  readonly persisted = new Set<string>()
  /** Durable model selections keyed by session id (survives {@link restart}). */
  readonly selections = new Map<string, unknown>()
  readonly created: Array<{ sessionId: string; setup?: boolean; cwd?: string; agentOptions?: Record<string, unknown> }> = []
  readonly resumed: Array<{ sessionId: string; setup?: boolean }> = []
  readonly handles: Array<{ agent: FakeAgent; dispose: () => Promise<void> }> = []
  private readonly presets: FakeAgentPresets | undefined

  constructor(presets?: FakeAgentPresets) {
    this.presets = presets
  }

  get(id: SessionId): Agent | undefined {
    return this.live.get(String(id)) as unknown as Agent | undefined
  }

  liveAgent(id: string): FakeAgent | undefined {
    return this.live.get(id)
  }

  async create(options: {
    sessionId: SessionId
    meta?: { cwd?: string; agentPreset?: string }
    agentOptions?: Record<string, unknown>
    setup?: (ctx: Context, agent: Agent) => Promise<void> | void
  }): Promise<{ agent: Agent; dispose: () => Promise<void> }> {
    const sessionId = String(options.sessionId)
    if (this.live.has(sessionId)) throw new Error(`agent ${sessionId} already live`)
    const agent = new FakeAgent(
      brandSessionId(sessionId),
      new FakeAgentContext(this.presets),
      options.agentOptions ?? {},
      this.selections.get(sessionId),
      selection => this.selections.set(sessionId, selection),
    )
    this.created.push({
      sessionId,
      setup: options.setup !== undefined,
      ...(options.meta?.cwd ? { cwd: options.meta.cwd } : {}),
      ...(options.agentOptions ? { agentOptions: options.agentOptions as Record<string, unknown> } : {}),
    })
    await options.setup?.(agent.ctx as unknown as Context, agent as unknown as Agent)
    this.live.set(sessionId, agent)
    this.persisted.add(sessionId)
    const dispose = async (): Promise<void> => {
      agent.disposeCalls += 1
      this.live.delete(sessionId)
    }
    this.handles.push({ agent, dispose })
    return { agent: agent as unknown as Agent, dispose }
  }

  async resume(options: {
    resumeSessionId: SessionId
    setup?: (ctx: Context, agent: Agent) => Promise<void> | void
  }): Promise<{ agent: Agent; dispose: () => Promise<void> }> {
    const sessionId = String(options.resumeSessionId)
    if (!this.persisted.has(sessionId)) throw new Error(`session ${sessionId} not found`)
    if (this.live.has(sessionId)) {
      const existing = this.live.get(sessionId)!
      return { agent: existing as unknown as Agent, dispose: async () => undefined }
    }
    const agent = new FakeAgent(
      brandSessionId(sessionId),
      new FakeAgentContext(this.presets),
      {},
      this.selections.get(sessionId),
      selection => this.selections.set(sessionId, selection),
    )
    this.resumed.push({ sessionId, setup: options.setup !== undefined })
    await options.setup?.(agent.ctx as unknown as Context, agent as unknown as Agent)
    this.live.set(sessionId, agent)
    const dispose = async (): Promise<void> => {
      agent.disposeCalls += 1
      this.live.delete(sessionId)
    }
    this.handles.push({ agent, dispose })
    return { agent: agent as unknown as Agent, dispose }
  }

  /** Simulate a host restart: drop every live agent but keep persistence. */
  restart(): void {
    this.live.clear()
  }
}

export class FakeAgentPresets {
  readonly mounted: Array<{ sessionId?: string; presetId?: string }> = []
  rows: Array<{ id: string; name?: string; isDefault: boolean; broken?: string }> = [
    { id: 'superagent-router', isDefault: false },
    { id: 'superagent-worker', isDefault: false },
  ]
  private sequence = 0

  async list(): Promise<readonly { id: string; name?: string; isDefault: boolean; broken?: string }[]> {
    return this.rows
  }

  async mount(ctx: unknown, id?: string): Promise<{ id: string }> {
    const presetId = id ?? this.rows.find(row => row.isDefault)?.id ?? 'default'
    this.mounted.push({ presetId, ...(ctx ? {} : {}) })
    this.sequence += 1
    return { id: presetId }
  }
}

export class FakeSessionPersistence {
  constructor(private readonly agents: FakeAgentRegistry) {}

  async stat(id: SessionId): Promise<unknown | undefined> {
    return this.agents.persisted.has(String(id)) ? { id: String(id) } : undefined
  }
}

export interface FakeRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}

export class FakeWebServer {
  readonly routes: FakeRoute[] = []

  register(route: FakeRoute): () => void {
    this.routes.push(route)
    return () => {
      const index = this.routes.indexOf(route)
      if (index >= 0) this.routes.splice(index, 1)
    }
  }

  route(path: string): FakeRoute | undefined {
    return this.routes.find(entry => entry.path === path)
  }
}

/** A logger that records lines so tests can assert on diagnostics. */
export class RecordingLogger {
  readonly lines: Array<{ level: string; message: string; extra?: Record<string, unknown> }> = []

  private push(level: string, message: string, extra?: Record<string, unknown>): void {
    this.lines.push({ level, message, ...(extra ? { extra } : {}) })
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.push('debug', message, extra)
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.push('info', message, extra)
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.push('warn', message, extra)
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this.push('error', message, extra)
  }

  text(): string {
    return this.lines.map(line => `${line.level} ${line.message}`).join('\n')
  }
}

export interface FakeHost {
  ctx: FakeRootContext
  agents: FakeAgentRegistry
  presets: FakeAgentPresets
  persistence: FakeSessionPersistence
  webServer: FakeWebServer
  logger: RecordingLogger
  toolsFor(agent: FakeAgent): FakeToolRegistry
  promptFor(agent: FakeAgent): FakeSystemPrompt
  /** Execute a scoped tool the way the agent loop would. */
  executeTool(agent: FakeAgent, name: string, args: unknown): Promise<{ value: unknown }>
}

/** The plugin-facing root context: `ctx.get(name)`, `ctx.logger`. */
export class FakeRootContext {
  readonly logger: RecordingLogger
  private readonly services: Record<string, unknown>

  constructor(services: Record<string, unknown>, logger: RecordingLogger) {
    this.services = services
    this.logger = logger as unknown as RecordingLogger
  }

  get(name: string): unknown {
    return this.services[name]
  }

  on(): () => void {
    return () => undefined
  }

  effect(): () => void {
    return () => undefined
  }
}

export function createFakeHost(
  options: {
    presets?: boolean
    webServer?: boolean
    logger?: RecordingLogger
    /** Simulate the DSH `agentDefaultModel` service. */
    defaultModel?: { provider: string; model: string; reasoningEffort?: string }
  } = {},
): FakeHost {
  const logger = options.logger ?? new RecordingLogger()
  const presets = new FakeAgentPresets()
  const agents = new FakeAgentRegistry(options.presets === false ? undefined : presets)
  const persistence = new FakeSessionPersistence(agents)
  const webServer = new FakeWebServer()
  const services: Record<string, unknown> = {
    agents,
    sessionPersistence: persistence,
    ...(options.presets === false ? {} : { agentPresets: presets }),
    ...(options.webServer === false ? {} : { webServer }),
    ...(options.defaultModel
      ? { agentDefaultModel: { currentSelection: () => ({ ...options.defaultModel }) } }
      : {}),
  }
  const ctx = new FakeRootContext(services, logger)
  const host: FakeHost = {
    ctx,
    agents,
    presets,
    persistence,
    webServer,
    logger,
    toolsFor: agent => agent.ctx.tools,
    promptFor: agent => agent.ctx.systemPrompt,
    async executeTool(agent, name, args) {
      const definition = agent.ctx.tools.definitions.get(name)
      if (!definition) throw new Error(`tool ${name} is not registered for ${String(agent.id)}`)
      const exec = {
        agent: agent as unknown as Agent,
        signal: new AbortController().signal,
        token: Symbol('exec'),
        callId: 'call-1',
        rootCallId: 'call-1',
        name,
        arguments: args,
        deferContext: () => undefined,
        concludeTurn: () => undefined,
      } as unknown as ToolRunContext
      const value = await definition.execute(args, exec)
      return { value }
    },
  }
  return host
}

/** Poll a condition until it holds (or the deadline passes). */
export async function until(condition: () => boolean, timeoutMs = 4_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (!condition()) throw new Error(`timed out waiting for ${label}`)
}

/** A Source double: records sends and lifecycle calls. */
export class FakeSource {
  readonly id: string
  readonly kind = 'fake'
  readonly sent: Array<{ text: string; channel: unknown; purpose: string }> = []
  started = 0
  stopped = 0
  allow = true
  sendOutcome: 'sent' | 'failed' | 'gone' | 'waiting' = 'sent'

  constructor(id = 'telegram') {
    this.id = id
  }

  async start(): Promise<void> {
    this.started += 1
  }

  async stop(): Promise<void> {
    this.stopped += 1
  }

  async send(message: { text: string; channel: unknown; purpose: string }): Promise<'sent' | 'failed' | 'gone' | 'waiting'> {
    this.sent.push({ text: message.text, channel: message.channel, purpose: message.purpose })
    return this.sendOutcome
  }

  channelAllowed(): boolean {
    return this.allow
  }
}
