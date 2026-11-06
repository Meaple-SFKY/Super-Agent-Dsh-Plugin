/**
 * Stall watchdog.
 *
 * A worker that stops reporting is not necessarily broken: long CI runs and
 * big refactors are normal. So the watchdog first asks for a status report and
 * only escalates — interrupt + retry — after a second threshold with still no
 * report. Both steps are bounded and idempotent per assignment.
 */

import type { Assignment, IsoTime, Ticket, TicketId } from '../core/model.js'
import type { EffectsPort, Engine, ExecutorPort, Store } from '../core/ports.js'
import type { AppLogger } from './support.js'
import { errorMessage, nowIso } from './support.js'

export interface WatchdogConfig {
  /** No report for this long → request a status report (default 10 min). */
  stallMs?: number
  /** Still no report this long after the request → interrupt and retry (default 10 min). */
  escalateMs?: number
  /** Scan interval (default 60 s). */
  intervalMs?: number
  /** An open ticket with no active assignment and no terminal report waits this long before a self-heal (default = stallMs). */
  silentMs?: number
  /** Maximum automatic retries for one silent ticket (default 2, then health only). */
  silentMaxAttempts?: number
}

export interface WatchdogOptions {
  store: Store
  executor: ExecutorPort
  engine: () => Engine
  effects?: EffectsPort
  logger: AppLogger
  now?: () => IsoTime
  config?: WatchdogConfig
  /** Pause/safe-mode gate: no automatic action while proactive work is paused. */
  isPaused?: () => boolean
  /** Health sink for the silent-ticket self-heal (the runtime owns the registry). */
  reportHealth?: (name: string, state: 'ready' | 'error', detail?: string) => void
}

/** KV prefix of the bounded self-heal counter, one per ticket. */
const SILENT_KEY_PREFIX = 'superagent.watchdog.silent.'
const DEFAULT_SILENT_ATTEMPTS = 2

const DEFAULT_STALL_MS = 10 * 60_000
const DEFAULT_ESCALATE_MS = 10 * 60_000
const DEFAULT_INTERVAL_MS = 60_000

function lastActivity(assignment: Assignment): IsoTime | undefined {
  return assignment.report?.at ?? assignment.startedAt ?? assignment.createdAt
}

/** Latest progress signal of a Ticket: update, report or delivered input. */
function latestTicketActivity(ticket: Ticket): IsoTime | undefined {
  let latest: IsoTime | undefined = ticket.updatedAt
  const reportAt = ticket.latestReport?.at
  if (reportAt !== undefined && (latest === undefined || reportAt > latest)) latest = reportAt
  for (const input of ticket.inputs) {
    if (latest === undefined || input.at > latest) latest = input.at
  }
  return latest
}

function elapsedMs(now: number, since: IsoTime | undefined): number | undefined {
  if (!since) return undefined
  const parsed = Date.parse(since)
  if (!Number.isFinite(parsed)) return undefined
  return now - parsed
}

export class Watchdog {
  private readonly options: WatchdogOptions
  private readonly logger: AppLogger
  private readonly now: () => IsoTime
  private timer?: ReturnType<typeof setInterval>
  private readonly requestedAt = new Map<string, number>()
  private scans = 0
  private lastScanAt?: IsoTime
  private warned = false
  private silentRetries = 0
  private silentExhausted: string[] = []

  constructor(options: WatchdogOptions) {
    this.options = options
    this.logger = options.logger
    this.now = options.now ?? nowIso
  }

