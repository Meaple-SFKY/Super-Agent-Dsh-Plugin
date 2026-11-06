import { describe, expect, it, vi } from 'vitest'

import { Defer, Effects } from '../src/app/effects.js'
import { createMemoryStore } from '../src/app/store.js'
import { FakeClock, silentLogger } from './core-fixtures.js'

function harness(options: { baseMs?: number; maxMs?: number } = {}) {
  const store = createMemoryStore()
  const clock = new FakeClock()
  const effects = new Effects({
    store,
    clock,
    logger: silentLogger,
    retry: { baseMs: options.baseMs ?? 100, maxMs: options.maxMs ?? 1_000 },
  })
  return { store, clock, effects }
}

function epoch(value: string | undefined): number {
  return value === undefined ? Number.NaN : Date.parse(value)
}

describe('Effects', () => {
  it('coalesces one row per kind and key without changing queue order', () => {
    const { store, effects, clock } = harness()
    effects.enqueue('launch', 'as_1', { ticketId: 'tk_1' })
    effects.enqueue('delivery', 'as_1', { ticketId: 'tk_1' })
    const originalSeq = store.effects.get('launch', 'as_1')!.seq

    clock.advance(5_000)
    effects.enqueue('launch', 'as_1', { ticketId: 'tk_1', replaced: true })

    expect(store.effects.all()).toHaveLength(2)
    expect(store.effects.get('launch', 'as_1')!.payload).toEqual({ ticketId: 'tk_1', replaced: true })
    expect(store.effects.get('launch', 'as_1')!.seq).toBe(originalSeq)
    expect(store.effects.get('launch', 'as_1')!.dueAt).toBe(clock.now())
  })

  it('runs a due handler after commit, removes the row and clears health', async () => {
    const { store, effects } = harness()
    const handler = vi.fn(async (payload: unknown) => {
      expect(payload).toEqual({ ticketId: 'tk_1' })
    })
    effects.handle('launch', handler)
    effects.enqueue('launch', 'as_1', { ticketId: 'tk_1' })

    await effects.pump()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(store.effects.all()).toEqual([])
    expect(effects.idle()).toBe(true)
    expect(effects.health().find(entry => entry.kind === 'launch')?.state).toBe('idle')
  })

  it('does not run a row before its due time', async () => {
    const { store, effects } = harness({ baseMs: 100 })
    let calls = 0
    effects.handle('delivery', () => {
      calls += 1
      throw new Error('no slot')
    })
    effects.enqueue('delivery', 'as_9', { ticketId: 'tk_9' })
    await effects.pump()
    expect(calls).toBe(1)
    expect(store.effects.get('delivery', 'as_9')!.attempts).toBe(1)

    await effects.pump()
    expect(calls).toBe(1) // due 100 ms later
    expect(store.effects.get('delivery', 'as_9')!.attempts).toBe(1)
  })

  it('retries failures with exponential backoff and reports health after three', async () => {
    const { store, clock, effects } = harness({ baseMs: 100, maxMs: 1_000 })
    let failures = 0
    effects.handle('assessment', () => {
      failures += 1
      throw new Error(`boom ${failures}`)
    })
    effects.enqueue('assessment', 'ev_1', { evalId: 'ev_1' })

    await effects.pump()
    let row = store.effects.get('assessment', 'ev_1')!
    expect(row.attempts).toBe(1)
    expect(epoch(row.dueAt)).toBe(epoch(clock.now()) + 100)
    expect(effects.health().find(entry => entry.kind === 'assessment')?.state).toBe('pending')

    // Not due yet.
    await effects.pump()
    expect(store.effects.get('assessment', 'ev_1')!.attempts).toBe(1)

    clock.advance(100)
    await effects.pump()
    row = store.effects.get('assessment', 'ev_1')!
    expect(row.attempts).toBe(2)
    expect(epoch(row.dueAt)).toBe(epoch(clock.now()) + 200)

    clock.advance(200)
    await effects.pump()
    row = store.effects.get('assessment', 'ev_1')!
    expect(row.attempts).toBe(3)
    const health = effects.health().find(entry => entry.kind === 'assessment')!
    expect(health.state).toBe('error')
    expect(health.failures).toBe(3)
    expect(health.lastError).toContain('boom 3')

    // A success clears the row and the health entry.
    effects.handle('assessment', () => undefined)
    clock.advance(400)
    await effects.pump()
    expect(store.effects.get('assessment', 'ev_1')).toBeUndefined()
    expect(effects.health().find(entry => entry.kind === 'assessment')?.state).toBe('idle')
  })

  it('defers without counting a failure', async () => {
    const { store, clock, effects } = harness({ baseMs: 100 })
    effects.handle('delivery', () => {
      throw new Defer('no worker slot', 250)
    })
    effects.enqueue('delivery', 'as_1', { ticketId: 'tk_1' })

    await effects.pump()
    const row = store.effects.get('delivery', 'as_1')!
    expect(row.attempts).toBe(0)
    expect(epoch(row.dueAt)).toBe(epoch(clock.now()) + 250)
    expect(effects.health().find(entry => entry.kind === 'delivery')?.state).toBe('pending')
  })

  it('holds back later ordered rows while an earlier one fails', async () => {
    const { store, clock, effects } = harness({ baseMs: 100 })
    const calls: string[] = []
    let failFirst = true
    effects.handle('relay', payload => {
      calls.push(String((payload as { code?: string }).code))
      if (failFirst) throw new Error('main session offline')
    })
    effects.enqueue('relay', 'r1', { code: 'one' })
    effects.enqueue('relay', 'r2', { code: 'two' })

    await effects.pump()
    expect(calls).toEqual(['one'])

    clock.advance(100)
    failFirst = false
    await effects.pump()
    expect(calls).toEqual(['one', 'one', 'two'])
    expect(store.effects.all()).toEqual([])
  })

  it('runs unordered rows concurrently up to the concurrency limit', async () => {
    const { effects } = harness()
    const ran: string[] = []
    effects.handle(
      'delivery',
      async payload => {
        ran.push(String((payload as { ticketId?: string }).ticketId))
      },
      { concurrency: 2 },
    )
    effects.enqueue('delivery', 'a', { ticketId: 'tk_a' })
    effects.enqueue('delivery', 'b', { ticketId: 'tk_b' })
    effects.enqueue('delivery', 'c', { ticketId: 'tk_c' })
    await effects.pump()
    expect(ran.sort()).toEqual(['tk_a', 'tk_b', 'tk_c'])
    expect(effects.pending()).toEqual([])
  })

  it('rolls back an enqueue with its transaction', () => {
    const { store, effects } = harness()
    expect(() =>
      store.atomic(() => {
        effects.enqueue('launch', 'as_1', { ticketId: 'tk_1' })
        throw new Error('rollback')
      }),
    ).toThrow('rollback')
    expect(store.effects.all()).toEqual([])
  })

  it('leaves rows for kinds without a handler pending', async () => {
    const { store, effects } = harness()
    effects.enqueue('reply', 'msg_1', { message: { id: 'msg_1' } })
    await effects.pump()
    expect(store.effects.all()).toHaveLength(1)
    expect(effects.health().find(entry => entry.kind === 'reply')?.pending).toBe(1)
  })

  it('processes rows enqueued before the handler was registered', async () => {
    const { effects } = harness()
    effects.enqueue('notice', 'n1', { code: 'ticket_ended' })
    const handler = vi.fn()
    effects.handle('notice', handler)
    await effects.pump()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('start pumps in the background and drain stops it, preserving pending rows', async () => {
    const { store, effects } = harness()
    const seen: string[] = []
    effects.handle('notice', payload => {
      seen.push(String((payload as { code?: string }).code))
    })
    effects.enqueue('notice', 'n1', { code: 'ticket_ended' })
    effects.start()
    await new Promise(resolve => setTimeout(resolve, 25))
    await effects.drain()
    expect(seen).toContain('ticket_ended')
    expect(store.effects.all()).toEqual([])

    // A failing row survives a drain.
    effects.handle('relay', () => {
      throw new Error('still offline')
    })
    effects.enqueue('relay', 'r1', { code: 'report_ready' })
    effects.start()
    await new Promise(resolve => setTimeout(resolve, 25))
    await effects.drain()
    expect(store.effects.get('relay', 'r1')?.attempts).toBeGreaterThanOrEqual(1)
  })

  it('keeps attempts and last error when a waiting key is coalesced', async () => {
    const { store, effects } = harness({ baseMs: 100 })
    effects.handle('assessment', () => {
      throw new Error('provider down')
    })
    effects.enqueue('assessment', 'ev_1', { evalId: 'ev_1', attempt: 1 })
    await effects.pump()
    effects.enqueue('assessment', 'ev_1', { evalId: 'ev_1', attempt: 2 })
    const row = store.effects.get('assessment', 'ev_1')!
    expect(row.attempts).toBe(1)
    expect(row.lastError).toBe('provider down')
  })
})

describe('Effects on a SQLite store', () => {
  it('persists queued rows across a reopen', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { SqliteStore } = await import('../src/app/store.js')

    const directory = mkdtempSync(join(tmpdir(), 'superagent-effects-'))
    try {
      const file = join(directory, 'superagent.sqlite')
      const clock = new FakeClock()
      const first = new SqliteStore(file)
      const firstEffects = new Effects({ store: first, clock, logger: silentLogger, retry: { baseMs: 100 } })
      firstEffects.enqueue('launch', 'as_1', { ticketId: 'tk_1' })
      first.close()

      const second = new SqliteStore(file)
      const secondEffects = new Effects({ store: second, clock, logger: silentLogger, retry: { baseMs: 100 } })
      const handler = vi.fn()
      secondEffects.handle('launch', handler)
      await secondEffects.pump()
      expect(handler).toHaveBeenCalledTimes(1)
      expect(second.effects.all()).toEqual([])
      second.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
