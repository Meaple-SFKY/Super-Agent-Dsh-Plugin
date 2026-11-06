/**
 * Ports between the domain Engine and its adapters.
 *
 * `Engine` is synchronous and is the only writer of Triggers, Threads,
 * Decisions, Tickets and Assignments. External work (model calls, shell,
 * network writes) is enqueued as an effect inside the same transaction and
 * performed by an adapter after commit.
 */

import type {
  ActorRef,
  Assignment,
  Candidate,
  ChannelAddress,
  Decision,
  DecisionOutcome,
  EffectKind,
  Input,
  IsoTime,
  OutboundMessage,
  Policy,
  Receipt,
  Reason,
  ReceiveDisposition,
  Report,
  ThreadKey,
  ThreadSnapshot,
  Ticket,
  TicketId,
  Trigger,
  TriggerId,
  ThreadOutcome,
  ThreadState,
  SendOutcome,
} from './model.js'

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface TriggerRepository {
  get(id: TriggerId): Trigger | undefined
  has(id: TriggerId): boolean
  save(trigger: Trigger): void
}

export interface ThreadRepository {
  get(key: ThreadKey): ThreadState | undefined
  save(thread: ThreadState): void
  /** Threads with queued Triggers or a running Eval. */
  active(): ThreadState[]
}

export interface TicketRepository {
  get(id: TicketId): Ticket | undefined
  save(ticket: Ticket): void
  /** Tickets whose `ends` is unset. */
  open(): Ticket[]
  /** Open tickets with undelivered Inputs or a pending/running Assignment. */
  active(): Ticket[]
}

export interface DecisionRepository {
  get(id: string): Decision | undefined
  save(decision: Decision): void
}

export interface ReceiptRepository {
  get(id: string): Receipt | undefined
  save(receipt: Receipt): void
  /** Pending receipts, oldest first. */
  pending(): Receipt[]
}

export interface KeyValueStore {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): void
  delete(key: string): void
  keys(prefix?: string): string[]
}

/** Read-only queries used by tools, prompts and the panel. */
export interface ReadQueries {
  threadTriggers(thread: ThreadKey, options?: { limit?: number; before?: string }): Trigger[]
  ticketTriggers(ticketId: TicketId): Trigger[]
  threadSnapshot(thread: ThreadKey): ThreadSnapshot | undefined
  relatedTickets(thread: ThreadKey, limit?: number): Ticket[]
  recentTickets(limit?: number): Ticket[]
  activeThreads(limit?: number): ThreadState[]
  search(query: string, limit?: number): Array<{ kind: string; id: string; text: string }>
}

export interface Store {
  /** Run `fn` in one write transaction; roll back if it throws. */
  atomic<T>(fn: () => T): T
  triggers: TriggerRepository
  threads: ThreadRepository
  tickets: TicketRepository
  decisions: DecisionRepository
  receipts: ReceiptRepository
  kv: KeyValueStore
  read: ReadQueries
  close(): void
}

// ---------------------------------------------------------------------------
// Adapter ports
// ---------------------------------------------------------------------------

export interface Clock {
  now(): IsoTime
}

export interface PolicyProvider {
  current(): Policy
}

/** Durable, transactional side-effect queue owned by the application. */
export interface EffectsPort {
  enqueue(kind: EffectKind, key: string, payload: unknown): void
}

/** Asks the main Session to assess a candidate. */
export interface AssessorPort {
  deliver(candidate: Candidate): void
}

/** Launches and steers Executor Sessions. */
export interface ExecutorPort {
  launch(ticket: Ticket, assignment: Assignment): void
  deliver(ticket: Ticket, assignment: Assignment, inputs: Input[]): void
  /** Asks a running worker for a status report; answers whether it asked. */
  requestStatus(ticket: Ticket, assignment: Assignment): boolean
  /** Ends an Assignment, cancelling its turn when it runs. */
  interrupt(ticketId: TicketId, assignmentId: string, reason: string): void
}

