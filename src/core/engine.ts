/**
 * The domain Engine.
 *
 * One synchronous class implements every role of `src/core/ports.ts`. A
 * command changes its aggregates inside one `Store.atomic()` transaction;
 * external work (a model assessment, a launch, a delivery, a relay, a Channel
 * write) is enqueued as a durable effect in the same transaction and performed
 * by an adapter after commit. Every public method catches its own errors and
 * logs them: nothing thrown here may reach the host's event loop, because the
 * host turns an unhandled rejection into `process.exit(1)`.
 *
 * The rules implemented here follow `docs/000-architecture.md` §4–§7 and the
 * prototype's domain/execution documents, simplified where §4 says so (no
 * admission table, two strengths, accept modes; see `src/core/gate.ts`).
 *
 * Effect payloads are exported so Runtime's handlers can be written against
 * them without importing internals:
 *
 * - `assessment` → `{ evalId, triggerId }`: `candidateOf(triggerId)`, then
 *   `assessor.deliver(candidate)`, then `candidateDelivered(evalId)`.
 * - `launch` → `{ ticketId, assignmentId }`: launch the pending Assignment.
 * - `delivery` → `{ ticketId, assignmentId, inputIds }`: hand waiting Inputs to
 *   a running Assignment.
 * - `relay` / `notice` → main-Session messages.
 * - `reply` → owned by `src/app/outbox.ts`.
 */

import { randomUUID } from 'node:crypto'

import type {
  ActorRef,
  Assignment,
  Candidate,
  ChannelAddress,
  EvalRun,
  Input,
  IsoTime,
  Mandate,
  OutboundMessage,
  Policy,
  Reason,
  ReceiveDisposition,
  Report,
  ThreadOutcome,
  ThreadRef,
  ThreadState,
  Ticket,
  TicketEnd,
  TicketId,
  Trigger,
  TriggerId,
} from './model.js'
import type {
  AssessorPort,
  AssignmentReportedInput,
  AssignmentStartedInput,
  AttachInput,
  Clock,
  DecideInput,
  DecideResult,
  EffectsPort,
  Engine as EnginePort,
  EngineForExecutor,
  EngineForMainSession,
  EngineForPeople,
  EngineForSettings,
  EngineForSources,
  ExecutorPort,
  OutboxPort,
  PolicyProvider,
} from './ports.js'
import type { AppStore, Disposition } from './stores.js'
import { admitsInferred, gateBatch, policyEffects, revalidateMandate } from './gate.js'
import type { GateResult } from './gate.js'

// ---------------------------------------------------------------------------
// Effect payloads (shared with Runtime's handlers)
// ---------------------------------------------------------------------------

export interface AssessmentPayload {
  evalId: string
  triggerId: TriggerId
}

export interface LaunchPayload {
  ticketId: TicketId
  assignmentId: string
}

export interface DeliveryPayload {
  ticketId: TicketId
  assignmentId: string
  inputIds: string[]
}

export interface RelayPayload {
  code: string
  ticketId?: TicketId
  assignmentId?: string
  triggerId?: TriggerId
  detail?: string
}

