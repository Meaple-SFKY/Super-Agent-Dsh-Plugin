/**
 * Shared fixtures for the core-engine, store, effects and outbox tests.
 *
 * Everything here is in-memory and deterministic: a `FakeClock`, a mutable
 * Policy provider, recording effects/outbox and a recording executor. The
 * domain tests use `createMemoryStore()`; the SQLite contract tests build their
 * own store.
 */

import { createEngine } from '../src/core/engine.js'
import type { Engine, ExecutorPort, EffectsPort, OutboxPort, PolicyProvider } from '../src/core/ports.js'
import type {
  Assignment,
  ChannelAddress,
  EffectKind,
  Input,
  IsoTime,
  OutboundMessage,
  Policy,
  Report,
  Ticket,
  TicketId,
  ThreadRef,
  Trigger,
} from '../src/core/model.js'
import type { EffectRow } from '../src/core/stores.js'
import { createMemoryStore } from '../src/app/store.js'

export class FakeClock {
  private time: number

  constructor(start: IsoTime = '2026-01-01T00:00:00.000Z') {
    this.time = Date.parse(start)
  }

  now(): IsoTime {
    return new Date(this.time).toISOString()
  }

  advance(milliseconds: number): IsoTime {
    this.time += milliseconds
    return this.now()
  }

  set(at: IsoTime): IsoTime {
    this.time = Date.parse(at)
    return this.now()
  }
}

export class MutablePolicy implements PolicyProvider {
  policy: Policy

  constructor(policy: Policy) {
    this.policy = policy
  }

  current(): Policy {
    return this.policy
  }

  set(policy: Policy): void {
    this.policy = policy
  }
}

/** A policy that admits one person on both Sources and one GitHub bot. */
export function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: 'policy-1',
    mode: 'auto',
    rules: [],
    sources: {
      telegram: { allowed: [{ id: 'u1', name: 'You' }], bots: [] },
      github: {
        allowed: [{ id: 'u1', name: 'You' }],
        bots: [{ id: 'ci-bot', name: 'CI' }],
        repositories: ['owner/repo'],
      },
    },
    paused: false,
    evalTimeoutMs: 60_000,
    ...overrides,
  }
}

export interface TriggerOptions {
  id?: string
  source?: string
  threadKey?: string
  at?: IsoTime
  actorId?: string
  bot?: boolean
  addressed?: Trigger['addressed']
  text?: string
  kind?: string
  meta?: Record<string, unknown>
  correlations?: ThreadRef[]
}

let triggerSequence = 0

export function makeTrigger(options: TriggerOptions = {}): Trigger {
  triggerSequence += 1
  const source = options.source ?? 'telegram'
  const threadKey = options.threadKey ?? 'chat-1'
  return {
    id: options.id ?? `tr_${triggerSequence}`,
    source,
    kind: options.kind ?? 'message',
    at: options.at ?? '2026-01-01T00:00:00.000Z',
    thread: { key: threadKey, source, label: `thread ${threadKey}` },
    ...(options.correlations === undefined ? {} : { correlations: options.correlations }),
    actor: { id: options.actorId ?? 'u1', name: 'You', ...(options.bot === true ? { bot: true } : {}) },
    addressed: options.addressed ?? 'direct',
    text: options.text ?? 'please do the thing',
    channel: { source, thread: threadKey, to: threadKey },
    meta: options.meta ?? {},
  }
}

export function makeGithubTrigger(options: TriggerOptions = {}): Trigger {
  return makeTrigger({ source: 'github', threadKey: 'owner/repo#1', addressed: 'none', ...options })
}

/** Records enqueued effects so domain tests can inspect payloads. */
export class RecordingEffects implements EffectsPort {
  entries: Array<{ kind: EffectKind; key: string; payload: unknown }> = []

