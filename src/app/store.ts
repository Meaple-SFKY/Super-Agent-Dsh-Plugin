/**
 * The application's `Store`: the single writer of Triggers, Threads, Tickets,
 * Decisions, receipts, effects, dispositions and key-value records.
 *
 * Two implementations share one contract:
 *
 * - `MemoryStore` for the domain tests (`tests/core-*.spec.ts`) and for a
 *   degraded start where no state directory is writable.
 * - `SqliteStore` for the real application: one SQLite file, `node:sqlite`
 *   `DatabaseSync`, no native dependency. Every command runs in one write
 *   transaction; reopening an existing file is idempotent and refuses a file
 *   written by a newer schema.
 *
 * `node:sqlite` is loaded lazily through `createRequire` because the module is
 * only safe to touch after the plugin's `apply()` has run, and because the
 * guardian catches import failures. Opening failures throw a descriptive error
 * that the guardian turns into a degraded plugin instead of a crashed host.
 */

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import type {
  ChannelAddress,
  Decision,
  EffectKind,
  IsoTime,
  Receipt,
  ThreadKey,
  ThreadState,
  Ticket,
  TicketId,
  Trigger,
  TriggerId,
} from '../core/model.js'
import type {
  DecisionRepository,
  KeyValueStore,
  ReadQueries,
  ReceiptRepository,
  Store,
  ThreadRepository,
  TicketRepository,
  TriggerRepository,
} from '../core/ports.js'
import type {
  AppStore,
  Disposition,
  DispositionRepository,
  EffectRepository,
  EffectRow,
} from '../core/stores.js'

/** The schema written by this build. */
export const SCHEMA_VERSION = 1

/** How many rows a read returns when the caller leaves the limit out. */
const DEFAULT_LIMIT = 50

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return structuredClone(value)
}

function threadActive(thread: ThreadState): boolean {
  return thread.queued.length > 0 || thread.eval !== undefined
}

function ticketOpen(ticket: Ticket): boolean {
  return ticket.ends === undefined
}

function ticketActive(ticket: Ticket): boolean {
  if (ticket.ends !== undefined) return false
  if (ticket.inputs.some(input => input.readAt === undefined)) return true
  return ticket.assignments.some(a => a.state === 'pending' || a.state === 'running')
}

function compareAtThenId(a: { at: string; id: string }, b: { at: string; id: string }): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

function compareTriggers(a: Trigger, b: Trigger): number {
  return compareAtThenId({ at: a.at, id: a.id }, { at: b.at, id: b.id })
}

/** Tickets related to a Thread presentation: open ones first, newest first. */
function sortRelatedTickets(tickets: Ticket[]): Ticket[] {
  return [...tickets].sort((a, b) => {
    const openDelta = Number(ticketOpen(b)) - Number(ticketOpen(a))
    if (openDelta !== 0) return openDelta
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
    return a.id < b.id ? 1 : -1
  })
}

function threadKeysOfTicket(ticket: Ticket): ThreadKey[] {
  const keys = new Set<ThreadKey>()
  for (const thread of ticket.subscriptions) keys.add(thread.key)
  for (const follow of ticket.follows) keys.add(follow.key)
  return [...keys]
}

function triggerOnThread(trigger: Trigger, thread: ThreadKey): boolean {
  if (trigger.thread.key === thread) return true
  return (trigger.correlations ?? []).some(correlation => correlation.key === thread)
}

function parseBefore(before: string): { at: string; id?: string } {
  const index = before.indexOf('|')
  if (index < 0) return { at: before }
  return { at: before.slice(0, index), id: before.slice(index + 1) }
}

function beforeCursor(candidate: { at: string; id: string }, before: string): boolean {
  const parsed = parseBefore(before)
  if (candidate.at !== parsed.at) return candidate.at < parsed.at
  if (parsed.id === undefined) return false
  return candidate.id < parsed.id
}

/** The most recent `limit` entries, in ascending time order. */
function windowOf<T extends { at: string; id: string }>(items: T[], options?: { limit?: number; before?: string }): T[] {
  const filtered = options?.before ? items.filter(item => beforeCursor(item, options.before!)) : items
  const limit = options?.limit ?? DEFAULT_LIMIT
  return filtered.slice(Math.max(0, filtered.length - limit))
}

function ticketTriggerIds(ticket: Ticket): TriggerId[] {
  const ids: TriggerId[] = [ticket.origin.triggerId, ...ticket.origin.triggerIds]
  for (const input of ticket.inputs) if (input.triggerId) ids.push(input.triggerId)
  return [...new Set(ids)]
}