  /** Start the periodic scan (unref'ed timer; never throws). */
  start(): void {
    if (this.timer) return
    const interval = Math.max(5_000, this.options.config?.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.timer = setInterval(() => {
      try {
        this.scan()
      } catch (error) {
        this.logger.warn('watchdog scan failed', { error: errorMessage(error) })
      }
    }, interval)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.requestedAt.clear()
  }

  /** One scan: request status, then escalate. Safe to call manually in tests. */
  scan(): void {
    this.scans += 1
    this.lastScanAt = this.now()
    const parsedNow = Date.parse(this.lastScanAt)
    const now = Number.isFinite(parsedNow) ? parsedNow : Date.now()
    const stallMs = this.options.config?.stallMs ?? DEFAULT_STALL_MS
    const escalateMs = this.options.config?.escalateMs ?? DEFAULT_ESCALATE_MS
    const active = new Set<string>()
    for (const ticket of this.options.store.tickets.open()) {
      const assignment = this.runningAssignment(ticket)
      if (!assignment) continue
      const key = `${ticket.id}:${assignment.id}`
      active.add(key)
      const elapsed = elapsedMs(now, lastActivity(assignment))
      if (elapsed === undefined || elapsed < stallMs) {
        this.requestedAt.delete(key)
        continue
      }
      const requested = this.requestedAt.get(key)
      if (requested === undefined) {
        const asked = this.options.executor.requestStatus(ticket, assignment)
        this.requestedAt.set(key, now)
        this.logger.info('watchdog requested a status report', {
          ticketId: ticket.id,
          assignmentId: assignment.id,
          elapsedMs: elapsed,
          asked,
        })
        continue
      }
      if (now - requested < escalateMs) continue
      this.escalate(ticket, assignment)
    }
    for (const key of [...this.requestedAt.keys()]) {
      if (!active.has(key)) this.requestedAt.delete(key)
    }
    this.scanSilent(now)
  }

  /**
   * Bounded self-heal for a Ticket whose turn ended without a report.
   *
   * The Engine ends an Assignment when a turn ends; without a report the
   * Ticket then has no pending/running Assignment, so the stall scan above
   * never sees it. After `silentMs` without progress we retry it (which
   * creates a fresh Assignment and a launch effect) at most
   * `silentMaxAttempts` times; the counter lives in KV, so a restart keeps the
   * budget. Once the budget is exhausted the watchdog records
   * `watchdog:silent` health and stops acting. Recent progress (ticket
   * activity within the window), a terminal report, or a person-waiting state
   * resets the counter; a still-active or queued retry keeps it, so a failed
   * retry cannot loop forever.
   */
  private scanSilent(now: number): void {
    if (this.options.isPaused?.() === true) return
    const kv = this.options.store.kv
    const silentMs = this.options.config?.silentMs ?? this.options.config?.stallMs ?? DEFAULT_STALL_MS
    const maxAttempts = Math.max(1, this.options.config?.silentMaxAttempts ?? DEFAULT_SILENT_ATTEMPTS)
    const exhausted: string[] = []
    const seen = new Set<string>()
    let retries = 0
    for (const ticket of this.options.store.tickets.open()) {
      const key = SILENT_KEY_PREFIX + ticket.id
      seen.add(ticket.id)
      if (this.isAwaitingPerson(ticket)) {
        kv.delete(key)
        continue
      }
      if (ticket.assignments.some(assignment => assignment.state === 'pending' || assignment.state === 'running')) {
        // A running Assignment has its own stall path above; a pending one is a
        // queued launch. Keep the counter: a failed retry must use the budget.
        continue
      }
      const elapsed = elapsedMs(now, latestTicketActivity(ticket))
      if (elapsed === undefined || elapsed < silentMs) {
        kv.delete(key)
        continue
      }
      const previous = Number(kv.get<number>(key) ?? 0)
      if (previous >= maxAttempts) {
        exhausted.push(ticket.id)
        continue
      }
      try {
        this.options.engine().people.retryTicket(ticket.id)
        kv.set(key, previous + 1)
        retries += 1
        this.logger.warn('watchdog retried a ticket whose turn ended without a report', {
          ticketId: ticket.id,
          attempt: previous + 1,
          maxAttempts,
        })
      } catch (error) {
        this.logger.warn('watchdog could not retry a silent ticket', { ticketId: ticket.id, error: errorMessage(error) })
      }
    }
    for (const key of kv.keys(SILENT_KEY_PREFIX)) {
      if (!seen.has(key.slice(SILENT_KEY_PREFIX.length))) kv.delete(key)
    }
    this.silentRetries += retries
    this.silentExhausted = exhausted
    this.options.reportHealth?.(
      'watchdog:silent',
      exhausted.length > 0 ? 'error' : 'ready',
      exhausted.length > 0
        ? `tickets without progress after ${maxAttempts} automatic retries: ${exhausted.slice(0, 5).join(', ')}`
        : undefined,
    )
  }

  private isAwaitingPerson(ticket: Ticket): boolean {
    if (ticket.waitingForPerson === true) return true
    const report = ticket.latestReport
    if (report === undefined) return false
    return report.kind === 'ready' || report.kind === 'blocked' || report.kind === 'failed' || report.kind === 'dropped'
  }

  private runningAssignment(ticket: Ticket): Assignment | undefined {
    for (let index = ticket.assignments.length - 1; index >= 0; index--) {
      const assignment = ticket.assignments[index]
      if (assignment?.state === 'running') return assignment
    }
    return undefined
  }

  private escalate(ticket: Ticket, assignment: Assignment): void {
    const key = `${ticket.id}:${assignment.id}`
    this.requestedAt.delete(key)
    this.logger.warn('watchdog escalating a stalled assignment', { ticketId: ticket.id, assignmentId: assignment.id })
    try {
      this.options.engine().executor.assignmentInterrupted(ticket.id, assignment.id)
    } catch (error) {
      this.logger.warn('could not mark the stalled assignment interrupted', { error: errorMessage(error) })
    }
    try {
      this.options.executor.interrupt(ticket.id, assignment.id, 'stalled: no report after status request')
    } catch (error) {
      this.logger.warn('could not interrupt the stalled assignment', { error: errorMessage(error) })
    }
    const fresh = this.options.store.tickets.get(ticket.id)
    if (!fresh || fresh.state === 'ended') return
    const pending = fresh.assignments.filter(item => item.state === 'pending').pop()
    if (!pending) {
      this.logger.warn('stalled assignment has no replacement to launch', { ticketId: ticket.id })
      return
    }
    this.options.effects?.enqueue('launch', `launch:${ticket.id}:${pending.id}`, {
      ticketId: ticket.id,
      assignmentId: pending.id,
    })
    if (!this.warned) {
      this.warned = true
      this.logger.warn('a worker was interrupted for stalling; retry queued', { ticketId: ticket.id })
    }
  }

  /** Diagnostic snapshot for the panel/health. */
  stats(): {
    scans: number
    lastScanAt?: IsoTime
    waiting: number
    silentRetries: number
    silentExhausted: string[]
  } {
    return {
      scans: this.scans,
      ...(this.lastScanAt ? { lastScanAt: this.lastScanAt } : {}),
      waiting: this.requestedAt.size,
      silentRetries: this.silentRetries,
      silentExhausted: [...this.silentExhausted],
    }
  }
}

/** Convenience: the assignments the watchdog considers stalled right now. */
export function stalledAssignments(store: Store, config: WatchdogConfig = {}, now = Date.now()): Array<{ ticketId: TicketId; assignmentId: string }> {
  const stallMs = config.stallMs ?? DEFAULT_STALL_MS
  const result: Array<{ ticketId: TicketId; assignmentId: string }> = []
  for (const ticket of store.tickets.open()) {
    for (const assignment of ticket.assignments) {
      if (assignment.state !== 'running') continue
      const elapsed = elapsedMs(now, lastActivity(assignment))
      if (elapsed !== undefined && elapsed >= stallMs) result.push({ ticketId: ticket.id, assignmentId: assignment.id })
    }
  }
  return result
}