  enqueue(kind: EffectKind, key: string, payload: unknown): void {
    const index = this.entries.findIndex(entry => entry.kind === kind && entry.key === key)
    if (index >= 0) this.entries[index] = { kind, key, payload }
    else this.entries.push({ kind, key, payload })
  }

  remove(kind: EffectKind, key: string): void {
    this.entries = this.entries.filter(entry => !(entry.kind === kind && entry.key === key))
  }

  list(kind?: EffectKind): Array<{ kind: EffectKind; key: string; payload: unknown }> {
    return kind === undefined ? [...this.entries] : this.entries.filter(entry => entry.kind === kind)
  }

  clear(): void {
    this.entries = []
  }
}

/** Records Channel writes. */
export class RecordingOutbox implements OutboxPort {
  messages: OutboundMessage[] = []

  queue(message: OutboundMessage): void {
    this.messages.push(message)
  }
}

export class RecordingExecutor implements ExecutorPort {
  launches: Array<{ ticketId: TicketId; assignmentId: string }> = []
  deliveries: Array<{ ticketId: TicketId; assignmentId: string; inputIds: string[] }> = []
  statusRequests: Array<{ ticketId: TicketId; assignmentId: string }> = []
  interrupts: Array<{ ticketId: TicketId; assignmentId: string; reason: string }> = []
  statusAnswer = true

  launch(ticket: Ticket, assignment: Assignment): void {
    this.launches.push({ ticketId: ticket.id, assignmentId: assignment.id })
  }

  deliver(ticket: Ticket, assignment: Assignment, inputs: Input[]): void {
    this.deliveries.push({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      inputIds: inputs.map(input => input.id),
    })
  }

  requestStatus(ticket: Ticket, assignment: Assignment): boolean {
    this.statusRequests.push({ ticketId: ticket.id, assignmentId: assignment.id })
    return this.statusAnswer
  }

  interrupt(ticketId: TicketId, assignmentId: string, reason: string): void {
    this.interrupts.push({ ticketId, assignmentId, reason })
  }
}

export const silentLogger = {
  warn(_message: string, _extra?: Record<string, unknown>): void {
    // Tests opt in to a loud logger when they investigate a failure.
  },
}

export interface Harness {
  store: ReturnType<typeof createMemoryStore>
  clock: FakeClock
  policy: MutablePolicy
  effects: RecordingEffects
  outbox: RecordingOutbox
  executor: RecordingExecutor
  engine: Engine
}

export function makeHarness(options: { policy?: Policy; acknowledgeOnAccept?: boolean; evalTimeoutMs?: number } = {}): Harness {
  const store = createMemoryStore()
  const clock = new FakeClock()
  const basePolicy = options.policy ?? makePolicy()
  if (options.evalTimeoutMs !== undefined) basePolicy.evalTimeoutMs = options.evalTimeoutMs
  const policy = new MutablePolicy(basePolicy)
  const effects = new RecordingEffects()
  const outbox = new RecordingOutbox()
  const executor = new RecordingExecutor()
  const engine = createEngine({
    store,
    clock,
    policy,
    effects,
    outbox,
    executor,
    logger: silentLogger,
    acknowledgeOnAccept: options.acknowledgeOnAccept ?? false,
    ...(options.evalTimeoutMs === undefined ? {} : { evalTimeoutMs: options.evalTimeoutMs }),
  })
  return { store, clock, policy, effects, outbox, executor, engine }
}

// ---------------------------------------------------------------------------
// Small builders used by the ticket tests
// ---------------------------------------------------------------------------

export function makeAssignment(ticketId: TicketId, overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: 'as_1',
    ticketId,
    state: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    kind: 'progress',
    summary: 'working on it',
    at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export function makeChannel(source = 'telegram', thread = 'chat-1', to = thread): ChannelAddress {
  return { source, thread, to }
}

export function effectPayload<T>(harness: Harness, kind: EffectKind): T | undefined {
  return harness.effects.list(kind)[0]?.payload as T | undefined
}

export type { EffectRow }
export { createMemoryStore }