function effectRowId(kind: EffectKind, key: string): string {
  return `${kind}\u0000${key}`
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

/** In-process `AppStore`; the reference implementation used by domain tests. */
export class MemoryStore implements AppStore {
  private readonly triggersMap = new Map<TriggerId, Trigger>()
  private readonly threadsMap = new Map<ThreadKey, ThreadState>()
  private readonly ticketsMap = new Map<TicketId, Ticket>()
  private readonly ticketThreadsMap = new Map<TicketId, ThreadKey[]>()
  private readonly decisionsMap = new Map<string, Decision>()
  private readonly receiptsMap = new Map<string, Receipt>()
  private readonly kvMap = new Map<string, string>()
  private readonly dispositionsMap = new Map<TriggerId, Disposition>()
  private readonly effectsMap = new Map<string, EffectRow>()
  private effectSeq = 0
  private depth = 0
  private snapshot:
    | {
        triggers: Map<TriggerId, Trigger>
        threads: Map<ThreadKey, ThreadState>
        tickets: Map<TicketId, Ticket>
        ticketThreads: Map<TicketId, ThreadKey[]>
        decisions: Map<string, Decision>
        receipts: Map<string, Receipt>
        kv: Map<string, string>
        dispositions: Map<TriggerId, Disposition>
        effects: Map<string, EffectRow>
        effectSeq: number
      }
    | undefined

  readonly triggers: TriggerRepository
  readonly threads: ThreadRepository
  readonly tickets: TicketRepository
  readonly decisions: DecisionRepository
  readonly receipts: ReceiptRepository
  readonly kv: KeyValueStore
  readonly dispositions: DispositionRepository
  readonly effects: EffectRepository
  readonly read: ReadQueries

  constructor() {
    this.triggers = {
      get: id => {
        const value = this.triggersMap.get(id)
        return value === undefined ? undefined : clone(value)
      },
      has: id => this.triggersMap.has(id),
      save: trigger => {
        this.triggersMap.set(trigger.id, clone(trigger))
      },
    }

    this.threads = {
      get: key => {
        const value = this.threadsMap.get(key)
        return value === undefined ? undefined : clone(value)
      },
      save: thread => {
        this.threadsMap.set(thread.key, clone(thread))
      },
      active: () =>
        [...this.threadsMap.values()]
          .filter(threadActive)
          .sort((a, b) => (a.lastTriggerAt ?? '').localeCompare(b.lastTriggerAt ?? '') || a.key.localeCompare(b.key))
          .map(clone),
    }

    this.tickets = {
      get: id => {
        const value = this.ticketsMap.get(id)
        return value === undefined ? undefined : clone(value)
      },
      save: ticket => {
        this.ticketsMap.set(ticket.id, clone(ticket))
        this.ticketThreadsMap.set(ticket.id, threadKeysOfTicket(ticket))
      },
      open: () =>
        [...this.ticketsMap.values()]
          .filter(ticketOpen)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .map(clone),
      active: () =>
        [...this.ticketsMap.values()]
          .filter(ticketActive)
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))
          .map(clone),
    }

    this.decisions = {
      get: id => {
        const value = this.decisionsMap.get(id)
        return value === undefined ? undefined : clone(value)
      },
      save: decision => {
        this.decisionsMap.set(decision.id, clone(decision))
      },
    }

    this.receipts = {
      get: id => {
        const value = this.receiptsMap.get(id)
        return value === undefined ? undefined : clone(value)
      },
      save: receipt => {
        this.receiptsMap.set(receipt.id, clone(receipt))
      },
      pending: () =>
        [...this.receiptsMap.values()]
          .filter(receipt => receipt.status === 'pending')
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .map(clone),
    }

    this.kv = {
      get: <T>(key: string): T | undefined => {
        const value = this.kvMap.get(key)
        if (value === undefined) return undefined
        try {
          return JSON.parse(value) as T
        } catch {
          return undefined
        }
      },
      set: <T>(key: string, value: T): void => {
        this.kvMap.set(key, JSON.stringify(value ?? null))
      },
      delete: (key: string): void => {
        this.kvMap.delete(key)
      },
      keys: (prefix?: string): string[] =>
        [...this.kvMap.keys()].filter(key => prefix === undefined || key.startsWith(prefix)).sort(),
    }

    this.dispositions = {
      get: triggerId => {
        const value = this.dispositionsMap.get(triggerId)
        return value === undefined ? undefined : clone(value)
      },
      save: disposition => {
        this.dispositionsMap.set(disposition.triggerId, clone(disposition))
      },
    }

    this.effects = {
      get: (kind, key) => {
        const value = this.effectsMap.get(effectRowId(kind, key))
        return value === undefined ? undefined : clone(value)
      },
      save: row => {
        const id = effectRowId(row.kind, row.key)
        const existing = this.effectsMap.get(id)
        const seq = existing?.seq ?? (row.seq > 0 ? row.seq : ++this.effectSeq)
        this.effectsMap.set(id, { ...clone(row), seq })
      },
      remove: (kind, key) => {
        this.effectsMap.delete(effectRowId(kind, key))
      },
      due: at =>
        [...this.effectsMap.values()]
          .filter(row => row.dueAt <= at)
          .sort((a, b) => a.seq - b.seq)
          .map(clone),
      all: () => [...this.effectsMap.values()].sort((a, b) => a.seq - b.seq).map(clone),
    }

    const allTickets = (): Ticket[] => [...this.ticketsMap.values()]

    this.read = {
      threadTriggers: (thread, options) => {
        const items = [...this.triggersMap.values()].filter(trigger => triggerOnThread(trigger, thread)).sort(compareTriggers)
        return windowOf(items, options).map(clone)
      },
      ticketTriggers: ticketId => {
        const ticket = this.ticketsMap.get(ticketId)
        if (ticket === undefined) return []
        return ticketTriggerIds(ticket)
          .map(id => this.triggersMap.get(id))
          .filter((trigger): trigger is Trigger => trigger !== undefined)
          .sort(compareTriggers)
          .map(clone)
      },
      threadSnapshot: thread => {
        const state = this.threadsMap.get(thread)
        if (state === undefined) return undefined
        const triggers = [...this.triggersMap.values()]
          .filter(trigger => triggerOnThread(trigger, thread))
          .sort(compareTriggers)
          .map(clone)
        const tickets = allTickets()
          .filter(ticket => (this.ticketThreadsMap.get(ticket.id) ?? []).includes(thread))
          .map(clone)
        return { thread: clone(state), triggers, tickets: sortRelatedTickets(tickets) }
      },
      relatedTickets: (thread, limit) =>
        sortRelatedTickets(
          allTickets()
            .filter(ticket => (this.ticketThreadsMap.get(ticket.id) ?? []).includes(thread))
            .map(clone),
        ).slice(0, limit ?? 10),
      recentTickets: limit =>
        allTickets()
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
          .slice(0, limit ?? DEFAULT_LIMIT)
          .map(clone),
      activeThreads: limit =>
        [...this.threadsMap.values()]
          .filter(threadActive)
          .sort((a, b) => (b.lastTriggerAt ?? '').localeCompare(a.lastTriggerAt ?? '') || a.key.localeCompare(b.key))
          .slice(0, limit ?? DEFAULT_LIMIT)
          .map(clone),
      search: (query, limit) => {
        const needle = query.toLowerCase()
        const max = limit ?? 20
        const results: Array<{ kind: string; id: string; text: string }> = []
        for (const trigger of this.triggersMap.values()) {
          if (trigger.text.toLowerCase().includes(needle)) {
            results.push({ kind: 'trigger', id: trigger.id, text: trigger.text })
          }
        }
        for (const ticket of this.ticketsMap.values()) {
          if (ticket.title.toLowerCase().includes(needle)) {
            results.push({ kind: 'ticket', id: ticket.id, text: ticket.title })
          }
        }
        for (const decision of this.decisionsMap.values()) {
          for (const reason of decision.reason) {
            const text = reason.said ?? reason.code
            if (text.toLowerCase().includes(needle)) {
              results.push({ kind: 'decision', id: decision.id, text })
              break
            }
          }
        }
        return results.slice(0, max)
      },
    }
  }

  atomic<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth += 1
      try {
        return fn()
      } finally {
        this.depth -= 1
      }
    }
    this.snapshot = {
      triggers: new Map(this.triggersMap),
      threads: new Map(this.threadsMap),
      tickets: new Map(this.ticketsMap),
      ticketThreads: new Map(this.ticketThreadsMap),
      decisions: new Map(this.decisionsMap),
      receipts: new Map(this.receiptsMap),
      kv: new Map(this.kvMap),
      dispositions: new Map(this.dispositionsMap),
      effects: new Map(this.effectsMap),
      effectSeq: this.effectSeq,
    }
    this.depth = 1
    try {
      const result = fn()
      this.depth = 0
      this.snapshot = undefined
      return result
    } catch (error) {
      const snapshot = this.snapshot
      if (snapshot !== undefined) {
        this.triggersMap.clear()
        for (const [key, value] of snapshot.triggers) this.triggersMap.set(key, value)
        this.threadsMap.clear()
        for (const [key, value] of snapshot.threads) this.threadsMap.set(key, value)
        this.ticketsMap.clear()
        for (const [key, value] of snapshot.tickets) this.ticketsMap.set(key, value)
        this.ticketThreadsMap.clear()
        for (const [key, value] of snapshot.ticketThreads) this.ticketThreadsMap.set(key, value)
        this.decisionsMap.clear()
        for (const [key, value] of snapshot.decisions) this.decisionsMap.set(key, value)
        this.receiptsMap.clear()
        for (const [key, value] of snapshot.receipts) this.receiptsMap.set(key, value)
        this.kvMap.clear()
        for (const [key, value] of snapshot.kv) this.kvMap.set(key, value)
        this.dispositionsMap.clear()
        for (const [key, value] of snapshot.dispositions) this.dispositionsMap.set(key, value)
        this.effectsMap.clear()
        for (const [key, value] of snapshot.effects) this.effectsMap.set(key, value)
        this.effectSeq = snapshot.effectSeq
      }
      this.depth = 0
      this.snapshot = undefined
      throw error
    }
  }

  close(): void {
    // Nothing to release; the maps are garbage collected.
  }
}

