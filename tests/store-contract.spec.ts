import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { MemoryStore, SqliteStore, createMemoryStore, openStore } from '../src/app/store.js'
import type { AppStore, EffectRow } from '../src/core/stores.js'
import type {
  Decision,
  Receipt,
  ThreadState,
  Ticket,
  Trigger,
} from '../src/core/model.js'
import { makeTrigger } from './core-fixtures.js'

const AT = '2026-01-01T00:00:00.000Z'

function makeThread(key: string, overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    key,
    source: 'telegram',
    meta: {},
    subscriptions: [],
    context: [],
    queued: [],
    expired: 0,
    decisions: [],
    ...overrides,
  }
}

function makeTicket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id,
    title: `Ticket ${id}`,
    createdAt: AT,
    updatedAt: AT,
    state: 'open',
    origin: { triggerId: 'tr_1', triggerIds: ['tr_1'] },
    mandate: {
      policyVersion: 'policy-1',
      strength: 'explicit',
      rules: [],
      source: 'telegram',
      scope: 'telegram:chat-1',
      sender: { id: 'u1' },
      via: 'addressed',
      at: AT,
    },
    follows: [{ key: 'chat-1', source: 'telegram', own: true }],
    subscriptions: [{ key: 'chat-1', source: 'telegram' }],
    channels: [{ source: 'telegram', thread: 'chat-1', to: 'chat-1' }],
    inputs: [],
    assignments: [],
    ...overrides,
  }
}

function makeDecision(id: string, thread: string, overrides: Partial<Decision> = {}): Decision {
  return {
    id,
    thread,
    triggerId: 'tr_1',
    triggerIds: ['tr_1'],
    outcome: 'accept',
    reason: [{ code: 'asked' }],
    at: AT,
    policyVersion: 'policy-1',
    ...overrides,
  }
}

function makeReceipt(id: string, overrides: Partial<Receipt> = {}): Receipt {
  return {
    id,
    purpose: 'answer',
    channel: { source: 'telegram', thread: 'chat-1', to: 'chat-1' },
    status: 'pending',
    createdAt: AT,
    failures: 0,
    ...overrides,
  }
}

function makeEffectRow(kind: EffectRow['kind'], key: string, overrides: Partial<EffectRow> = {}): EffectRow {
  return {
    kind,
    key,
    payload: { hello: key },
    seq: 0,
    dueAt: AT,
    attempts: 0,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  }
}

const variants: Array<{ name: string; create: () => AppStore; persistent: boolean }> = [
  { name: 'memory', create: () => createMemoryStore(), persistent: false },
  { name: 'sqlite', create: () => new SqliteStore(':memory:'), persistent: false },
]

