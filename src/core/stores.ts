/**
 * Persistence-side types that extend the frozen `Store` contract without
 * changing it.
 *
 * `ports.ts` (frozen) is the contract every adapter and the Engine rely on. A
 * real application also needs two things the contract deliberately leaves to
 * the implementation:
 *
 * - **Dispositions**: where each Trigger went (filtered, queued for Eval,
 *   fanned out to Tickets, handed back, requeued). The architecture doc keeps
 *   this in its own table; the Engine needs it to avoid re-evaluating a
 *   person's message that already reached a Ticket and to hand back a Trigger
 *   exactly once.
 * - **The durable effect queue** (`effect` table in the architecture doc),
 *   which `src/app/effects.ts` owns.
 *
 * Both repositories are additive: `AppStore extends Store`, so every consumer
 * that only knows `Store` keeps working. `src/app/store.ts` implements this
 * interface twice (in memory and in SQLite).
 */

import type { EffectKind, IsoTime, ThreadKey, TicketId, TriggerId } from './model.js'
import type { Store } from './ports.js'

// ---------------------------------------------------------------------------
// Dispositions
// ---------------------------------------------------------------------------

export type DispositionOutcome = 'filtered' | 'queued' | 'eval' | 'decision'

/** Where one Trigger went, kept per Trigger. */
export interface Disposition {
  triggerId: TriggerId
  /** The primary Thread the Trigger was recorded on. */
  thread: ThreadKey
  outcome: DispositionOutcome
  /** A Source or gate reason code for `filtered`. */
  filteredReason?: string
  evalId?: string
  decisionId?: string
  /** Tickets the Trigger reached as context, by fan-out or attach. */
  tickets: TicketId[]
  /** Tickets whose Executor acknowledged or answered it. */
  acked: Array<{ ticketId: TicketId; at: IsoTime }>
  /** Tickets that handed the Trigger back, with their reason. */
  handedBack: Array<{ ticketId: TicketId; reason: string; at: IsoTime }>
  /** Set when a person asked for a fresh Eval of the stored Trigger. */
  requeuedAt?: IsoTime
  updatedAt?: IsoTime
}

export interface DispositionRepository {
  get(triggerId: TriggerId): Disposition | undefined
  save(disposition: Disposition): void
}

// ---------------------------------------------------------------------------
// Durable effects
// ---------------------------------------------------------------------------

/** One durable side effect, unique by `kind` + `key`. */
export interface EffectRow {
  kind: EffectKind
  key: string
  /** JSON-serializable payload the handler interprets. */
  payload: unknown
  /** Enqueue order; stable when a row is coalesced. */
  seq: number
  dueAt: IsoTime
  /** Consecutive failed attempts since the last success. */
  attempts: number
  lastError?: string
  createdAt: IsoTime
  updatedAt: IsoTime
}

export interface EffectRepository {
  get(kind: EffectKind, key: string): EffectRow | undefined
  /** Insert or update; an existing row keeps its `seq`. */
  save(row: EffectRow): void
  remove(kind: EffectKind, key: string): void
  /** Rows whose `dueAt` is at or before `at`, oldest first. */
  due(at: IsoTime): EffectRow[]
  /** Every row, oldest first. */
  all(): EffectRow[]
}

// ---------------------------------------------------------------------------
// The application store
// ---------------------------------------------------------------------------

/** `Store` plus the two work queues the Engine and Effects own. */
export interface AppStore extends Store {
  dispositions: DispositionRepository
  effects: EffectRepository
}