/** Build a fresh in-memory `AppStore` (tests and degraded start). */
export function createMemoryStore(): AppStore {
  return new MemoryStore()
}

// ---------------------------------------------------------------------------
// SQLite store
// ---------------------------------------------------------------------------

type SqliteModule = typeof import('node:sqlite')
type SqliteDatabase = import('node:sqlite').DatabaseSync

let sqliteModule: SqliteModule | undefined

/** Load `node:sqlite` once, lazily, after `apply()` has run. */
function loadSqlite(): SqliteModule {
  if (sqliteModule === undefined) {
    const require = createRequire(import.meta.url)
    sqliteModule = require('node:sqlite') as SqliteModule
  }
  return sqliteModule
}

export interface OpenStoreOptions {
  /** Plugin state directory; the database lives directly inside it. */
  stateDir: string
  /** File name inside `stateDir`; defaults to `superagent.sqlite`. */
  file?: string
  now?: () => IsoTime
}

/** Open (or create) the state database under `<stateDir>/superagent.sqlite`. */
export function openStore(options: OpenStoreOptions): SqliteStore {
  const file = options.file ?? 'superagent.sqlite'
  return new SqliteStore(join(options.stateDir, file))
}

/** SQLite-backed `AppStore`; one file, one write transaction per command. */
export class SqliteStore implements AppStore {
  private readonly dbPath: string
  private readonly db: SqliteDatabase
  private depth = 0
  private closed = false
  private effectSeq = 0