describe.each(variants)('$name store', ({ create }) => {
  let store: AppStore

  afterEach(() => {
    store?.close()
  })

  store = create()
  // Recreate per test so the tests stay independent.
  const fresh = (): AppStore => {
    store?.close()
    store = create()
    return store
  }

  it('stores Triggers once and answers has()', () => {
    const db = fresh()
    const trigger = makeTrigger({ id: 'tr_1' })
    expect(db.triggers.has('tr_1')).toBe(false)
    db.triggers.save(trigger)
    expect(db.triggers.has('tr_1')).toBe(true)
    expect(db.triggers.get('tr_1')).toEqual(trigger)
    expect(db.triggers.get('missing')).toBeUndefined()
  })

  it('lists only active Threads', () => {
    const db = fresh()
    db.threads.save(makeThread('idle'))
    db.threads.save(makeThread('queued', { queued: ['tr_1'] }))
    db.threads.save(
      makeThread('evaluating', {
        eval: { id: 'ev_1', triggerIds: ['tr_2'], startedAt: AT, expiries: 0 },
      }),
    )
    expect(db.threads.active().map(thread => thread.key).sort()).toEqual(['evaluating', 'queued'])
  })

  it('lists open Tickets and the active working set', () => {
    const db = fresh()
    db.tickets.save(makeTicket('tk_open_idle'))
    db.tickets.save(
      makeTicket('tk_open_input', {
        assignments: [],
        inputs: [{ id: 'in_1', kind: 'trigger', at: AT, triggerId: 'tr_2' }],
      }),
    )
    db.tickets.save(
      makeTicket('tk_open_launching', {
        assignments: [{ id: 'as_1', ticketId: 'tk_open_launching', state: 'pending', createdAt: AT }],
      }),
    )
    db.tickets.save(
      makeTicket('tk_ended', {
        state: 'ended',
        ends: { at: AT, by: 'person', reason: 'stopped', outcome: 'abandoned' },
        inputs: [{ id: 'in_2', kind: 'trigger', at: AT, triggerId: 'tr_3' }],
      }),
    )
    expect(db.tickets.open().map(ticket => ticket.id).sort()).toEqual([
      'tk_open_idle',
      'tk_open_input',
      'tk_open_launching',
    ])
    expect(db.tickets.active().map(ticket => ticket.id).sort()).toEqual(['tk_open_input', 'tk_open_launching'])
  })

  it('stores Decisions and receipts', () => {
    const db = fresh()
    db.decisions.save(makeDecision('dc_1', 'chat-1'))
    expect(db.decisions.get('dc_1')?.outcome).toBe('accept')

    db.receipts.save(makeReceipt('r1', { createdAt: '2026-01-01T00:00:02.000Z' }))
    db.receipts.save(makeReceipt('r0', { createdAt: '2026-01-01T00:00:01.000Z' }))
    db.receipts.save(makeReceipt('r2', { status: 'sent', createdAt: '2026-01-01T00:00:00.000Z' }))
    expect(db.receipts.pending().map(receipt => receipt.id)).toEqual(['r0', 'r1'])
  })

  it('keeps key-value records and filters keys by prefix', () => {
    const db = fresh()
    db.kv.set('pause.commanded', true)
    db.kv.set('pause.resume:tk_1', { ticketId: 'tk_1' })
    db.kv.set('other', 42)
    expect(db.kv.get<boolean>('pause.commanded')).toBe(true)
    expect(db.kv.keys('pause.resume:')).toEqual(['pause.resume:tk_1'])
    expect(db.kv.keys('pause.')).toHaveLength(2)
    db.kv.delete('pause.commanded')
    expect(db.kv.get('pause.commanded')).toBeUndefined()
    // A prefix containing LIKE wildcards is matched literally.
    db.kv.set('100%_done', 'yes')
    expect(db.kv.keys('100%_')).toEqual(['100%_done'])
  })

  it('stores dispositions', () => {
    const db = fresh()
    db.dispositions.save({
      triggerId: 'tr_1',
      thread: 'chat-1',
      outcome: 'decision',
      tickets: ['tk_1'],
      acked: [],
      handedBack: [{ ticketId: 'tk_1', reason: 'nope', at: AT }],
      updatedAt: AT,
    })
    expect(db.dispositions.get('tr_1')?.handedBack[0]?.reason).toBe('nope')
  })

  it('keeps one effect row per kind and key, preserving queue order', () => {
    const db = fresh()
    db.effects.save(makeEffectRow('launch', 'as_1', { seq: 1 }))
    db.effects.save(makeEffectRow('delivery', 'as_1', { seq: 2 }))
    db.effects.save(makeEffectRow('launch', 'as_1', { payload: { replaced: true } }))
    expect(db.effects.all()).toHaveLength(2)
    expect(db.effects.get('launch', 'as_1')?.seq).toBe(1)
    expect(db.effects.get('launch', 'as_1')?.payload).toEqual({ replaced: true })
    expect(db.effects.due(AT).map(row => row.kind)).toEqual(['launch', 'delivery'])
    db.effects.remove('launch', 'as_1')
    expect(db.effects.get('launch', 'as_1')).toBeUndefined()
  })

  it('commits and rolls back one transaction', () => {
    const db = fresh()
    db.atomic(() => {
      db.triggers.save(makeTrigger({ id: 'tr_1' }))
    })
    expect(db.triggers.has('tr_1')).toBe(true)

    expect(() =>
      db.atomic(() => {
        db.triggers.save(makeTrigger({ id: 'tr_2' }))
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(db.triggers.has('tr_2')).toBe(false)

    // Nested atomic calls take part in the outer transaction.
    expect(() =>
      db.atomic(() => {
        db.atomic(() => {
          db.triggers.save(makeTrigger({ id: 'tr_3' }))
        })
        throw new Error('nested boom')
      }),
    ).toThrow('nested boom')
    expect(db.triggers.has('tr_3')).toBe(false)
  })

  it('reads a Thread timeline, snapshots and Tickets', () => {
    const db = fresh()
    db.triggers.save(makeTrigger({ id: 'tr_1', at: '2026-01-01T00:00:01.000Z' }))
    db.triggers.save(makeTrigger({ id: 'tr_2', at: '2026-01-01T00:00:02.000Z' }))
    db.triggers.save(
      makeTrigger({
        id: 'tr_3',
        at: '2026-01-01T00:00:03.000Z',
        threadKey: 'chat-2',
        correlations: [{ key: 'chat-1', source: 'telegram' }],
      }),
    )
    db.threads.save(makeThread('chat-1', { subscriptions: ['tk_1'], label: 'Main chat', queued: ['tr_1'] }))
    db.tickets.save(makeTicket('tk_1', { updatedAt: '2026-01-01T00:00:02.000Z' }))
    db.tickets.save(
      makeTicket('tk_2', {
        updatedAt: '2026-01-01T00:00:03.000Z',
        ends: { at: AT, by: 'executor', reason: 'ready', outcome: 'completed' },
        state: 'ended',
        subscriptions: [{ key: 'chat-1', source: 'telegram' }],
      }),
    )

    expect(db.read.threadTriggers('chat-1').map(trigger => trigger.id)).toEqual(['tr_1', 'tr_2', 'tr_3'])
    expect(db.read.threadTriggers('chat-1', { limit: 2 }).map(trigger => trigger.id)).toEqual(['tr_2', 'tr_3'])
    expect(
      db.read
        .threadTriggers('chat-1', { before: '2026-01-01T00:00:02.000Z|tr_2' })
        .map(trigger => trigger.id),
    ).toEqual(['tr_1'])
    expect(db.read.ticketTriggers('tk_1').map(trigger => trigger.id)).toEqual(['tr_1'])

    const snapshot = db.read.threadSnapshot('chat-1')!
    expect(snapshot.thread.label).toBe('Main chat')
    expect(snapshot.tickets.map(ticket => ticket.id)).toEqual(['tk_1', 'tk_2'])
    expect(db.read.threadSnapshot('missing')).toBeUndefined()

    expect(db.read.relatedTickets('chat-1').map(ticket => ticket.id)).toEqual(['tk_1', 'tk_2'])
    expect(db.read.recentTickets().map(ticket => ticket.id)).toEqual(['tk_2', 'tk_1'])
    expect(db.read.activeThreads().map(thread => thread.key)).toEqual(['chat-1'])
  })

  it('searches Triggers, Tickets and Decisions', () => {
    const db = fresh()
    db.triggers.save(makeTrigger({ id: 'tr_1', text: 'please fix the pipeline' }))
    db.tickets.save(makeTicket('tk_1', { title: 'Fix pipeline' }))
    db.decisions.save(makeDecision('dc_1', 'chat-1', { reason: [{ code: 'said', said: 'pipeline trouble' }] }))
    const results = db.read.search('pipeline')
    expect(results.map(result => result.kind).sort()).toEqual(['decision', 'ticket', 'trigger'])
    expect(db.read.search('pipeline', 1)).toHaveLength(1)
  })
})

describe('SqliteStore file handling', () => {
  it('persists data across an idempotent reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'superagent-store-'))
    try {
      const file = join(directory, 'superagent.sqlite')
      const first = new SqliteStore(file)
      first.triggers.save(makeTrigger({ id: 'tr_1' }))
      first.kv.set('schema-probe', 'ok')
      first.close()
      first.close() // idempotent

      const second = new SqliteStore(file)
      expect(second.triggers.has('tr_1')).toBe(true)
      expect(second.kv.get('schema-probe')).toBe('ok')
      second.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('opens the default file from openStore', () => {
    const directory = mkdtempSync(join(tmpdir(), 'superagent-store-'))
    try {
      const store = openStore({ stateDir: directory })
      store.kv.set('hello', 'world')
      expect(store.path).toBe(join(directory, 'superagent.sqlite'))
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses a database written by a newer schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'superagent-store-'))
    try {
      const file = join(directory, 'superagent.sqlite')
      const store = new SqliteStore(file)
      store.close()
      const raw = new DatabaseSync(file)
      raw.prepare('UPDATE superagent_meta SET value = ? WHERE name = ?').run('999', 'schema_version')
      raw.close()

      expect(() => new SqliteStore(file)).toThrow(/newer than supported/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('throws a clear error when the database cannot be opened', () => {
    const directory = mkdtempSync(join(tmpdir(), 'superagent-store-'))
    try {
      expect(() => new SqliteStore(directory)).toThrow(/cannot be opened/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('MemoryStore', () => {
  it('is a fresh instance each time', () => {
    const first = new MemoryStore()
    first.triggers.save(makeTrigger({ id: 'tr_1' }))
    const second = createMemoryStore()
    expect(second.triggers.has('tr_1')).toBe(false)
    first.close()
    second.close()
  })

  it('returns copies so callers cannot mutate stored state', () => {
    const store = createMemoryStore()
    const trigger = makeTrigger({ id: 'tr_1' })
    store.triggers.save(trigger)
    const loaded = store.triggers.get('tr_1')!
    loaded.text = 'mutated'
    expect(store.triggers.get('tr_1')?.text).toBe('please do the thing')
    store.close()
  })
})