/** Writes a message back through its Source. */
export interface SourceScopePort {
  channelAllowed(channel: ChannelAddress): boolean
  send(message: OutboundMessage): Promise<SendOutcome>
}

/** Queues a Channel write inside the Engine's transaction. */
export interface OutboxPort {
  queue(message: OutboundMessage): void
}

// ---------------------------------------------------------------------------
// Engine commands
// ---------------------------------------------------------------------------

export interface DecideInput {
  triggerId: TriggerId
  outcome: DecisionOutcome
  reason: Reason[]
  /** Optional Ticket title set by an accept. */
  title?: string
  /** Matched rule ids for a proactive accept. */
  rules?: string[]
  /** Free note delivered to the new Ticket's worker once. */
  note?: string
}

export interface DecideResult {
  decision: Decision
  ticket?: Ticket
}

export interface AttachInput {
  ticketId: TicketId
  triggerId: TriggerId
  note?: string
}

export interface EngineForSources {
  /**
   * Store a Source's Trigger once, fan it out to subscribed Tickets and queue
   * it for Eval on its primary Thread. `filtered` means the Source's own state
   * no longer listens to the destination.
   */
  receive(trigger: Trigger): ReceiveDisposition
  /** Make an open Ticket follow one of the Source's Threads. */
  bindThread(ticketId: TicketId, thread: { key: ThreadKey; source: string; label?: string }, own: boolean): void
  /** A Thread closed (merged/closed/completed). */
  threadClosed(thread: ThreadKey, outcome: ThreadOutcome, at: IsoTime): void
}

export interface EngineForMainSession {
  /** The Eval that holds a Trigger, as the main Session sees it. */
  candidate(triggerId: TriggerId): Candidate | undefined
  /** The candidate reached the main Session; its deadline starts now. */
  candidateDelivered(evalId: string): void
  decide(input: DecideInput): DecideResult
  attach(input: AttachInput): void
  requestStatus(ticketId: TicketId): boolean
  note(ticketId: TicketId, text: string): void
  reply(message: OutboundMessage): void
}

export interface EngineForPeople {
  stopTicket(ticketId: TicketId, reason?: string): void
  retryTicket(ticketId: TicketId): void
  reevaluate(triggerId: TriggerId): void
  dismiss(decisionId: string): void
  pause(paused: boolean): void
}

export interface AssignmentStartedInput {
  ticketId: TicketId
  assignmentId: string
  sessionId?: string
}

export interface AssignmentReportedInput {
  ticketId: TicketId
  assignmentId: string
  report: Report
}

export interface EngineForExecutor {
  assignmentStarted(input: AssignmentStartedInput): void
  inputsDelivered(ticketId: TicketId, assignmentId: string, inputIds: string[]): void
  turnEnded(ticketId: TicketId, assignmentId: string): void
  deliveryFailed(ticketId: TicketId, assignmentId: string, error: string): void
  report(input: AssignmentReportedInput): void
  handback(ticketId: TicketId, triggerId: TriggerId, reason: string): void
  followForContext(ticketId: TicketId, thread: { key: ThreadKey; source: string; label?: string }): void
  markUnrelated(ticketId: TicketId, thread: ThreadKey, reason: string): void
  /** An Assignment was running when the host stopped or its session was lost. */
  assignmentInterrupted(ticketId: TicketId, assignmentId: string): void
}

export interface EngineForSettings {
  /** Rules changed; notify only live Tickets the change bears on. */
  policyChanged(from: Policy, to: Policy): void
  /** Current Policy snapshot for adapters that need it. */
  policy(): Policy
}

export interface Engine {
  sources: EngineForSources
  mainSession: EngineForMainSession
  people: EngineForPeople
  executor: EngineForExecutor
  settings: EngineForSettings
  /** Start due Evals and resume waiting work; one pass at a time. */
  evaluateDue(): void
  /** Read-only candidate access used by the assessor effect. */
  candidateOf(triggerId: TriggerId): Candidate | undefined
}
