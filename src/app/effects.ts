/**
 * The durable side-effect queue.
 *
 * A domain command calls `enqueue(kind, key, payload)` inside its Store
 * transaction; the row commits or rolls back with the command. Execution only
 * happens in `pump()` / the `start()` loop, i.e. after commit, and every
 * handler invocation is awaited inside a `try/catch` — nothing is
 * fire-and-forget, because the host turns an unhandled rejection into a fatal
 * `process.exit(1)`.
 *
 * Rules (from `docs/000-architecture.md` §6 and the prototype's effects doc):
 *
 * - one row per `kind` + `key`; enqueuing the same waiting key replaces its
 *   payload and makes it due immediately, without changing queue order;
 * - failures retry with exponential backoff, a per-row attempt counter and a
 *   per-kind health entry that turns to `error` after three consecutive
 *   failures;
 * - `relay` and `notice` keep strict order: a failed row holds back the later
 *   ones of its kind;
 * - `Defer` reschedules without counting a failure (a full worker slot, an
 *   offline Source, an earlier message of the same conversation).
 */

import type { Clock, EffectsPort } from '../core/ports.js'
import type { EffectKind, IsoTime } from '../core/model.js'
import type { AppStore, EffectRow } from '../core/stores.js'

export type EffectHandler = (payload: unknown, row: EffectRow) => void | Promise<void>

export interface EffectsLogger {
  warn(message: string, extra?: Record<string, unknown>): void
}

export interface EffectHandlerOptions {
  /** How many rows of this kind may run at once. Defaults to 1. */
  concurrency?: number
  /** When true, a waiting row holds back later rows of the same kind. */
  ordered?: boolean
  /** Backoff for this kind; defaults to the queue-wide retry settings. */
  retry?: { baseMs?: number; maxMs?: number }
  /** Extra claim predicate (e.g. per-Source ordering); false defers to a later pass. */
  canRun?: (row: EffectRow) => boolean
}

export interface EffectsOptions {
  store: AppStore
  clock?: Clock
  /** Convenience alternative to `clock`. */
  now?: () => IsoTime
  logger?: EffectsLogger
  /** Handlers may also be registered later with `handle()`. */
  handlers?: Partial<Record<EffectKind, EffectHandler>>
  concurrency?: Partial<Record<EffectKind, number>>
  /** Backoff for every kind, unless a kind overrides it. */
  retry?: { baseMs?: number; maxMs?: number }
  /** Per-kind backoff, e.g. replies retry from 5 s where reports retry from 2 s. */
  retryByKind?: Partial<Record<EffectKind, { baseMs?: number; maxMs?: number }>>
  /** Fallback pump interval; wake()/next-due scheduling normally beats it. Defaults to 5 s. */
  intervalMs?: number
}

export interface EffectHealth {
  kind: EffectKind
  state: 'idle' | 'pending' | 'error'
  pending: number
  /** Consecutive failures of this kind's effects. */
  failures: number
  lastError?: string
}

/**
 * Reschedule without counting a failure: the work is fine but cannot run yet.
 * `delayMs` defaults to the kind's retry base.
 */
export class Defer extends Error {
  readonly delayMs?: number

  constructor(message = 'deferred', delayMs?: number) {
    super(message)
    this.name = 'Defer'
    this.delayMs = delayMs
  }
}

interface RegisteredHandler {
  handler: EffectHandler
  concurrency: number
  ordered: boolean
  canRun?: (row: EffectRow) => boolean
  retryBaseMs: number
  retryMaxMs: number
}

const DEFAULT_RETRY_BASE_MS = 2_000
const DEFAULT_RETRY_MAX_MS = 60_000
const DEFAULT_INTERVAL_MS = 5_000
/** Kinds whose later rows wait for an earlier failed row. */
const DEFAULT_ORDERED: EffectKind[] = ['relay', 'notice']

function addMilliseconds(at: IsoTime, milliseconds: number): IsoTime {
  return new Date(Date.parse(at) + milliseconds).toISOString()
}

