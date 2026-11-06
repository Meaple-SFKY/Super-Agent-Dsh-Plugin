/**
 * Event-driven effect scheduling (task-56): wake(), next-due retry timers and
 * per-kind concurrency. These tests use a real in-memory store and real timers.
 */

import { describe, expect, it } from 'vitest'

import { Defer, createEffects } from '../src/app/effects.js'
import { createMemoryStore } from '../src/app/store.js'
import type { Effects } from '../src/app/effects.js'

function makeQueue(options: Parameters<typeof createEffects>[0] extends infer O ? Omit<O, 'store'> : never = {} as never): Effects {
  return createEffects({ store: createMemoryStore(), intervalMs: 60_000, ...options })
}

async function until(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  if (!condition()) throw new Error('timed out')
}

describe('effects wake + next-due scheduling (task-56)', () => {
  it('runs a due effect shortly after wake() even without start()', async () => {
    const effects = makeQueue()
    const seen: string[] = []
    effects.handle('launch', payload => {
      seen.push(String((payload as { id: string }).id))
    })
    const started = Date.now()
    effects.enqueue('launch', 'a', { id: 'a' })
    effects.wake()
    await until(() => seen.length === 1, 300)
    expect(seen).toEqual(['a'])
    expect(Date.now() - started).toBeLessThan(300)
    await effects.stop()
  })

  it('re-runs a Deferred row on its next-due timer, not the fallback interval', async () => {
    const effects = makeQueue()
    let calls = 0
    effects.handle('launch', () => {
      calls += 1
      if (calls === 1) throw new Defer('retry shortly', 80)
    })
    const started = Date.now()
    effects.enqueue('launch', 'a', {})
    effects.wake()
    await until(() => calls === 2, 600)
    expect(Date.now() - started).toBeLessThan(600)
    await effects.stop()
  })

  it('runs up to the configured per-kind concurrency, never more', async () => {
    const effects = createEffects({
      store: createMemoryStore(),
      intervalMs: 60_000,
      concurrency: { launch: 2 },
    })
    let active = 0
    let maxActive = 0
    let completed = 0
    effects.handle('launch', async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 40))
      active -= 1
      completed += 1
    })
    for (const key of ['a', 'b', 'c']) effects.enqueue('launch', key, {})
    effects.wake()
    await until(() => completed === 3, 2_000)
    expect(maxActive).toBe(2)
    await effects.stop()
  })

  it('stop() clears the wake timer', async () => {
    const effects = makeQueue()
    let calls = 0
    effects.handle('launch', () => {
      calls += 1
    })
    effects.enqueue('launch', 'a', {})
    effects.wake(50)
    await effects.stop()
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(calls).toBe(0)
  })
})
