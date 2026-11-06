/**
 * Domain model of the personal SuperAgent.
 *
 * The model follows the design in `docs/000-architecture.md`: a Source turns
 * environment events into Triggers, a Thread orders Triggers, Eval decides
 * whether new work starts, a Ticket owns authorized work, an Assignment hands
 * the Ticket to an Executor, and a Channel carries writes back to the Source.
 *
 * All times are ISO-8601 strings produced by `new Date().toISOString()` so that
 * stored values compare as text and survive JSON round-trips unchanged.
 */

/** A stable identifier of any stored object. */
export type Id = string
/** An ISO-8601 instant, always UTC. */
export type IsoTime = string

export type SourceId = string
export type ThreadKey = string
export type TriggerId = Id
export type TicketId = Id
export type DecisionId = Id
export type AssignmentId = Id
export type EvalId = Id

// ---------------------------------------------------------------------------
// Triggers and Threads
// ---------------------------------------------------------------------------

/** How a person or bot is identified on its own Source. */
export interface ActorRef {
  id: string
  name?: string
}

/** An actor plus whether the Source classifies it as a bot. */
export interface Actor extends ActorRef {
  bot?: boolean
}

/** A conversation, issue, pull request, or other stream of related events. */
export interface ThreadRef {
  key: ThreadKey
  source: SourceId
  /** Human-readable label such as `#12 Fix CI`; Source-owned, never parsed. */
  label?: string
}

/** Where a write (ack, answer, result, attention message) must go. */
export interface ChannelAddress {
  source: SourceId
  thread: ThreadKey
  /** Source-specific destination: a chat id, an issue number, etc. */
  to: string
  /** Optional destination for a threaded reply (comment id, message id). */
  replyTo?: string
}

/** Whether the event addresses the agent, per the Source's own semantics. */
export type Addressed = 'mention' | 'direct' | 'none' | 'ci'

/**
 * One immutable environment event that a Source decided to admit.
 * Sources drop noise before creating a Trigger; the Engine never re-parses the
 * Source's native payload beyond `meta`.
 */
export interface Trigger {
  id: TriggerId
  source: SourceId
  /** The Source kind's own event kind, e.g. `message`, `comment`, `ci`. */
  kind: string
  at: IsoTime
  /** The primary Thread this Trigger belongs to. */
  thread: ThreadRef
  /** Other Threads the same event is evidence for; adds context, never routes. */
  correlations?: ThreadRef[]
  actor: Actor
  addressed: Addressed
  /** The text a person wrote or a compact description of an automated event. */
  text: string
  /** Where the Source would reply if this Trigger becomes a Ticket. */
  channel: ChannelAddress
  /** Source-owned metadata. The core does not interpret it. */
  meta: Record<string, unknown>
}

/** The outcome of offering a Trigger to the Engine. */
export type ReceiveDisposition = 'stored' | 'duplicate' | 'filtered' | 'failed'

/** A running or queued Eval of one Thread's Trigger batch. */
export interface EvalRun {
  id: EvalId
  triggerIds: TriggerId[]
  startedAt: IsoTime
  /** When the candidate reached the main Session; the deadline counts from here. */
  deliveredAt?: IsoTime
  deadlineAt?: IsoTime
  /** Consecutive expiry count; the third expiry records `unavailable`. */
  expiries: number
}