  readonly triggers: TriggerRepository
  readonly threads: ThreadRepository
  readonly tickets: TicketRepository
  readonly decisions: DecisionRepository
  readonly receipts: ReceiptRepository
  readonly kv: KeyValueStore
  readonly dispositions: DispositionRepository
  readonly effects: EffectRepository
  readonly read: ReadQueries

  constructor(path: string) {
    this.dbPath = path === ':memory:' ? path : resolve(path)
    try {
      if (this.dbPath !== ':memory:') mkdirSync(dirname(this.dbPath), { recursive: true })
      const { DatabaseSync } = loadSqlite()
      this.db = new DatabaseSync(this.dbPath)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`superagent state database cannot be opened at ${this.dbPath}: ${detail}`, { cause: error })
    }
    try {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = NORMAL')
      this.db.exec('PRAGMA busy_timeout = 5000')
      this.db.exec('PRAGMA foreign_keys = ON')
      this.migrate()
    } catch (error) {
      this.db.close()
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`superagent state database cannot be initialised at ${this.dbPath}: ${detail}`, { cause: error })
    }
    this.effectSeq = this.readEffectSeq()

    this.triggers = {
      get: id => {
        const row = this.db.prepare('SELECT data FROM trigger WHERE id = ?').get(id) as { data?: string } | undefined
        return row?.data === undefined ? undefined : (JSON.parse(row.data) as Trigger)
      },
      has: id => this.db.prepare('SELECT 1 AS present FROM trigger WHERE id = ?').get(id) !== undefined,
      save: trigger => {
        this.db
          .prepare('INSERT INTO trigger (id, at, source, thread_key, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, source = excluded.source, thread_key = excluded.thread_key, data = excluded.data')
          .run(trigger.id, trigger.at, trigger.source, trigger.thread.key, JSON.stringify(trigger))
        this.db.prepare('DELETE FROM trigger_thread WHERE trigger_id = ?').run(trigger.id)
        const insert = this.db.prepare('INSERT OR IGNORE INTO trigger_thread (trigger_id, thread_key, at) VALUES (?, ?, ?)')
        insert.run(trigger.id, trigger.thread.key, trigger.at)
        for (const correlation of trigger.correlations ?? []) {
          insert.run(trigger.id, correlation.key, trigger.at)
        }
      },
    }

    this.threads = {
      get: key => {
        const row = this.db.prepare('SELECT data FROM thread WHERE key = ?').get(key) as { data?: string } | undefined
        return row?.data === undefined ? undefined : (JSON.parse(row.data) as ThreadState)
      },
      save: thread => {
        this.db
          .prepare('INSERT INTO thread (key, active, data) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET active = excluded.active, data = excluded.data')
          .run(thread.key, threadActive(thread) ? 1 : 0, JSON.stringify(thread))
      },
      active: () =>
        (this.db.prepare('SELECT data FROM thread WHERE active = 1').all() as Array<{ data: string }>)
          .map(row => JSON.parse(row.data) as ThreadState)
          .sort((a, b) => (a.lastTriggerAt ?? '').localeCompare(b.lastTriggerAt ?? '') || a.key.localeCompare(b.key)),
    }

    this.tickets = {
      get: id => {
        const row = this.db.prepare('SELECT data FROM ticket WHERE id = ?').get(id) as { data?: string } | undefined
        return row?.data === undefined ? undefined : (JSON.parse(row.data) as Ticket)
      },
      save: ticket => {
        this.db
          .prepare('INSERT INTO ticket (id, open, active, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET open = excluded.open, active = excluded.active, created_at = excluded.created_at, updated_at = excluded.updated_at, data = excluded.data')
          .run(ticket.id, ticketOpen(ticket) ? 1 : 0, ticketActive(ticket) ? 1 : 0, ticket.createdAt, ticket.updatedAt, JSON.stringify(ticket))
        this.db.prepare('DELETE FROM ticket_thread WHERE ticket_id = ?').run(ticket.id)
        const insert = this.db.prepare('INSERT OR IGNORE INTO ticket_thread (ticket_id, thread_key) VALUES (?, ?)')
        for (const key of threadKeysOfTicket(ticket)) insert.run(ticket.id, key)
      },
      open: () =>
        (this.db.prepare('SELECT data FROM ticket WHERE open = 1 ORDER BY created_at, id').all() as Array<{ data: string }>).map(
          row => JSON.parse(row.data) as Ticket,
        ),
      active: () =>
        (this.db.prepare('SELECT data FROM ticket WHERE active = 1 ORDER BY updated_at, id').all() as Array<{ data: string }>).map(
          row => JSON.parse(row.data) as Ticket,
        ),
    }

    this.decisions = {
      get: id => {
        const row = this.db.prepare('SELECT data FROM decision WHERE id = ?').get(id) as { data?: string } | undefined
        return row?.data === undefined ? undefined : (JSON.parse(row.data) as Decision)
      },
      save: decision => {
        this.db
          .prepare('INSERT INTO decision (id, thread_key, at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET thread_key = excluded.thread_key, at = excluded.at, data = excluded.data')
          .run(decision.id, decision.thread, decision.at, JSON.stringify(decision))
      },
    }

    this.receipts = {
      get: id => {
        const row = this.db.prepare('SELECT data FROM receipt WHERE id = ?').get(id) as { data?: string } | undefined
        return row?.data === undefined ? undefined : (JSON.parse(row.data) as Receipt)
      },
      save: receipt => {
        this.db
          .prepare('INSERT INTO receipt (id, status, ticket_id, created_at, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, ticket_id = excluded.ticket_id, created_at = excluded.created_at, data = excluded.data')
          .run(receipt.id, receipt.status, receipt.ticketId ?? null, receipt.createdAt, JSON.stringify(receipt))
      },
      pending: () =>
        (this.db.prepare("SELECT data FROM receipt WHERE status = 'pending' ORDER BY created_at, id").all() as Array<{ data: string }>).map(
          row => JSON.parse(row.data) as Receipt,
        ),
    }

    this.kv = {
      get: <T>(key: string): T | undefined => {
        const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: string } | undefined
        if (row?.value === undefined) return undefined
        try {
          return JSON.parse(row.value) as T
        } catch {
          return undefined
        }
      },
      set: <T>(key: string, value: T): void => {
        this.db
          .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(key, JSON.stringify(value ?? null))
      },
      delete: (key: string): void => {
        this.db.prepare('DELETE FROM kv WHERE key = ?').run(key)
      },
      keys: (prefix?: string): string[] => {
        let rows: Array<{ key: string }>
        if (prefix === undefined) {
          rows = this.db.prepare('SELECT key FROM kv ORDER BY key').all() as Array<{ key: string }>
        } else {
          const escaped = prefix.replace(/[\\%_]/g, character => `\\${character}`)
          rows = this.db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key").all(`${escaped}%`) as Array<{ key: string }>
        }
        return rows.map(row => row.key)
      },
    }

    this.dispositions = {
      get: triggerId => {
        const row = this.db.prepare('SELECT data FROM disposition WHERE trigger_id = ?').get(triggerId) as { data?: string } | undefined
        return row?.data === undefined ? undefined : (JSON.parse(row.data) as Disposition)
      },
      save: disposition => {
        this.db
          .prepare('INSERT INTO disposition (trigger_id, thread_key, outcome, data) VALUES (?, ?, ?, ?) ON CONFLICT(trigger_id) DO UPDATE SET thread_key = excluded.thread_key, outcome = excluded.outcome, data = excluded.data')
          .run(disposition.triggerId, disposition.thread, disposition.outcome, JSON.stringify(disposition))
      },
    }

    this.effects = {
      get: (kind, key) => {
        const row = this.db
          .prepare('SELECT kind, key, payload, seq, due_at, attempts, last_error, created_at, updated_at FROM effect WHERE kind = ? AND key = ?')
          .get(kind, key) as Record<string, unknown> | undefined
        return row === undefined ? undefined : this.effectFromRow(row)
      },
      save: row => {
        const existing = this.db.prepare('SELECT seq FROM effect WHERE kind = ? AND key = ?').get(row.kind, row.key) as
          | { seq: number }
          | undefined
        const seq = existing?.seq ?? (row.seq > 0 ? row.seq : ++this.effectSeq)
        this.db
          .prepare('INSERT INTO effect (kind, key, payload, seq, due_at, attempts, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET payload = excluded.payload, due_at = excluded.due_at, attempts = excluded.attempts, last_error = excluded.last_error, updated_at = excluded.updated_at')
          .run(
            row.kind,
            row.key,
            JSON.stringify(row.payload ?? null),
            seq,
            row.dueAt,
            row.attempts,
            row.lastError ?? null,
            row.createdAt,
            row.updatedAt,
          )
      },
      remove: (kind, key) => {
        this.db.prepare('DELETE FROM effect WHERE kind = ? AND key = ?').run(kind, key)
      },
      due: at =>
        (
          this.db
            .prepare('SELECT kind, key, payload, seq, due_at, attempts, last_error, created_at, updated_at FROM effect WHERE due_at <= ? ORDER BY seq')
            .all(at) as Array<Record<string, unknown>>
        ).map(row => this.effectFromRow(row)),
      all: () =>
        (
          this.db
            .prepare('SELECT kind, key, payload, seq, due_at, attempts, last_error, created_at, updated_at FROM effect ORDER BY seq')
            .all() as Array<Record<string, unknown>>
        ).map(row => this.effectFromRow(row)),
    }

    this.read = {
      threadTriggers: (thread, options) => {
        const before = options?.before
        const limit = options?.limit ?? DEFAULT_LIMIT
        const rows: Array<{ data: string }> = before === undefined
          ? (this.db
              .prepare('SELECT t.data AS data FROM trigger_thread tt JOIN trigger t ON t.id = tt.trigger_id WHERE tt.thread_key = ? ORDER BY t.at, t.id')
              .all(thread) as Array<{ data: string }>)
          : (() => {
              const parsed = parseBefore(before)
              if (parsed.id === undefined) {
                return this.db
                  .prepare('SELECT t.data AS data FROM trigger_thread tt JOIN trigger t ON t.id = tt.trigger_id WHERE tt.thread_key = ? AND t.at < ? ORDER BY t.at, t.id')
                  .all(thread, parsed.at) as Array<{ data: string }>
              }
              return this.db
                .prepare('SELECT t.data AS data FROM trigger_thread tt JOIN trigger t ON t.id = tt.trigger_id WHERE tt.thread_key = ? AND (t.at < ? OR (t.at = ? AND t.id < ?)) ORDER BY t.at, t.id')
                .all(thread, parsed.at, parsed.at, parsed.id) as Array<{ data: string }>
            })()
        const items = rows.map(row => JSON.parse(row.data) as Trigger)
        return items.slice(Math.max(0, items.length - limit))
      },
      ticketTriggers: ticketId => {
        const ticket = this.tickets.get(ticketId)
        if (ticket === undefined) return []
        return ticketTriggerIds(ticket)
          .map(id => this.triggers.get(id))
          .filter((trigger): trigger is Trigger => trigger !== undefined)
          .sort(compareTriggers)
      },
      threadSnapshot: thread => {
        const state = this.threads.get(thread)
        if (state === undefined) return undefined
        const triggers = this.read.threadTriggers(thread, { limit: DEFAULT_LIMIT })
        const ids = (this.db.prepare('SELECT ticket_id FROM ticket_thread WHERE thread_key = ?').all(thread) as Array<{ ticket_id: string }>).map(
          row => row.ticket_id,
        )
        const tickets = ids
          .map(id => this.tickets.get(id))
          .filter((ticket): ticket is Ticket => ticket !== undefined)
        return { thread: state, triggers, tickets: sortRelatedTickets(tickets) }
      },
      relatedTickets: (thread, limit) => {
        const ids = (this.db.prepare('SELECT ticket_id FROM ticket_thread WHERE thread_key = ?').all(thread) as Array<{ ticket_id: string }>).map(
          row => row.ticket_id,
        )
        const tickets = ids
          .map(id => this.tickets.get(id))
          .filter((ticket): ticket is Ticket => ticket !== undefined)
        return sortRelatedTickets(tickets).slice(0, limit ?? 10)
      },
      recentTickets: limit =>
        (this.db.prepare('SELECT data FROM ticket ORDER BY updated_at DESC, id DESC LIMIT ?').all(limit ?? DEFAULT_LIMIT) as Array<{ data: string }>).map(
          row => JSON.parse(row.data) as Ticket,
        ),
      activeThreads: limit =>
        (this.db.prepare('SELECT data FROM thread WHERE active = 1').all() as Array<{ data: string }>)
          .map(row => JSON.parse(row.data) as ThreadState)
          .sort((a, b) => (b.lastTriggerAt ?? '').localeCompare(a.lastTriggerAt ?? '') || a.key.localeCompare(b.key))
          .slice(0, limit ?? DEFAULT_LIMIT),
      search: (query, limit) => {
        const max = limit ?? 20
        const like = `%${query.toLowerCase()}%`
        const results: Array<{ kind: string; id: string; text: string }> = []
        const triggers = this.db.prepare('SELECT id, data FROM trigger WHERE LOWER(data) LIKE ? ORDER BY at DESC LIMIT ?').all(like, max) as Array<{
          id: string
          data: string
        }>
        for (const row of triggers) {
          results.push({ kind: 'trigger', id: row.id, text: (JSON.parse(row.data) as Trigger).text })
        }
        const tickets = this.db.prepare('SELECT id, data FROM ticket WHERE LOWER(data) LIKE ? ORDER BY updated_at DESC LIMIT ?').all(like, max) as Array<{
          id: string
          data: string
        }>
        for (const row of tickets) {
          results.push({ kind: 'ticket', id: row.id, text: (JSON.parse(row.data) as Ticket).title })
        }
        const decisions = this.db.prepare('SELECT id, data FROM decision WHERE LOWER(data) LIKE ? ORDER BY at DESC LIMIT ?').all(like, max) as Array<{
          id: string
          data: string
        }>
        for (const row of decisions) {
          const decision = JSON.parse(row.data) as Decision
          const reason = decision.reason.find(item => (item.said ?? item.code).toLowerCase().includes(query.toLowerCase()))
          if (reason !== undefined) results.push({ kind: 'decision', id: row.id, text: reason.said ?? reason.code })
        }
        return results.slice(0, max)
      },
    }
  }

  atomic<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth += 1
      try {
        return fn()
      } finally {
        this.depth -= 1
      }
    }
    this.depth = 1
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      this.depth = 0
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The transaction is already gone; keep the original error.
      }
      this.depth = 0
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  /** Absolute path of the database file, for logs and the watchdog. */
  get path(): string {
    return this.dbPath
  }

  // -- internals -----------------------------------------------------------

  private effectFromRow(row: Record<string, unknown>): EffectRow {
    return {
      kind: String(row.kind) as EffectKind,
      key: String(row.key),
      payload: JSON.parse(String(row.payload)),
      seq: Number(row.seq),
      dueAt: String(row.due_at),
      attempts: Number(row.attempts),
      lastError: row.last_error === null || row.last_error === undefined ? undefined : String(row.last_error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  private readEffectSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM effect').get() as { seq?: number } | undefined
    return Number(row?.seq ?? 0)
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS superagent_meta (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trigger (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        source TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trigger_at ON trigger (at, id);
      CREATE INDEX IF NOT EXISTS trigger_thread_time ON trigger (thread_key, at, id);

      CREATE TABLE IF NOT EXISTS trigger_thread (
        trigger_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (trigger_id, thread_key)
      );
      CREATE INDEX IF NOT EXISTS trigger_thread_by_thread ON trigger_thread (thread_key, at, trigger_id);

      CREATE TABLE IF NOT EXISTS disposition (
        trigger_id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        outcome TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS disposition_by_thread ON disposition (thread_key);

      CREATE TABLE IF NOT EXISTS thread (
        key TEXT PRIMARY KEY,
        active INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS thread_active ON thread (active);

      CREATE TABLE IF NOT EXISTS ticket (
        id TEXT PRIMARY KEY,
        open INTEGER NOT NULL,
        active INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ticket_open ON ticket (open, updated_at);
      CREATE INDEX IF NOT EXISTS ticket_active ON ticket (active);

      CREATE TABLE IF NOT EXISTS ticket_thread (
        ticket_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        PRIMARY KEY (ticket_id, thread_key)
      );
      CREATE INDEX IF NOT EXISTS ticket_thread_by_thread ON ticket_thread (thread_key);

      CREATE TABLE IF NOT EXISTS decision (
        id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS decision_thread ON decision (thread_key, at, id);

      CREATE TABLE IF NOT EXISTS receipt (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        ticket_id TEXT,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS receipt_pending ON receipt (status, created_at);

      CREATE TABLE IF NOT EXISTS effect (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        payload TEXT NOT NULL,
        seq INTEGER NOT NULL,
        due_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (kind, key)
      );
      CREATE INDEX IF NOT EXISTS effect_due ON effect (due_at, seq);

      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    const row = this.db.prepare('SELECT value FROM superagent_meta WHERE name = ?').get('schema_version') as
      | { value?: string }
      | undefined
    const current = row?.value === undefined ? undefined : Number(row.value)
    if (current === undefined) {
      this.db.prepare('INSERT INTO superagent_meta (name, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
      return
    }
    if (current > SCHEMA_VERSION) {
      throw new Error(`state database schema ${current} is newer than supported schema ${SCHEMA_VERSION}`)
    }
    if (current < SCHEMA_VERSION) {
      // Only schema 1 exists so far; older files are upgraded in place.
      this.db.prepare('UPDATE superagent_meta SET value = ? WHERE name = ?').run(String(SCHEMA_VERSION), 'schema_version')
    }
  }
}

/** A `Store` this build can run on, plus the queues the Engine needs. */
export function asAppStore(store: Store): AppStore {
  if ('effects' in store && 'dispositions' in store) return store as AppStore
  throw new Error('superagent store is missing the effect queue or dispositions')
}

/** Where a receipt's Channel points, for per-conversation ordering. */
export function channelKey(channel: ChannelAddress): string {
  return `${channel.source}\u0000${channel.thread}\u0000${channel.to}`
}

/** Build a fresh disposition for a Trigger. */
export function newDisposition(trigger: Trigger, at: IsoTime): Disposition {
  return {
    triggerId: trigger.id,
    thread: trigger.thread.key,
    outcome: 'queued',
    tickets: [],
    acked: [],
    handedBack: [],
    updatedAt: at,
  }
}

export type { Disposition, EffectRow }