function rowId(kind: EffectKind, key: string): string {
  return `${kind}\u0000${key}`
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** The durable effect queue and its pump loop. */
export class Effects implements EffectsPort {
  private readonly store: AppStore
  private readonly clock: Clock
  private readonly logger?: EffectsLogger
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly intervalMs: number
  private readonly retryByKind: Partial<Record<EffectKind, { baseMs?: number; maxMs?: number }>>
  private readonly defaultConcurrencyByKind: Partial<Record<EffectKind, number>>
  private readonly handlers = new Map<EffectKind, RegisteredHandler>()
  private readonly inFlight = new Set<string>()
  private readonly failures = new Map<EffectKind, number>()
  private readonly lastErrors = new Map<EffectKind, string>()
  private pumping: Promise<void> | undefined
  private pumpRequested = false
  private timer: ReturnType<typeof setInterval> | undefined
  private dueTimer: ReturnType<typeof setTimeout> | undefined
  private stopping = false

  constructor(options: EffectsOptions) {
    this.store = options.store
    this.clock = options.clock ?? { now: options.now ?? (() => new Date().toISOString()) }
    this.logger = options.logger
    this.retryBaseMs = options.retry?.baseMs ?? DEFAULT_RETRY_BASE_MS
    this.retryMaxMs = options.retry?.maxMs ?? DEFAULT_RETRY_MAX_MS
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.retryByKind = options.retryByKind ?? {}
    this.defaultConcurrencyByKind = options.concurrency ?? {}

    for (const [kind, handler] of Object.entries(options.handlers ?? {})) {
      if (handler !== undefined) {
        this.handle(kind as EffectKind, handler, { concurrency: options.concurrency?.[kind as EffectKind] })
      }
    }
  }

  /** Register the handler of one kind. Called by Runtime during assembly. */
  handle(kind: EffectKind, handler: EffectHandler, options: EffectHandlerOptions = {}): void {
    const perKind = options.retry ?? this.retryByKind[kind]
    this.handlers.set(kind, {
      handler,
      concurrency: Math.max(1, options.concurrency ?? this.defaultConcurrencyByKind[kind] ?? 1),
      ordered: options.ordered ?? DEFAULT_ORDERED.includes(kind),
      ...(options.canRun ? { canRun: options.canRun } : {}),
      retryBaseMs: perKind?.baseMs ?? this.retryBaseMs,
      retryMaxMs: perKind?.maxMs ?? this.retryMaxMs,
    })
  }

  /** Enqueue (or coalesce) inside the caller's transaction. Never executes. */
  enqueue(kind: EffectKind, key: string, payload: unknown): void {
    const now = this.clock.now()
    const existing = this.store.effects.get(kind, key)
    if (existing !== undefined) {
      this.store.effects.save({ ...existing, payload, dueAt: now, updatedAt: now })
      return
    }
    this.store.effects.save({
      kind,
      key,
      payload,
      seq: 0,
      dueAt: now,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })
  }

  /** Cancel one row, used by the Outbox when a message is withdrawn. */
  remove(kind: EffectKind, key: string): void {
    this.store.effects.remove(kind, key)
  }

  /** Begin the background pump. Safe to call more than once. */
  start(): void {
    if (this.timer !== undefined || this.stopping) return
    this.timer = setInterval(() => {
      void this.pumpSafely()
    }, this.intervalMs)
    this.timer.unref?.()
    void this.pumpSafely()
  }

  /**
   * Ask the pump to run now. Call this after a committed command (Source
   * receive, Engine decision, tool action) instead of waiting for the next
   * interval: it is the event-driven fast path. Safe to call from anywhere;
   * coalesces multiple wakes into one pump.
   */
  wake(delayMs = 0): void {
    if (this.stopping) return
    if (this.dueTimer !== undefined) clearTimeout(this.dueTimer)
    this.dueTimer = setTimeout(() => {
      this.dueTimer = undefined
      void this.pumpSafely()
    }, Math.max(0, delayMs))
    this.dueTimer.unref?.()
  }

  /** Schedule one pump for the earliest future `dueAt` (retries/Defer). */
  private scheduleNextDue(): void {
    if (this.stopping) return
    if (this.dueTimer !== undefined) return
    const now = Date.now()
    let earliest: number | undefined
    for (const row of this.store.effects.all()) {
      const due = Date.parse(row.dueAt)
      if (!Number.isFinite(due)) continue
      if (earliest === undefined || due < earliest) earliest = due
    }
    if (earliest === undefined) return
    const delay = Math.max(0, Math.min(earliest - now, this.intervalMs))
    if (delay === 0) {
      this.wake(0)
      return
    }
    this.dueTimer = setTimeout(() => {
      this.dueTimer = undefined
      void this.pumpSafely()
    }, delay)
    this.dueTimer.unref?.()
  }

  /** Stop the pump, await in-flight handlers, keep pending rows. */
  async drain(): Promise<void> {
    this.stopping = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (this.dueTimer !== undefined) {
      clearTimeout(this.dueTimer)
      this.dueTimer = undefined
    }
    while (this.pumping !== undefined) {
      await this.pumping.catch(() => undefined)
    }
    this.stopping = false
  }

  /** `drain` under the name the prototype uses. */
  async stop(): Promise<void> {
    await this.drain()
  }

  /** One pass over due rows. Tests call this directly. */
  async pump(): Promise<void> {
    if (this.stopping) return
    while (this.pumping !== undefined) {
      this.pumpRequested = true
      await this.pumping.catch(() => undefined)
    }
    if (this.stopping) return
    this.pumping = this.runOnce()
    try {
      await this.pumping
    } finally {
      this.pumping = undefined
      this.scheduleNextDue()
    }
    if (this.pumpRequested) {
      this.pumpRequested = false
      await this.pump()
    }
  }

  /** Alias of `pump` for the passes loop in Runtime. */
  async runPass(): Promise<void> {
    await this.pump()
  }

  pending(): EffectRow[] {
    return this.store.effects.all()
  }

  idle(): boolean {
    return this.store.effects.all().length === 0 && this.inFlight.size === 0
  }

  health(): EffectHealth[] {
    const rows = this.store.effects.all()
    const kinds = new Set<EffectKind>([...this.handlers.keys(), ...rows.map(row => row.kind)])
    return [...kinds].sort().map(kind => {
      const pending = rows.filter(row => row.kind === kind).length
      const failures = this.failures.get(kind) ?? 0
      const lastError = this.lastErrors.get(kind)
      const state: EffectHealth['state'] = failures >= 3 ? 'error' : pending > 0 ? 'pending' : 'idle'
      return { kind, state, pending, failures, ...(lastError === undefined ? {} : { lastError }) }
    })
  }

  // -- internals -----------------------------------------------------------

  private async pumpSafely(): Promise<void> {
    try {
      await this.pump()
    } catch (error) {
      this.logger?.warn('superagent effects pass failed', { error: describeError(error) })
    }
  }

  private async runOnce(): Promise<void> {
    let progressed = true
    while (progressed && !this.stopping) {
      progressed = false
      const now = this.clock.now()
      const rows = this.store.effects.all()
      const ranThisRound: Promise<void>[] = []
      for (const [kind, registered] of this.handlers) {
        const kindRows = rows.filter(row => row.kind === kind && !this.inFlight.has(rowId(row.kind, row.key)))
        if (kindRows.length === 0) continue
        let claimable: EffectRow[]
        if (registered.ordered) {
          const first = kindRows[0]
          if (first === undefined || first.dueAt > now) continue
          claimable = [first]
        } else {
          const inFlightCount = [...this.inFlight].filter(id => id.startsWith(`${kind}\u0000`)).length
          const available = Math.max(0, registered.concurrency - inFlightCount)
          if (available === 0) continue
          claimable = kindRows
            .filter(row => row.dueAt <= now && (registered.canRun?.(row) ?? true))
            .slice(0, available)
        }
        for (const row of claimable) {
          this.inFlight.add(rowId(row.kind, row.key))
          ranThisRound.push(this.runRow(registered, row))
        }
      }
      if (ranThisRound.length === 0) break
      progressed = true
      await Promise.all(ranThisRound)
    }
  }

  private async runRow(registered: RegisteredHandler, row: EffectRow): Promise<void> {
    const id = rowId(row.kind, row.key)
    try {
      await registered.handler(row.payload, row)
      const current = this.store.effects.get(row.kind, row.key)
      if (current === undefined) return
      if (current.updatedAt !== row.updatedAt || JSON.stringify(current.payload) !== JSON.stringify(row.payload)) {
        // Re-enqueued while the handler ran: keep the newer work.
        return
      }
      this.store.atomic(() => {
        this.store.effects.remove(row.kind, row.key)
      })
      this.failures.set(row.kind, 0)
      this.lastErrors.delete(row.kind)
    } catch (error) {
      if (error instanceof Defer) {
        const now = this.clock.now()
        const delay = error.delayMs ?? registered.retryBaseMs
        this.store.atomic(() => {
          this.store.effects.save({ ...row, dueAt: addMilliseconds(now, delay), updatedAt: now })
        })
        return
      }
      const now = this.clock.now()
      const attempts = row.attempts + 1
      const delay = Math.min(registered.retryMaxMs, registered.retryBaseMs * 2 ** (attempts - 1))
      const message = describeError(error)
      this.store.atomic(() => {
        this.store.effects.save({
          ...row,
          attempts,
          lastError: message,
          dueAt: addMilliseconds(now, delay),
          updatedAt: now,
        })
      })
      this.failures.set(row.kind, attempts)
      this.lastErrors.set(row.kind, message)
      this.logger?.warn('superagent effect failed', {
        kind: row.kind,
        key: row.key,
        attempts,
        retryInMs: delay,
        error: message,
      })
    } finally {
      this.inFlight.delete(id)
    }
  }
}

/** Build the effect queue for the Runtime's composition root. */
export function createEffects(options: EffectsOptions): Effects {
  return new Effects(options)
}