export interface NoticePayload {
  code: string
  ticketId?: TicketId
  detail?: string
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface EngineLogger {
  warn(message: string, extra?: Record<string, unknown>): void
}

type Adapter<T> = T | (() => T)

/** Cancels a queued effect; `src/app/effects.ts` implements it. */
export interface EffectCanceller {
  remove(kind: 'assessment' | 'launch' | 'delivery' | 'relay' | 'notice' | 'reply', key: string): void
}

/** Withdraws pending Channel writes; `src/app/outbox.ts` implements it. */
export interface OutboxWithdrawer {
  withdraw(filter: { ticketId?: string; source?: string; reason: 'channelGone' | 'channelIgnored' }): number
}

export interface EngineDeps {
  store: AppStore
  policy: PolicyProvider
  effects: EffectsPort & Partial<EffectCanceller>
  outbox: OutboxPort & Partial<OutboxWithdrawer>
  clock?: Clock
  /** Convenience alternative to `clock`. */
  now?: () => IsoTime
  logger?: EngineLogger
  /** Reserved: assessment runs as a durable effect owned by Runtime. */
  assessor?: Adapter<AssessorPort>
  /** Needed for `requestStatus` and for interrupting a running Assignment. */
  executor?: Adapter<ExecutorPort>
  /** Send an acknowledgement Channel write on accept. Quiet by default. */
  acknowledgeOnAccept?: boolean
  /** Upper bound of a quiet-policy message. Defaults to 100 characters. */
  maxMessageChars?: number
  /** Fallback Eval deadline when the Policy value is not usable. */
  evalTimeoutMs?: number
}

const DEFAULT_EVAL_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MESSAGE_CHARS = 100

/** Ticket stages' retry/recovery note. */
const RECOVERY_NOTE =
  'The host restarted while this Assignment was running. Check the working directory, git history and any external action before repeating it, then continue.'

function maxIso(a: IsoTime | undefined, b: IsoTime): IsoTime {
  if (a === undefined) return b
  return a >= b ? a : b
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function normalizeReasons(reasons: Reason[], triggerId: TriggerId): Reason[] {
  if (reasons.length === 0) return [{ code: 'decided', triggerId }]
  return reasons
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * The one writer of Triggers, Threads, Decisions, Tickets and Assignments.
 * Construct with `createEngine`; adapters receive only their role's `Pick`.
 */
export class Engine implements EnginePort {
  readonly sources: EngineForSources
  readonly mainSession: EngineForMainSession
  readonly people: EngineForPeople
  readonly executor: EngineForExecutor
  readonly settings: EngineForSettings

  private readonly store: AppStore
  private readonly policyProvider: PolicyProvider
  private readonly effects: EffectsPort & Partial<EffectCanceller>
  private readonly outbox: OutboxPort & Partial<OutboxWithdrawer>
  private readonly clock: Clock
  private readonly logger?: EngineLogger
  private readonly executorAdapter: Adapter<ExecutorPort> | undefined
  private readonly acknowledgeOnAccept: boolean
  private readonly maxMessageChars: number
  private readonly fallbackTimeoutMs: number
  private commandedPause = false
  private pausedAt: IsoTime | undefined
  private passing = false

  constructor(deps: EngineDeps) {
    this.store = deps.store
    this.policyProvider = deps.policy
    this.effects = deps.effects
    this.outbox = deps.outbox
    this.clock = deps.clock ?? { now: deps.now ?? (() => new Date().toISOString()) }
    this.logger = deps.logger
    this.executorAdapter = deps.executor
    this.acknowledgeOnAccept = deps.acknowledgeOnAccept ?? false
    this.maxMessageChars = deps.maxMessageChars ?? DEFAULT_MESSAGE_CHARS
    this.fallbackTimeoutMs = deps.evalTimeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS
    this.commandedPause = this.store.kv.get<boolean>('pause.commanded') === true
    this.pausedAt = this.store.kv.get<IsoTime>('pause.startedAt')

    this.sources = {
      // A failed store write must be distinguishable from a filtered event: the
      // Source keeps its read position and retries instead of skipping the event.
      receive: trigger => this.guard('receive', 'failed' as ReceiveDisposition, () => this.receiveTrigger(trigger)),
      bindThread: (ticketId, thread, own) =>
        this.guardVoid('bindThread', () => this.bindThread(ticketId, thread, own)),
      threadClosed: (thread, outcome, at) =>
        this.guardVoid('threadClosed', () => this.threadClosed(thread, outcome, at)),
    }

    this.mainSession = {
      candidate: triggerId => this.guard('candidate', undefined, () => this.candidate(triggerId)),
      candidateDelivered: evalId => this.guardVoid('candidateDelivered', () => this.candidateDelivered(evalId)),
      decide: input => this.decideGuarded(input),
      attach: input => this.guardVoid('attach', () => this.attach(input)),
      requestStatus: ticketId => this.guard('requestStatus', false, () => this.requestStatus(ticketId)),
      note: (ticketId, text) => this.guardVoid('note', () => this.note(ticketId, text)),
      reply: message => this.guardVoid('reply', () => this.reply(message)),
    }

    this.people = {
      stopTicket: (ticketId, reason) => this.guardVoid('stopTicket', () => this.stopTicket(ticketId, reason)),
      retryTicket: ticketId => this.guardVoid('retryTicket', () => this.retryTicket(ticketId)),
      reevaluate: triggerId => this.guardVoid('reevaluate', () => this.reevaluate(triggerId)),
      dismiss: decisionId => this.guardVoid('dismiss', () => this.dismiss(decisionId)),
      pause: paused => this.guardVoid('pause', () => this.pause(paused)),
    }

    this.executor = {
      assignmentStarted: input => this.guardVoid('assignmentStarted', () => this.assignmentStarted(input)),
      inputsDelivered: (ticketId, assignmentId, inputIds) =>
        this.guardVoid('inputsDelivered', () => this.inputsDelivered(ticketId, assignmentId, inputIds)),
      turnEnded: (ticketId, assignmentId) => this.guardVoid('turnEnded', () => this.turnEnded(ticketId, assignmentId)),
      deliveryFailed: (ticketId, assignmentId, error) =>
        this.guardVoid('deliveryFailed', () => this.deliveryFailed(ticketId, assignmentId, error)),
      report: input => this.guardVoid('report', () => this.report(input)),
      handback: (ticketId, triggerId, reason) =>
        this.guardVoid('handback', () => this.handback(ticketId, triggerId, reason)),
      followForContext: (ticketId, thread) =>
        this.guardVoid('followForContext', () => this.followForContext(ticketId, thread)),
      markUnrelated: (ticketId, thread, reason) =>
        this.guardVoid('markUnrelated', () => this.markUnrelated(ticketId, thread, reason)),
      assignmentInterrupted: (ticketId, assignmentId) =>
        this.guardVoid('assignmentInterrupted', () => this.assignmentInterrupted(ticketId, assignmentId)),
    }

    this.settings = {
      policyChanged: (from, to) => this.guardVoid('policyChanged', () => this.policyChanged(from, to)),
      policy: () => this.currentPolicy(),
    }
  }

  // -------------------------------------------------------------------------
  // Queries and the pass
  // -------------------------------------------------------------------------

  candidateOf(triggerId: TriggerId): Candidate | undefined {
    return this.guard('candidateOf', undefined, () => this.candidate(triggerId))
  }

  /** Start due Evals and resume waiting work; one pass at a time. */
  evaluateDue(): void {
    if (this.passing) return
    if (this.isPaused()) return
    this.passing = true
    try {
      let guard = 0
      let changed = true
      while (changed && guard < 20) {
        changed = false
        guard += 1
        const now = this.now()
        for (const thread of this.store.threads.active()) {
          const evalRun = thread.eval
          if (evalRun === undefined) continue
          if (evalRun.deliveredAt === undefined || evalRun.deadlineAt === undefined) continue
          if (evalRun.deadlineAt > now) continue
          this.store.atomic(() => this.expireEval(thread, evalRun))
          changed = true
        }
        for (const thread of this.store.threads.active()) {
          if (thread.queued.length === 0 || thread.eval !== undefined) continue
          this.store.atomic(() => this.startEval(thread))
          changed = true
        }
        if (this.resumePending()) changed = true
      }
    } catch (error) {
      this.warn('evaluateDue', error)
    } finally {
      this.passing = false
    }
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  private receiveTrigger(trigger: Trigger): ReceiveDisposition {
    return this.store.atomic(() => {
      if (this.store.triggers.has(trigger.id)) return 'duplicate'
      const now = this.now()
      this.store.triggers.save(trigger)
      const policy = this.currentPolicy()
      if (policy.sources[trigger.source] === undefined) {
        this.recordDisposition(trigger, now, disposition => {
          disposition.outcome = 'filtered'
          disposition.filteredReason = 'source_not_configured'
        })
        return 'filtered'
      }
      const thread = this.ensureThread(trigger.thread, now)
      thread.lastTriggerAt = maxIso(thread.lastTriggerAt, trigger.at)
      for (const correlation of trigger.correlations ?? []) this.ensureThread(correlation, now)

      const disposition = this.ensureDisposition(trigger, now)
      const fanout = this.fanOut(trigger, thread, now)
      for (const ticketId of fanout.tickets) {
        if (!disposition.tickets.includes(ticketId)) disposition.tickets.push(ticketId)
      }

      // A person's message that reached a Ticket is that Ticket's follow-up; it
      // does not create an Eval. Everything else waits for the next batch.
      if (!(this.isPerson(trigger) && fanout.owned)) {
        if (!thread.queued.includes(trigger.id)) thread.queued.push(trigger.id)
        disposition.outcome = 'queued'
      }
      disposition.updatedAt = now
      this.store.threads.save(thread)
      this.store.dispositions.save(disposition)
      return 'stored'
    })
  }

  private bindThread(
    ticketId: TicketId,
    thread: { key: string; source: string; label?: string },
    own: boolean,
  ): void {
    this.store.atomic(() => {
      const ticket = this.store.tickets.get(ticketId)
      if (ticket === undefined || ticket.ends !== undefined) return
      const now = this.now()
      const ref: ThreadRef = {
        key: thread.key,
        source: thread.source,
        ...(thread.label === undefined ? {} : { label: thread.label }),
      }
      const state = this.ensureThread(ref, now)
      if (!state.subscriptions.includes(ticket.id)) state.subscriptions.push(ticket.id)
      state.context = state.context.filter(id => id !== ticket.id)
      if (!ticket.subscriptions.some(subscription => subscription.key === ref.key)) {
        ticket.subscriptions.push(ref)
      }
      const existing = ticket.follows.find(follow => follow.key === ref.key)
      if (existing === undefined) {
        ticket.follows.push({ ...ref, own })
      } else {
        existing.own = existing.own || own
        delete existing.closed
        if (ref.label !== undefined) existing.label = ref.label
      }
      ticket.updatedAt = now
      this.store.tickets.save(ticket)
      this.store.threads.save(state)
    })
  }

  private threadClosed(threadKey: string, outcome: ThreadOutcome, at: IsoTime): void {
    const interrupts: Array<{ ticketId: TicketId; assignmentId: string; reason: string }> = []
    this.store.atomic(() => {
      const thread = this.store.threads.get(threadKey)
      if (thread === undefined) return
      const now = this.now()
      const ticketIds = [...new Set([...thread.subscriptions, ...thread.context])]
      for (const ticketId of ticketIds) {
        const ticket = this.store.tickets.get(ticketId)
        if (ticket === undefined || ticket.ends !== undefined) continue
        let changed = false
        ticket.follows = ticket.follows.map(follow => {
          if (follow.key !== threadKey || follow.closed !== undefined) return follow
          changed = true
          return { ...follow, closed: { at, outcome } }
        })
        if (!changed) continue
        const done = this.followsDone(ticket)
        const report = ticket.latestReport
        const mayEnd =
          done.done &&
          (report === undefined || report.kind === 'ready' || (report.kind === 'dropped' && report.at <= at))
        ticket.updatedAt = now
        this.store.tickets.save(ticket)
        if (mayEnd && done.outcome !== undefined) {
          this.endTicket(ticket, {
            at: now,
            by: 'system',
            reason: `thread_${outcome}`,
            outcome: done.outcome,
          }, now, { interrupts })
        }
      }
    })
    this.flushInterrupts(interrupts)
  }

  // -------------------------------------------------------------------------
  // Main Session
  // -------------------------------------------------------------------------

  private candidate(triggerId: TriggerId): Candidate | undefined {
    const trigger = this.store.triggers.get(triggerId)
    if (trigger === undefined) return undefined
    const thread = this.store.threads.get(trigger.thread.key)
    const evalRun = thread?.eval
    if (thread === undefined || evalRun === undefined || !evalRun.triggerIds.includes(triggerId)) return undefined
    const policy = this.currentPolicy()
    const triggers = evalRun.triggerIds
      .map(id => this.store.triggers.get(id))
      .filter((candidate): candidate is Trigger => candidate !== undefined)
    if (triggers.length === 0) return undefined
    const batch = gateBatch(triggers, policy, this.gateContext(thread))
    const snapshot = this.store.read.threadSnapshot(thread.key) ?? {
      thread,
      triggers,
      tickets: [],
    }
    const relatedTickets = this.store.read.relatedTickets(thread.key, 10)
    return {
      eval: evalRun,
      primaryTrigger: batch.trigger,
      triggers,
      thread: snapshot,
      relatedTickets,
      ticketsTotal: relatedTickets.length,
      policyVersion: policy.version,
    }
  }

  private candidateDelivered(evalId: string): void {
    this.store.atomic(() => {
      const thread = this.store.threads.active().find(active => active.eval?.id === evalId)
      if (thread?.eval === undefined) return
      if (thread.eval.deliveredAt !== undefined) return
      const now = this.now()
      thread.eval.deliveredAt = now
      thread.eval.deadlineAt = new Date(Date.parse(now) + this.evalTimeoutMs()).toISOString()
      this.store.threads.save(thread)
    })
  }

  private decideGuarded(input: DecideInput): DecideResult {
    try {
      const result = this.store.atomic(() => this.decide(input))
      if (result !== undefined) return result
    } catch (error) {
      this.warn('decide', error)
    }
    const now = this.now()
    return {
      decision: {
        id: this.newId('dc'),
        thread: '',
        triggerId: input.triggerId,
        triggerIds: [input.triggerId],
        outcome: input.outcome === 'accept' ? 'ignore' : input.outcome,
        reason: [{ code: 'internal_error', triggerId: input.triggerId }],
        at: now,
        policyVersion: this.safePolicyVersion(),
      },
    }
  }

  private decide(input: DecideInput): DecideResult | undefined {
    const now = this.now()
    const policy = this.currentPolicy()
    const trigger = this.store.triggers.get(input.triggerId)
    if (trigger === undefined) return undefined
    const thread = this.ensureThread(trigger.thread, now)
    const evalRun = thread.eval !== undefined && thread.eval.triggerIds.includes(trigger.id) ? thread.eval : undefined
    const triggerIds = evalRun?.triggerIds ?? [trigger.id]
    const triggers = triggerIds
      .map(id => this.store.triggers.get(id))
      .filter((candidate): candidate is Trigger => candidate !== undefined)
    const batchTriggers = triggers.length === 0 ? [trigger] : triggers
    const batch = gateBatch(batchTriggers, policy, this.gateContext(thread))
    const primary = batch.trigger
    const suppliedReasons = input.reason ?? []
    let outcome = input.outcome
    const extraReasons: Reason[] = []
    let mandateRules: string[] = []

    if (outcome === 'accept') {
      if (batch.result.strength === 'not_admitted') {
        outcome = 'ignore'
        extraReasons.push({ code: batch.result.reason ?? 'not_admitted', triggerId: primary.id })
      } else if (batch.result.strength === 'inferred') {
        if (policy.mode === 'off') {
          outcome = 'ignore'
          extraReasons.push({ code: 'accept_mode_off', triggerId: primary.id })
        } else if (policy.mode === 'observe') {
          outcome = 'ignore'
          extraReasons.push({
            code: 'would_accept',
            values: { mode: policy.mode },
            triggerId: primary.id,
          })
        } else {
          const rules = input.rules ?? []
          if (!admitsInferred(policy, rules)) {
            outcome = 'ignore'
            extraReasons.push({ code: 'no_matching_rule', triggerId: primary.id })
          } else {
            mandateRules = [...rules]
          }
        }
      }
    }

    if (outcome === 'accept') {
      const created = this.createTicket({
        policy,
        thread,
        triggers: batchTriggers,
        primary,
        gate: batch.result,
        input,
        rules: mandateRules,
        now,
        triggerIds,
      })
      const decision = this.recordDecision({
        thread,
        triggerId: input.triggerId,
        triggerIds,
        outcome: 'accept',
        reason: [...normalizeReasons(suppliedReasons, input.triggerId), ...extraReasons],
        now,
        policyVersion: policy.version,
        ticketId: created.ticket.id,
      })
      this.finishEval(thread, evalRun, trigger, now)
      return { decision, ticket: created.ticket }
    }

    if (outcome === 'stop') {
      const interrupts: Array<{ ticketId: TicketId; assignmentId: string; reason: string }> = []
      const reasonText = suppliedReasons.find(reason => reason.said !== undefined)?.said ?? 'stopped_by_assessment'
      for (const ticketId of [...thread.subscriptions, ...thread.context]) {
        const ticket = this.store.tickets.get(ticketId)
        if (ticket === undefined || ticket.ends !== undefined) continue
        this.endTicket(
          ticket,
          { at: now, by: 'main', reason: reasonText, outcome: 'abandoned' },
          now,
          { interrupts },
        )
      }
      this.flushInterrupts(interrupts)
    }

    const decision = this.recordDecision({
      thread,
      triggerId: input.triggerId,
      triggerIds,
      outcome,
      reason: [...normalizeReasons(suppliedReasons, input.triggerId), ...extraReasons],
      now,
      policyVersion: policy.version,
    })
    this.finishEval(thread, evalRun, trigger, now)
    return { decision }
  }

  private attach(input: AttachInput): void {
    this.store.atomic(() => {
      const now = this.now()
      const trigger = this.store.triggers.get(input.triggerId)
      let ticket = this.store.tickets.get(input.ticketId)
      if (trigger === undefined || ticket === undefined) return
      const thread = this.ensureThread(trigger.thread, now)
      thread.queued = thread.queued.filter(id => id !== trigger.id)
      let evalRun: EvalRun | undefined
      if (thread.eval !== undefined && thread.eval.triggerIds.includes(trigger.id)) {
        evalRun = thread.eval
        const rest = evalRun.triggerIds.filter(id => id !== trigger.id)
        thread.eval = undefined
        this.cancelEffect('assessment', evalRun.id)
        for (const id of rest) {
          if (!thread.queued.includes(id)) thread.queued.push(id)
          const disposition = this.store.dispositions.get(id)
          if (disposition !== undefined) {
            disposition.outcome = 'queued'
            disposition.requeuedAt = now
            disposition.updatedAt = now
            this.store.dispositions.save(disposition)
          }
        }
      }
      this.attachInput(ticket, trigger, now)
      if (ticket.ends !== undefined) {
        if (!this.tryResume(ticket, trigger, thread, now)) {
          // The Mandate no longer holds: the message becomes a candidate instead.
          ticket = undefined
          if (!thread.queued.includes(trigger.id)) thread.queued.push(trigger.id)
        }
      }
      if (ticket !== undefined) {
        this.deliverOrLaunch(ticket, now)
        this.store.tickets.save(ticket)
      }
      const disposition = this.ensureDisposition(trigger, now)
      if (!disposition.tickets.includes(input.ticketId)) disposition.tickets.push(input.ticketId)
      disposition.outcome = 'decision'
      disposition.updatedAt = now
      this.store.dispositions.save(disposition)
      const decision = this.recordDecision({
        thread,
        triggerId: trigger.id,
        triggerIds: evalRun?.triggerIds ?? [trigger.id],
        outcome: 'accept',
        reason: [{ code: 'attached', triggerId: trigger.id }, ...(input.note === undefined ? [] : [{ code: 'note', said: input.note }])],
        now,
        policyVersion: this.currentPolicy().version,
        ticketId: input.ticketId,
      })
      const stored = this.store.decisions.get(decision.id)
      if (stored !== undefined) {
        disposition.decisionId = stored.id
        this.store.dispositions.save(disposition)
      }
      thread.expired = 0
      thread.lastDecisionAt = now
      this.store.threads.save(thread)
    })
  }

  private requestStatus(ticketId: TicketId): boolean {
    const ticket = this.store.tickets.get(ticketId)
    if (ticket === undefined || ticket.ends !== undefined) return false
    const assignment = this.findRunningAssignment(ticket)
    if (assignment === undefined) return false
    const executor = this.resolveAdapter(this.executorAdapter)
    if (executor === undefined) return false
    try {
      return executor.requestStatus(ticket, assignment)
    } catch (error) {
      this.warn('requestStatus', error)
      return false
    }
  }

  private note(ticketId: TicketId, text: string): void {
    this.store.atomic(() => {
      const ticket = this.store.tickets.get(ticketId)
      if (ticket === undefined || ticket.ends !== undefined) return
      const now = this.now()
      ticket.inputs.push({ id: this.newId('in'), kind: 'text', at: now, text, person: false })
      ticket.updatedAt = now
      this.deliverOrLaunch(ticket, now)
      this.store.tickets.save(ticket)
    })
  }

  private reply(message: OutboundMessage): void {
    this.store.atomic(() => {
      this.outbox.queue(message)
    })
  }

  // -------------------------------------------------------------------------
  // People
  // -------------------------------------------------------------------------

  private stopTicket(ticketId: TicketId, reason?: string): void {
    const interrupts: Array<{ ticketId: TicketId; assignmentId: string; reason: string }> = []
    this.store.atomic(() => {
      const ticket = this.store.tickets.get(ticketId)
      if (ticket === undefined || ticket.ends !== undefined) return
      const now = this.now()
      this.endTicket(
        ticket,
        {
          at: now,
          by: 'person',
          reason: reason ?? 'stopped_by_person',
          outcome: 'abandoned',
        },
        now,
        { dropSubscriptions: true, requeueUnread: false, interrupts },
      )
    })
    this.flushInterrupts(interrupts)
  }

  private retryTicket(ticketId: TicketId): void {
    const interrupts: Array<{ ticketId: TicketId; assignmentId: string; reason: string }> = []
    this.store.atomic(() => {
      const ticket = this.store.tickets.get(ticketId)
      if (ticket === undefined || ticket.ends !== undefined) return
      const now = this.now()
      for (const assignment of ticket.assignments) {
        if (assignment.state === 'ended') continue
        this.cancelEffect('launch', assignment.id)
        this.cancelEffect('delivery', assignment.id)
        assignment.state = 'ended'
        assignment.endedAt = now
        if (assignment.sessionId !== undefined) {
          interrupts.push({ ticketId: ticket.id, assignmentId: assignment.id, reason: 'retried' })
        }
      }
      ticket.waitingForPerson = false
      delete ticket.delivery
      ticket.updatedAt = now
      const assignment = this.newAssignment(ticket.id, now)
      ticket.assignments.push(assignment)
      this.store.tickets.save(ticket)
      this.enqueueLaunch(ticket.id, assignment.id)
    })
    this.flushInterrupts(interrupts)
  }

  private reevaluate(triggerId: TriggerId): void {
    this.store.atomic(() => {
      const trigger = this.store.triggers.get(triggerId)
      if (trigger === undefined) return
      const now = this.now()
      const thread = this.ensureThread(trigger.thread, now)
      if (thread.queued.includes(triggerId)) return
      if (thread.eval?.triggerIds.includes(triggerId) === true) return
      thread.queued.push(triggerId)
      thread.lastTriggerAt = maxIso(thread.lastTriggerAt, trigger.at)
      thread.expired = 0
      const disposition = this.ensureDisposition(trigger, now)
      disposition.outcome = 'queued'
      disposition.requeuedAt = now
      disposition.updatedAt = now
      this.store.dispositions.save(disposition)
      this.store.threads.save(thread)
    })
  }

  private dismiss(decisionId: string): void {
    this.store.atomic(() => {
      const decision = this.store.decisions.get(decisionId)
      if (decision === undefined) return
      decision.dismissedAt = this.now()
      this.store.decisions.save(decision)
    })
  }

  private pause(paused: boolean): void {
    this.store.atomic(() => {
      const now = this.now()
      if (paused) {
        if (this.commandedPause) return
        this.commandedPause = true
        this.store.kv.set('pause.commanded', true)
        this.markPaused(now)
        return
      }
      if (!this.commandedPause) return
      this.commandedPause = false
      this.store.kv.delete('pause.commanded')
      if (!this.safePolicyPaused()) this.liftPause(now)
    })
    if (!this.isPaused()) {
      this.resumePending()
      this.evaluateDue()
    }
  }

  // -------------------------------------------------------------------------
  // Executor facts
  // -------------------------------------------------------------------------

  private assignmentStarted(input: AssignmentStartedInput): void {
    this.store.atomic(() => {
      const ticket = this.store.tickets.get(input.ticketId)
      if (ticket === undefined || ticket.ends !== undefined) return
      const assignment = ticket.assignments.find(candidate => candidate.id === input.assignmentId)
      if (assignment === undefined || assignment.state === 'ended') return
      const now = this.now()
      assignment.state = 'running'
      assignment.startedAt = assignment.startedAt ?? now
      if (input.sessionId !== undefined) {
        assignment.sessionId = input.sessionId
        ticket.workerSessionId = input.sessionId
      }
      delete ticket.delivery
      ticket.updatedAt = now
      this.store.tickets.save(ticket)
      this.enqueueDelivery(ticket, assignment)
    })
  }

  private inputsDelivered(ticketId: TicketId, _assignmentId: string, inputIds: string[]): void {
    this.store.atomic(() => {
      const ticket = this.store.tickets.get(ticketId)
      if (ticket === undefined) return
      const now = this.now()
      const ids = new Set(inputIds)
      let changed = false
      for (const input of ticket.inputs) {
        if (!ids.has(input.id) || input.readAt !== undefined) continue
        input.readAt = now
        changed = true
      }
      if (changed) {
        delete ticket.delivery
        ticket.updatedAt = now
        this.store.tickets.save(ticket)
      }
    })
  }

  private turnEnded(ticketId: TicketId, assignmentId: string): void {
    this.store.atomic(() => {
      const ticket = this.store.tickets.get(ticketId)
      if (ticket === undefined) return
      const assignment = ticket.assignments.find(candidate => candidate.id === assignmentId)
      if (assignment === undefined || assignment.state !== 'running') return
      const now = this.now()
      assignment.state = 'ended'
      assignment.endedAt = assignment.endedAt ?? now
      this.cancelEffect('delivery', assignment.id)
      if (ticket.latestReport?.kind === 'waiting') ticket.waitingForPerson = false
      ticket.updatedAt = now
      this.store.tickets.save(ticket)
    })
  }

  private deliveryFailed(ticketId: TicketId, _assignmentId: string, error: string): void {
    this.store.atomic(() => {
      const ticket = this.store.tickets.get(ticketId)
      if (ticket === undefined) return
      const now = this.now()
      ticket.delivery = { error, at: now }
      ticket.updatedAt = now
      this.store.tickets.save(ticket)
    })
  }

  private report(input: AssignmentReportedInput): void {
    this.store.atomic(() => {
      const ticket = this.store.tickets.get(input.ticketId)
      if (ticket === undefined) return
      const assignment = ticket.assignments.find(candidate => candidate.id === input.assignmentId)
      if (assignment === undefined) return
      // B1: an Assignment ends with its turn (`turnEnded`), an interrupt, a
      // retry or the Ticket's end. A Report arriving after that must not
      // resurrect it, change `latestReport`, or disturb a person again.
      if (assignment.state === 'ended') return
      const now = this.now()
      const reportInput: Report = { ...input.report, at: input.report.at ?? now }
      // B1: the Executor may retry one report; the same kind and summary is
      // recorded and announced at most once per Assignment.
      const previous = assignment.report
      if (previous !== undefined && previous.kind === reportInput.kind && previous.summary === reportInput.summary) {
        return
      }
      assignment.report = reportInput
      ticket.latestReport = reportInput
      ticket.updatedAt = now
      ticket.waitingForPerson = reportInput.kind === 'blocked' || reportInput.kind === 'failed'
      switch (reportInput.kind) {
        case 'progress':
        case 'waiting':
          break
        case 'ready':
          this.queueAttention(ticket, 'result', this.readyText(reportInput), now)
          this.enqueueRelay(ticket, assignment, reportInput, now)
          {
            const done = this.followsDone(ticket)
            if (done.done) {
              if (done.outcome !== undefined) {
                this.endTicket(
                  ticket,
                  { at: now, by: 'executor', reason: 'ready', outcome: done.outcome },
                  now,
                )
                break
              }
            } else if (ticket.follows.length === 0) {
              this.endTicket(ticket, { at: now, by: 'executor', reason: 'ready', outcome: 'completed' }, now)
              break
            }
          }
          break
        case 'blocked':
          this.queueAttention(ticket, 'attention', this.blockedText(reportInput), now)
          this.enqueueRelay(ticket, assignment, reportInput, now)
          break
        case 'failed':
          this.queueAttention(ticket, 'attention', this.failedText(reportInput), now)
          this.enqueueRelay(ticket, assignment, reportInput, now)
          break
        case 'dropped':
          this.enqueueRelay(ticket, assignment, reportInput, now)
          this.endTicket(ticket, { at: now, by: 'executor', reason: 'dropped', outcome: 'dropped' }, now)
          break
        default:
          break
      }
      this.store.tickets.save(ticket)
    })
  }

  private handback(ticketId: TicketId, triggerId: TriggerId, reason: string): void {
    this.store.atomic(() => {
      const trigger = this.store.triggers.get(triggerId)
      const ticket = this.store.tickets.get(ticketId)
      if (trigger === undefined || ticket === undefined) return
      const now = this.now()
      const disposition = this.ensureDisposition(trigger, now)
      if (disposition.handedBack.some(handback => handback.ticketId === ticketId)) return
      disposition.handedBack.push({ ticketId, reason, at: now })
      const otherOwner = disposition.tickets.some(otherId => {
        if (otherId === ticketId) return false
        const owner = this.store.tickets.get(otherId)
        return owner !== undefined && (owner.ends === undefined || owner.ends.by !== 'person')
      })
      const thread = this.ensureThread(trigger.thread, now)
      if (!otherOwner) {
        const queued = thread.queued.includes(trigger.id)
        const inEval = thread.eval?.triggerIds.includes(trigger.id) === true
        if (!queued && !inEval) thread.queued.push(trigger.id)
        disposition.outcome = 'queued'
        disposition.requeuedAt = now
        this.store.threads.save(thread)
      }
      disposition.updatedAt = now
      this.store.dispositions.save(disposition)
    })
  }

  private followForContext(ticketId: TicketId, thread: { key: string; source: string; label?: string }): void {
    this.store.atomic(() => {
      const ticket = this.store.tickets.get(ticketId)
      if (ticket === undefined || ticket.ends !== undefined) return
      const now = this.now()
      const ref: ThreadRef = {
        key: thread.key,
        source: thread.source,
        ...(thread.label === undefined ? {} : { label: thread.label }),
      }
      const state = this.ensureThread(ref, now)
      if (!ticket.subscriptions.some(subscription => subscription.key === ref.key)) {
        ticket.subscriptions.push(ref)
      }
      const alreadySubscribed = state.subscriptions.includes(ticket.id)
      if (!alreadySubscribed && !state.context.includes(ticket.id)) state.context.push(ticket.id)
      ticket.updatedAt = now
      this.store.tickets.save(ticket)
      this.store.threads.save(state)
    })
  }

  private markUnrelated(ticketId: TicketId, threadKey: string, reason: string): void {
    this.store.atomic(() => {
      const ticket = this.store.tickets.get(ticketId)
      if (ticket === undefined) return
      // Own Threads and Source-made bindings stay.
      if (ticket.follows.some(follow => follow.key === threadKey)) return
      const thread = this.store.threads.get(threadKey)
      const now = this.now()
      ticket.subscriptions = ticket.subscriptions.filter(subscription => subscription.key !== threadKey)
      ticket.updatedAt = now
      this.store.tickets.save(ticket)
      if (thread !== undefined) {
        thread.subscriptions = thread.subscriptions.filter(id => id !== ticketId)
        thread.context = thread.context.filter(id => id !== ticketId)
        this.store.threads.save(thread)
      }
      // Follow-ups there that only this Ticket decided go back to Eval.
      const triggers = this.store.read.threadTriggers(threadKey, { limit: 200 })
      for (const trigger of triggers) {
        const disposition = this.store.dispositions.get(trigger.id)
        if (disposition === undefined) continue
        if (!disposition.tickets.includes(ticketId)) continue
        if (!this.isPerson(trigger)) continue
        const otherOwner = disposition.tickets.some(otherId => {
          if (otherId === ticketId) return false
          const owner = this.store.tickets.get(otherId)
          return owner !== undefined && (owner.ends === undefined || owner.ends.by !== 'person')
        })
        if (otherOwner) continue
        const state = this.ensureThread(trigger.thread, now)
        if (!state.queued.includes(trigger.id) && state.eval?.triggerIds.includes(trigger.id) !== true) {
          state.queued.push(trigger.id)
          this.store.threads.save(state)
        }
        disposition.outcome = 'queued'
        disposition.requeuedAt = now
        disposition.updatedAt = now
        this.store.dispositions.save(disposition)
      }
      this.effects.enqueue('notice', `unsubscribed:${ticketId}:${threadKey}`, {
        code: 'thread_unsubscribed',
        ticketId,
        detail: reason,
      } satisfies NoticePayload)
    })
  }

  private assignmentInterrupted(ticketId: TicketId, assignmentId: string): void {
    this.store.atomic(() => {
      const ticket = this.store.tickets.get(ticketId)
      if (ticket === undefined || ticket.ends !== undefined) return
      const assignment = ticket.assignments.find(candidate => candidate.id === assignmentId)
      if (assignment === undefined || assignment.state === 'ended') return
      const now = this.now()
      assignment.state = 'ended'
      assignment.endedAt = assignment.endedAt ?? now
      this.cancelEffect('launch', assignment.id)
      this.cancelEffect('delivery', assignment.id)
      ticket.inputs.push({
        id: this.newId('in'),
        kind: 'resume',
        at: now,
        text: RECOVERY_NOTE,
        person: false,
      })
      ticket.updatedAt = now
      const next = this.newAssignment(ticket.id, now)
      ticket.assignments.push(next)
      this.store.tickets.save(ticket)
      this.enqueueLaunch(ticket.id, next.id)
    })
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  private policyChanged(from: Policy, to: Policy): void {
    if (from.paused !== to.paused) {
      this.store.atomic(() => {
        const now = this.now()
        if (to.paused) this.markPaused(now)
        else this.liftPause(now)
      })
    }
    if (from.paused && !to.paused) {
      this.resumePending()
      this.evaluateDue()
    }
    this.store.atomic(() => {
      const now = this.now()
      const affected = policyEffects(this.store.tickets.open(), from, to)
      for (const change of affected) {
        const ticket = this.store.tickets.get(change.ticket.id)
        if (ticket === undefined || ticket.ends !== undefined) continue
        const description = this.describeChanges(change.changes, to)
        if (ticket.inputs.some(input => input.kind === 'policy' && input.text === description)) continue
        ticket.inputs.push({
          id: this.newId('in'),
          kind: 'policy',
          at: now,
          text: description,
          person: false,
        })
        ticket.updatedAt = now
        this.deliverOrLaunch(ticket, now)
        this.store.tickets.save(ticket)
      }
    })
  }

  // -------------------------------------------------------------------------
  // Eval internals
  // -------------------------------------------------------------------------

  private startEval(thread: ThreadState): void {
    const now = this.now()
    const policy = this.currentPolicy()
    const triggerIds = [...thread.queued]
    const triggers = triggerIds
      .map(id => this.store.triggers.get(id))
      .filter((trigger): trigger is Trigger => trigger !== undefined)
    if (triggers.length === 0) {
      thread.queued = []
      this.store.threads.save(thread)
      return
    }
    const evalRun: EvalRun = {
      id: this.newId('ev'),
      triggerIds: triggers.map(trigger => trigger.id),
      startedAt: now,
      expiries: thread.expired,
    }
    thread.queued = []
    thread.eval = evalRun
    const batch = gateBatch(triggers, policy, this.gateContext(thread))
    for (const id of evalRun.triggerIds) {
      const disposition = this.store.dispositions.get(id)
      if (disposition === undefined) continue
      disposition.outcome = 'eval'
      disposition.evalId = evalRun.id
      disposition.updatedAt = now
      this.store.dispositions.save(disposition)
    }
    this.store.threads.save(thread)

    if (batch.result.strength === 'not_admitted') {
      this.decide({
        triggerId: batch.trigger.id,
        outcome: 'ignore',
        reason: [{ code: batch.result.reason ?? 'not_admitted', triggerId: batch.trigger.id }],
      })
      return
    }
    if (batch.result.strength === 'inferred' && policy.mode === 'off') {
      this.decide({
        triggerId: batch.trigger.id,
        outcome: 'ignore',
        reason: [{ code: 'accept_mode_off', triggerId: batch.trigger.id }],
      })
      return
    }
    this.effects.enqueue('assessment', evalRun.id, {
      evalId: evalRun.id,
      triggerId: batch.trigger.id,
    } satisfies AssessmentPayload)
  }

  private expireEval(thread: ThreadState, evalRun: EvalRun): void {
    const now = this.now()
    const expiries = Math.max(thread.expired, evalRun.expiries) + 1
    thread.eval = undefined
    this.cancelEffect('assessment', evalRun.id)
    if (expiries >= 3) {
      thread.expired = 0
      const decision = this.recordDecision({
        thread,
        triggerId: evalRun.triggerIds[evalRun.triggerIds.length - 1] ?? evalRun.triggerIds[0]!,
        triggerIds: evalRun.triggerIds,
        outcome: 'unavailable',
        reason: [{ code: 'timeout', values: { expiries } }],
        now,
        policyVersion: this.currentPolicy().version,
      })
      for (const id of evalRun.triggerIds) {
        const disposition = this.store.dispositions.get(id)
        if (disposition === undefined) continue
        disposition.outcome = 'decision'
        disposition.decisionId = decision.id
        disposition.evalId = evalRun.id
        disposition.updatedAt = now
        this.store.dispositions.save(disposition)
      }
    } else {
      thread.expired = expiries
      for (const id of evalRun.triggerIds) {
        if (!thread.queued.includes(id)) thread.queued.push(id)
        const disposition = this.store.dispositions.get(id)
        if (disposition === undefined) continue
        disposition.outcome = 'queued'
        disposition.requeuedAt = now
        disposition.updatedAt = now
        this.store.dispositions.save(disposition)
      }
      const first = evalRun.triggerIds[0]
      if (first !== undefined) {
        const trigger = this.store.triggers.get(first)
        if (trigger !== undefined && trigger.thread.key === thread.key) {
          thread.lastTriggerAt = maxIso(thread.lastTriggerAt, now)
        }
      }
    }
    this.store.threads.save(thread)
  }

  private finishEval(
    thread: ThreadState,
    evalRun: EvalRun | undefined,
    trigger: Trigger,
    now: IsoTime,
  ): void {
    if (evalRun !== undefined) {
      thread.eval = undefined
      this.cancelEffect('assessment', evalRun.id)
      for (const id of evalRun.triggerIds) {
        const disposition = this.store.dispositions.get(id)
        if (disposition === undefined) continue
        if (disposition.decisionId !== undefined) continue
        disposition.outcome = 'decision'
        disposition.updatedAt = now
        this.store.dispositions.save(disposition)
      }
    } else {
      thread.queued = thread.queued.filter(id => id !== trigger.id)
      const disposition = this.store.dispositions.get(trigger.id)
      if (disposition !== undefined) {
        disposition.outcome = 'decision'
        disposition.updatedAt = now
        this.store.dispositions.save(disposition)
      }
    }
    thread.expired = 0
    thread.lastDecisionAt = now
    this.store.threads.save(thread)
  }

  // -------------------------------------------------------------------------
  // Ticket internals
  // -------------------------------------------------------------------------

  private createTicket(options: {
    policy: Policy
    thread: ThreadState
    triggers: Trigger[]
    primary: Trigger
    gate: GateResult
    input: DecideInput
    rules: string[]
    now: IsoTime
    triggerIds: TriggerId[]
  }): { ticket: Ticket } {
    const { policy, thread, triggers, primary, gate, input, rules, now, triggerIds } = options
    const title = input.title?.trim() || this.deriveTitle(primary, thread)
    const mandate: Mandate = {
      policyVersion: policy.version,
      strength: gate.strength === 'explicit' ? 'explicit' : 'inferred',
      rules,
      source: primary.source,
      scope: this.scopeOf(primary),
      sender: {
        id: primary.actor.id,
        ...(primary.actor.name === undefined ? {} : { name: primary.actor.name }),
      },
      via: gate.via,
      at: now,
    }
    const assignment = this.newAssignment('', now)
    const inputs: Input[] = []
    for (const trigger of triggers) {
      inputs.push({
        id: this.newId('in'),
        kind: 'trigger',
        at: now,
        triggerId: trigger.id,
        person: this.isPerson(trigger),
      })
    }
    if (input.note !== undefined && input.note.trim() !== '') {
      inputs.push({ id: this.newId('in'), kind: 'text', at: now, text: input.note.trim(), person: false })
    }
    const ref: ThreadRef = {
      key: thread.key,
      source: thread.source,
      ...(thread.label === undefined ? {} : { label: thread.label }),
    }
    const ticket: Ticket = {
      id: this.newId('tk'),
      title,
      createdAt: now,
      updatedAt: now,
      state: 'open',
      origin: { triggerId: primary.id, triggerIds },
      mandate,
      follows: [{ ...ref, own: true }],
      subscriptions: [ref],
      channels: [primary.channel],
      inputs,
      assignments: [],
    }
    assignment.ticketId = ticket.id
    ticket.assignments.push(assignment)
    if (!thread.subscriptions.includes(ticket.id)) thread.subscriptions.push(ticket.id)
    thread.context = thread.context.filter(id => id !== ticket.id)
    this.store.tickets.save(ticket)
    this.store.threads.save(thread)
    this.enqueueLaunch(ticket.id, assignment.id)
    if (this.acknowledgeOnAccept) {
      this.outbox.queue({
        id: this.newId('msg'),
        ticketId: ticket.id,
        purpose: 'acknowledgement',
        channel: primary.channel,
        text: truncate(`On it: ${title}`, this.maxMessageChars),
        markdown: 'plain',
        at: now,
      })
    }
    return { ticket }
  }

  private attachInput(ticket: Ticket, trigger: Trigger, now: IsoTime): void {
    if (ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === trigger.id)) return
    ticket.inputs.push({
      id: this.newId('in'),
      kind: 'trigger',
      at: now,
      triggerId: trigger.id,
      person: this.isPerson(trigger),
    })
    ticket.updatedAt = now
  }

  private fanOut(trigger: Trigger, thread: ThreadState, now: IsoTime): { tickets: TicketId[]; owned: boolean } {
    const reached: TicketId[] = []
    let owned = false
    const person = this.isPerson(trigger)

    for (const ticketId of [...thread.subscriptions]) {
      const ticket = this.store.tickets.get(ticketId)
      if (ticket === undefined) continue
      const contextOnly = thread.context.includes(ticketId)
      if (ticket.ends !== undefined) {
        if (contextOnly || !person) continue
        if (ticket.ends.by === 'person') continue
        if (this.tryResume(ticket, trigger, thread, now)) {
          reached.push(ticketId)
          if (!contextOnly) owned = true
        }
        continue
      }
      this.attachInput(ticket, trigger, now)
      if (!contextOnly) {
        this.deliverOrLaunch(ticket, now)
        owned = true
      } else {
        this.deliverOrLaunch(ticket, now)
      }
      this.store.tickets.save(ticket)
      reached.push(ticketId)
    }

    for (const ticketId of [...thread.context]) {
      if (thread.subscriptions.includes(ticketId)) continue
      const ticket = this.store.tickets.get(ticketId)
      if (ticket === undefined || ticket.ends !== undefined) continue
      this.attachInput(ticket, trigger, now)
      this.deliverOrLaunch(ticket, now)
      this.store.tickets.save(ticket)
      reached.push(ticketId)
    }
    return { tickets: [...new Set(reached)], owned }
  }

  private tryResume(ticket: Ticket, trigger: Trigger, thread: ThreadState, now: IsoTime): boolean {
    if (!revalidateMandate(ticket.mandate, this.currentPolicy())) return false
    if (thread.context.includes(ticket.id)) return false
    if (this.isPaused()) {
      this.attachInput(ticket, trigger, now)
      ticket.updatedAt = now
      this.store.tickets.save(ticket)
      this.store.kv.set(`pause.resume:${ticket.id}`, { ticketId: ticket.id, triggerId: trigger.id })
      return true
    }
    this.attachInput(ticket, trigger, now)
    ticket.state = 'open'
    delete ticket.ends
    ticket.waitingForPerson = false
    delete ticket.delivery
    ticket.updatedAt = now
    const assignment = this.newAssignment(ticket.id, now)
    ticket.assignments.push(assignment)
    this.store.tickets.save(ticket)
    this.enqueueLaunch(ticket.id, assignment.id)
    this.effects.enqueue('notice', `resumed:${ticket.id}:${now}`, {
      code: 'ticket_resumed',
      ticketId: ticket.id,
      detail: trigger.id,
    } satisfies NoticePayload)
    return true
  }

  private resumePending(): boolean {
    const keys = this.store.kv.keys('pause.resume:')
    if (keys.length === 0) return false
    let resumedAny = false
    this.store.atomic(() => {
      for (const key of keys) {
        const value = this.store.kv.get<{ ticketId: TicketId; triggerId: TriggerId }>(key)
        this.store.kv.delete(key)
        if (value === undefined) continue
        const trigger = this.store.triggers.get(value.triggerId)
        const ticket = this.store.tickets.get(value.ticketId)
        if (trigger === undefined || ticket === undefined) continue
        if (ticket.ends === undefined) continue
        const now = this.now()
        const thread = this.ensureThread(trigger.thread, now)
        if (this.tryResume(ticket, trigger, thread, now)) {
          resumedAny = true
          continue
        }
        // The Mandate no longer holds: the message becomes a candidate again.
        if (!thread.queued.includes(trigger.id)) thread.queued.push(trigger.id)
        const disposition = this.ensureDisposition(trigger, now)
        disposition.outcome = 'queued'
        disposition.requeuedAt = now
        disposition.updatedAt = now
        this.store.dispositions.save(disposition)
        this.store.threads.save(thread)
        resumedAny = true
      }
    })
    return resumedAny
  }

  private deliverOrLaunch(ticket: Ticket, now: IsoTime): void {
    const running = this.findRunningAssignment(ticket)
    if (running !== undefined) {
      this.enqueueDelivery(ticket, running)
      return
    }
    const pending = this.findPendingAssignment(ticket)
    if (pending !== undefined) {
      this.enqueueLaunch(ticket.id, pending.id)
      return
    }
    const assignment = this.newAssignment(ticket.id, now)
    ticket.assignments.push(assignment)
    this.enqueueLaunch(ticket.id, assignment.id)
  }

  private endTicket(
    ticket: Ticket,
    end: TicketEnd,
    now: IsoTime,
    options: {
      dropSubscriptions?: boolean
      requeueUnread?: boolean
      interrupts?: Array<{ ticketId: TicketId; assignmentId: string; reason: string }>
    } = {},
  ): void {
    if (ticket.ends !== undefined) return
    ticket.ends = end
    ticket.state = 'ended'
    ticket.updatedAt = now
    ticket.waitingForPerson = false
    for (const assignment of ticket.assignments) {
      if (assignment.state === 'ended') continue
      this.cancelEffect('launch', assignment.id)
      this.cancelEffect('delivery', assignment.id)
      assignment.state = 'ended'
      assignment.endedAt = assignment.endedAt ?? now
      if (assignment.sessionId !== undefined) {
        options.interrupts?.push({ ticketId: ticket.id, assignmentId: assignment.id, reason: end.reason })
      }
    }
    if (options.dropSubscriptions === true) {
      for (const subscription of ticket.subscriptions) {
        const thread = this.store.threads.get(subscription.key)
        if (thread === undefined) continue
        thread.subscriptions = thread.subscriptions.filter(id => id !== ticket.id)
        thread.context = thread.context.filter(id => id !== ticket.id)
        this.store.threads.save(thread)
      }
      ticket.subscriptions = []
    }
    this.store.tickets.save(ticket)
    if (options.requeueUnread !== false) this.requeueUnreadFollowUps(ticket, now)
    this.effects.enqueue('notice', `ended:${ticket.id}:${now}`, {
      code: 'ticket_ended',
      ticketId: ticket.id,
      detail: end.outcome,
    } satisfies NoticePayload)
  }

  private requeueUnreadFollowUps(ticket: Ticket, now: IsoTime): void {
    for (const input of ticket.inputs) {
      if (input.kind !== 'trigger' || input.person !== true || input.readAt !== undefined) continue
      if (input.triggerId === undefined) continue
      const triggerId = input.triggerId
      const disposition = this.store.dispositions.get(triggerId)
      if (disposition === undefined) continue
      if (disposition.requeuedAt !== undefined || disposition.decisionId !== undefined) continue
      const otherOwner = disposition.tickets.some(otherId => {
        if (otherId === ticket.id) return false
        const owner = this.store.tickets.get(otherId)
        return owner !== undefined && (owner.ends === undefined || owner.ends.by !== 'person')
      })
      if (otherOwner) continue
      const trigger = this.store.triggers.get(triggerId)
      if (trigger === undefined) continue
      const thread = this.ensureThread(trigger.thread, now)
      if (!thread.queued.includes(triggerId) && thread.eval?.triggerIds.includes(triggerId) !== true) {
        thread.queued.push(triggerId)
        this.store.threads.save(thread)
      }
      disposition.outcome = 'queued'
      disposition.requeuedAt = now
      disposition.updatedAt = now
      this.store.dispositions.save(disposition)
    }
  }

  private followsDone(ticket: Ticket): { done: boolean; outcome?: ThreadOutcome } {
    const opened = ticket.follows.filter(follow => follow.own)
    const relevant = opened.length > 0 ? opened : ticket.follows
    if (relevant.length === 0) return { done: false }
    if (relevant.some(follow => follow.closed === undefined)) return { done: false }
    const latest = relevant.reduce((best, follow) =>
      (follow.closed?.at ?? '') >= (best.closed?.at ?? '') ? follow : best,
    )
    return { done: true, outcome: latest.closed?.outcome }
  }

  private queueAttention(ticket: Ticket, purpose: 'result' | 'attention', text: string, now: IsoTime): void {
    const channel = ticket.channels[0]
    if (channel === undefined) return
    this.outbox.queue({
      id: this.newId('msg'),
      ticketId: ticket.id,
      purpose,
      channel,
      text: truncate(text, this.maxMessageChars),
      markdown: 'plain',
      at: now,
    })
  }

  private enqueueRelay(ticket: Ticket, assignment: Assignment, report: Report, now: IsoTime): void {
    this.effects.enqueue('relay', `${ticket.id}:${report.at}:${report.kind}`, {
      code: `report_${report.kind}`,
      ticketId: ticket.id,
      assignmentId: assignment.id,
      triggerId: ticket.origin.triggerId,
      detail: report.summary,
    } satisfies RelayPayload)
    void now
  }

  private readyText(report: Report): string {
    const url = report.pullRequest?.url
    return url === undefined ? `Ready: ${report.summary}` : `Ready: ${report.summary} ${url}`
  }

  private blockedText(report: Report): string {
    return `Needs a decision: ${report.question ?? report.summary}`
  }

  private failedText(report: Report): string {
    return `Failed: ${report.summary}`
  }

  private describeChanges(changes: string[], policy: Policy): string {
    return truncate(`Policy ${policy.version} changed: ${changes.join(', ')}`, 500)
  }

  private newAssignment(ticketId: TicketId, now: IsoTime): Assignment {
    return {
      id: this.newId('as'),
      ticketId,
      state: 'pending',
      createdAt: now,
    }
  }

  private findRunningAssignment(ticket: Ticket): Assignment | undefined {
    return ticket.assignments.find(assignment => assignment.state === 'running')
  }

  private findPendingAssignment(ticket: Ticket): Assignment | undefined {
    return ticket.assignments.find(assignment => assignment.state === 'pending')
  }

  private enqueueLaunch(ticketId: TicketId, assignmentId: string): void {
    this.effects.enqueue('launch', assignmentId, { ticketId, assignmentId } satisfies LaunchPayload)
  }

  private enqueueDelivery(ticket: Ticket, assignment: Assignment): void {
    const inputIds = ticket.inputs.filter(input => input.readAt === undefined).map(input => input.id)
    if (inputIds.length === 0) return
    this.effects.enqueue('delivery', assignment.id, {
      ticketId: ticket.id,
      assignmentId: assignment.id,
      inputIds,
    } satisfies DeliveryPayload)
  }

  private cancelEffect(kind: 'assessment' | 'launch' | 'delivery' | 'relay' | 'notice' | 'reply', key: string): void {
    if (typeof this.effects.remove === 'function') this.effects.remove(kind, key)
  }

  private flushInterrupts(interrupts: Array<{ ticketId: TicketId; assignmentId: string; reason: string }>): void {
    if (interrupts.length === 0) return
    const executor = this.resolveAdapter(this.executorAdapter)
    if (executor === undefined) return
    for (const interrupt of interrupts) {
      try {
        executor.interrupt(interrupt.ticketId, interrupt.assignmentId, interrupt.reason)
      } catch (error) {
        this.warn('interrupt', error)
      }
    }
  }

  private recordDecision(options: {
    thread: ThreadState
    triggerId: TriggerId
    triggerIds: TriggerId[]
    outcome: DecideResult['decision']['outcome']
    reason: Reason[]
    now: IsoTime
    policyVersion: string
    ticketId?: TicketId
  }): DecideResult['decision'] {
    const decision = {
      id: this.newId('dc'),
      thread: options.thread.key,
      triggerId: options.triggerId,
      triggerIds: options.triggerIds,
      outcome: options.outcome,
      reason: options.reason,
      at: options.now,
      policyVersion: options.policyVersion,
      ...(options.ticketId === undefined ? {} : { ticketId: options.ticketId }),
    }
    this.store.decisions.save(decision)
    options.thread.decisions.push(decision.id)
    options.thread.lastDecisionAt = options.now
    for (const id of options.triggerIds) {
      const disposition = this.store.dispositions.get(id)
      if (disposition === undefined) continue
      disposition.outcome = 'decision'
      disposition.decisionId = decision.id
      disposition.updatedAt = options.now
      if (options.ticketId !== undefined && !disposition.tickets.includes(options.ticketId)) {
        disposition.tickets.push(options.ticketId)
      }
      this.store.dispositions.save(disposition)
    }
    this.store.threads.save(options.thread)
    return decision
  }

  private ensureThread(ref: ThreadRef, now: IsoTime): ThreadState {
    const existing = this.store.threads.get(ref.key)
    if (existing !== undefined) {
      if (ref.label !== undefined && existing.label === undefined) existing.label = ref.label
      return existing
    }
    const thread: ThreadState = {
      key: ref.key,
      source: ref.source,
      ...(ref.label === undefined ? {} : { label: ref.label }),
      meta: {},
      subscriptions: [],
      context: [],
      queued: [],
      expired: 0,
      decisions: [],
    }
    this.store.threads.save(thread)
    void now
    return thread
  }

  private ensureDisposition(trigger: Trigger, now: IsoTime): Disposition {
    const existing = this.store.dispositions.get(trigger.id)
    if (existing !== undefined) return existing
    return {
      triggerId: trigger.id,
      thread: trigger.thread.key,
      outcome: 'queued',
      tickets: [],
      acked: [],
      handedBack: [],
      updatedAt: now,
    }
  }

  private recordDisposition(trigger: Trigger, now: IsoTime, mutate: (disposition: Disposition) => void): void {
    const disposition = this.ensureDisposition(trigger, now)
    mutate(disposition)
    disposition.updatedAt = now
    this.store.dispositions.save(disposition)
  }

  private gateContext(thread: ThreadState): { hasTickets: boolean } {
    return { hasTickets: thread.subscriptions.length > 0 }
  }

  private deriveTitle(trigger: Trigger, thread: ThreadState): string {
    const text = trigger.text.replace(/\s+/g, ' ').trim()
    if (text !== '') return truncate(text, 80)
    if (thread.label !== undefined) return thread.label
    return `${trigger.source} ${trigger.thread.key}`
  }

  private scopeOf(trigger: Trigger): string {
    const metaScope = trigger.meta.scope
    if (typeof metaScope === 'string' && metaScope !== '') return metaScope
    return `${trigger.source}:${trigger.channel.to}`
  }

  private isPerson(trigger: Trigger): boolean {
    return trigger.actor.bot !== true
  }

  private newId(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`
  }

  private now(): IsoTime {
    return this.clock.now()
  }

  private currentPolicy(): Policy {
    return this.policyProvider.current()
  }

  private safePolicyPaused(): boolean {
    try {
      return this.currentPolicy().paused
    } catch (error) {
      this.warn('policy', error)
      return false
    }
  }

  private safePolicyVersion(): string {
    try {
      return this.currentPolicy().version
    } catch {
      return 'unknown'
    }
  }

  private isPaused(): boolean {
    return this.commandedPause || this.safePolicyPaused()
  }

  private evalTimeoutMs(): number {
    const value = this.currentPolicy().evalTimeoutMs
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
    return this.fallbackTimeoutMs
  }

  private markPaused(now: IsoTime): void {
    if (this.pausedAt !== undefined) return
    this.pausedAt = now
    this.store.kv.set('pause.startedAt', now)
  }

  private liftPause(now: IsoTime): void {
    const startedAt = this.pausedAt ?? this.store.kv.get<IsoTime>('pause.startedAt')
    this.pausedAt = undefined
    this.store.kv.delete('pause.startedAt')
    if (startedAt === undefined) return
    const startMs = Date.parse(startedAt)
    for (const thread of this.store.threads.active()) {
      const evalRun = thread.eval
      if (evalRun?.deliveredAt === undefined || evalRun.deadlineAt === undefined) continue
      const deliveredMs = Date.parse(evalRun.deliveredAt)
      const overlapStart = Math.max(startMs, deliveredMs)
      const shift = Date.parse(now) - overlapStart
      if (shift <= 0) continue
      evalRun.deadlineAt = new Date(Date.parse(evalRun.deadlineAt) + shift).toISOString()
      this.store.threads.save(thread)
    }
  }

  private resolveAdapter<T>(adapter: Adapter<T> | undefined): T | undefined {
    if (adapter === undefined) return undefined
    try {
      return typeof adapter === 'function' ? (adapter as () => T)() : adapter
    } catch (error) {
      this.warn('adapter', error)
      return undefined
    }
  }

  private guard<T>(name: string, fallback: T, fn: () => T): T {
    try {
      return fn()
    } catch (error) {
      this.warn(name, error)
      return fallback
    }
  }

  private guardVoid(name: string, fn: () => void): void {
    try {
      fn()
    } catch (error) {
      this.warn(name, error)
    }
  }

  private warn(where: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.logger?.warn(`superagent engine ${where} failed`, { error: message })
  }
}

/** Build the Engine for the Runtime's composition root. */
export function createEngine(deps: EngineDeps): Engine {
  return new Engine(deps)
}

export type { ActorRef, ChannelAddress }