/** The stored aggregate of a Thread. */
export interface ThreadState {
  key: ThreadKey
  source: SourceId
  label?: string
  meta: Record<string, unknown>
  /** Live Tickets that receive this Thread's Triggers as context. */
  subscriptions: TicketId[]
  /** Tickets that follow the Thread for context only; they lend no authority. */
  context: TicketId[]
  /** Triggers waiting for their next Eval. */
  queued: TriggerId[]
  eval?: EvalRun
  /** Consecutive expiries of Evals on this Thread. */
  expired: number
  /** Decision ids in time order, most recent last. */
  decisions: DecisionId[]
  lastTriggerAt?: IsoTime
  lastDecisionAt?: IsoTime
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/** How strongly a person's or bot's event asks for work. */
export type Strength = 'explicit' | 'inferred' | 'not_admitted'

/** How the gate admitted a Trigger. */
export type MandateVia = 'addressed' | 'followup' | 'admission' | 'bot'

/** What an accept grants: the authority under which a Ticket may act. */
export interface Mandate {
  policyVersion: string
  strength: Strength
  /** Ids of the Policy rules that matched, for proactive accepts. */
  rules: string[]
  source: SourceId
  /** The receiving scope, e.g. `telegram:dm` or `github:owner/repo`. */
  scope: string
  /** The admission row when the Source has one. */
  row?: string
  sender: ActorRef
  via: MandateVia
  at: IsoTime
}

export type DecisionOutcome = 'accept' | 'stop' | 'ignore' | 'unavailable'

/** Why something happened; codes are localized by the panel and prompts. */
export interface Reason {
  code: string
  values?: Record<string, string | number>
  /** The Trigger of a batch the reason is about, when it is about one. */
  triggerId?: TriggerId
  /** Free text an assessor or a person wrote. */
  said?: string
}

export interface Decision {
  id: DecisionId
  thread: ThreadKey
  triggerId: TriggerId
  triggerIds: TriggerId[]
  outcome: DecisionOutcome
  reason: Reason[]
  at: IsoTime
  policyVersion: string
  ticketId?: TicketId
  /** A person dismissed the problem this `unavailable` Decision shows. */
  dismissedAt?: IsoTime
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export type ThreadOutcome = 'merged' | 'closed' | 'completed'

/** A Thread a Ticket follows, and whether the Ticket opened it. */
export interface FollowRef extends ThreadRef {
  own: boolean
  closed?: { at: IsoTime; outcome: ThreadOutcome }
}

export type TicketState = 'open' | 'ended'

export interface TicketEnd {
  at: IsoTime
  by: 'person' | 'main' | 'executor' | 'system'
  reason: string
  outcome: ThreadOutcome | 'dropped' | 'abandoned'
}

export type ReportKind =
  | 'progress'
  | 'waiting'
  | 'ready'
  | 'blocked'
  | 'failed'
  | 'dropped'

export interface PullRequestRef {
  repo: string
  number: number
  url: string
  state?: 'open' | 'merged' | 'closed'
  head?: string
  base?: string
}

/** A worker's structured report to its Ticket. */
export interface Report {
  kind: ReportKind
  /** Human-readable summary; short, because it may be forwarded verbatim. */
  summary: string
  at: IsoTime
  /** A concrete question for a person, required for `blocked`. */
  question?: string
  pullRequest?: PullRequestRef
  facts?: Record<string, unknown>
}

/** Context delivered to a Ticket. */
export interface Input {
  id: Id
  kind: 'trigger' | 'policy' | 'resume' | 'text'
  at: IsoTime
  triggerId?: TriggerId
  text?: string
  /** True when a person wrote the delivered text. */
  person?: boolean
  readAt?: IsoTime
}

/** The binding of a Ticket to one Executor Session. */
export interface Assignment {
  id: AssignmentId
  ticketId: TicketId
  state: 'pending' | 'running' | 'ended'
  createdAt: IsoTime
  startedAt?: IsoTime
  endedAt?: IsoTime
  sessionId?: string
  directory?: string
  report?: Report
}

export interface TicketExecution {
  /** Executor name, e.g. `dsh`. */
  name: string
  /** Absolute directory the worker works in. */
  directory: string
  /** Model selection recorded for audit; the preset may override it. */
  model?: string
}

/** A unit of authorized work. */
export interface Ticket {
  id: TicketId
  title: string
  createdAt: IsoTime
  updatedAt: IsoTime
  state: TicketState
  /** The admissible Trigger that gave its Eval's batch its strength. */
  origin: { triggerId: TriggerId; triggerIds: TriggerId[] }
  mandate: Mandate
  ends?: TicketEnd
  /** Threads a Source made this Ticket follow, such as its pull request. */
  follows: FollowRef[]
  subscriptions: ThreadRef[]
  channels: ChannelAddress[]
  inputs: Input[]
  assignments: Assignment[]
  latestReport?: Report
  execution?: TicketExecution
  /** The last failed Input delivery, until a delivery succeeds. */
  delivery?: { error: string; at: IsoTime }
  workerSessionId?: string
  /** True after a `blocked`/`failed` report until a human message arrives. */
  waitingForPerson?: boolean
}

// ---------------------------------------------------------------------------
// Messages and receipts
// ---------------------------------------------------------------------------

export type ReplyPurpose =
  | 'acknowledgement'
  | 'answer'
  | 'result'
  | 'attention'
  | 'notice'

/** A message the Engine wants a Source to send. */
export interface OutboundMessage {
  id: Id
  ticketId?: TicketId
  purpose: ReplyPurpose
  channel: ChannelAddress
  text: string
  markdown?: 'plain' | 'telegram' | 'github'
  at: IsoTime
  meta?: Record<string, unknown>
}

export type ReceiptStatus = 'pending' | 'sent' | 'dropped'

/** What a Source's Channel write did. */
export type SendOutcome = 'sent' | 'gone' | 'waiting' | 'failed'

/** Kinds of durable side effects the application can enqueue. */
export type EffectKind =
  | 'assessment'
  | 'launch'
  | 'delivery'
  | 'relay'
  | 'notice'
  | 'reply'

/** The durable record of one outbound message. */
export interface Receipt {
  id: Id
  ticketId?: TicketId
  purpose: ReplyPurpose
  channel: ChannelAddress
  status: ReceiptStatus
  createdAt: IsoTime
  waitingSince?: IsoTime
  sentAt?: IsoTime
  droppedAt?: IsoTime
  /** `channelGone` or `channelIgnored` when dropped. */
  dropReason?: string
  failures: number
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

/** The read-only view of a Thread an assessment or a tool may use. */
export interface ThreadSnapshot {
  thread: ThreadState
  triggers: Trigger[]
  tickets: Ticket[]
}

/** What the main Session receives to judge one Eval. */
export interface Candidate {
  eval: EvalRun
  primaryTrigger: Trigger
  triggers: Trigger[]
  thread: ThreadSnapshot
  /** Open Tickets related to the candidate, open ones first. */
  relatedTickets: Ticket[]
  ticketsTotal: number
  policyVersion: string
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type AcceptMode = 'off' | 'observe' | 'auto'

/** One kind of proactive work a person wrote a rule for. */
export interface PolicyRule {
  id: string
  name: string
  enabled: boolean
  instructions: string
}

/** One Source's part of the Policy. */
export interface SourcePolicy {
  /** People who may start work through this Source. */
  allowed: ActorRef[]
  /** Bots whose messages may become inferred candidates. */
  bots?: ActorRef[]
  /** GitHub repositories this Source listens to, `owner/name`. */
  repositories?: string[]
  /** Telegram chat ids the Source listens to, besides direct messages. */
  chats?: string[]
}

/** The versioned rules under which work is accepted. */
export interface Policy {
  version: string
  mode: AcceptMode
  rules: PolicyRule[]
  sources: Record<SourceId, SourcePolicy>
  paused: boolean
  evalTimeoutMs: number
}
