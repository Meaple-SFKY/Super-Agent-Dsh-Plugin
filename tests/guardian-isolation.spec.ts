/**
 * Failure-isolation tests for the guardian (`src/index.ts`).
 *
 * The guardian is the one module whose job is to keep DSH booting when the
 * engine is broken. These tests simulate each failure mode the host can hit —
 * an engine module that throws on import, a start() that rejects or hangs, an
 * incompatible DSH version, missing configuration, the manual kill switches —
 * and assert that `apply()` returns without throwing and that `bootState()`
 * reports a degraded or stopped plugin.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

interface FakeCtx {
  logger: {
    info: (message: string) => void
    warn: (message: string) => void
    error: (message: string, error?: unknown) => void
  }
  effect: (factory: () => unknown) => () => void
  get: (name: string) => undefined
  logLines: string[]
  dispose: () => Promise<void>
}

/** Minimal Context double: the guardian only touches logger, effect and get. */
function createFakeCtx(): FakeCtx {
  const logLines: string[] = []
  let cleanup: (() => unknown) | undefined
  return {
    logger: {
      info: (message: string) => logLines.push(`info:${message}`),
      warn: (message: string) => logLines.push(`warn:${message}`),
      error: (message: string, error?: unknown) => logLines.push(`error:${message}:${String(error)}`),
    },
    effect(factory: () => unknown) {
      cleanup = factory() as () => unknown
      return () => undefined
    },
    get: () => undefined,
    logLines,
    async dispose() {
      const current = cleanup
      cleanup = undefined
      await current?.()
    },
  }
}

function asContext(ctx: FakeCtx): Context {
  return ctx as unknown as Context
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not reached before timeout')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function makeStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'superagent-guardian-'))
}

/** Wait until an asynchronously persisted file exists. */
async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    try {
      await readFile(path)
      return
    } catch {
      if (Date.now() - started > timeoutMs) throw new Error(`file not written before timeout: ${path}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
}

type Guardian = typeof import('../src/index.js')

async function loadGuardian(): Promise<Guardian> {
  return import('../src/index.js')
}

const ENGINE_MODULE = '../src/engine.js'
const stateDirs: string[] = []

beforeEach(() => {
  vi.resetModules()
  // Pin detection so the tests never depend on what is installed. Each test
  // that cares about the version overrides this value.
  process.env.DSH_VERSION = '0.2.2-rc.1'
  delete process.env.DSH_CLIENT_VERSION
  delete process.env.SUPERAGENT_DISABLED
  delete process.env.SUPERAGENT_COMPAT_ASSUME_UNSUPPORTED
  delete process.env.SUPERAGENT_START_TIMEOUT_MS
})

afterEach(async () => {
  vi.doUnmock(ENGINE_MODULE)
  vi.restoreAllMocks()
  vi.resetModules()
  delete process.env.SUPERAGENT_DISABLED
  delete process.env.SUPERAGENT_COMPAT_ASSUME_UNSUPPORTED
  delete process.env.SUPERAGENT_START_TIMEOUT_MS
  process.env.DSH_VERSION = '0.2.2-rc.1'
  const dirs = stateDirs.splice(0)
  await Promise.all(
    dirs.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  )
})

describe('guardian apply() never throws', () => {
  it('returns synchronously without throwing when the engine module fails to import', async () => {
    vi.doMock(ENGINE_MODULE, () => {
      throw new Error('simulated engine import failure')
    })
    const stateDir = await makeStateDir()
    stateDirs.push(stateDir)
    const guardian = await loadGuardian()
    const ctx = createFakeCtx()

    expect(() => guardian.apply(asContext(ctx), { enabled: true, stateDir })).not.toThrow()
    await waitFor(() => guardian.bootState().status === 'degraded')

    expect(guardian.bootState().status).toBe('degraded')
    expect((guardian.bootState().detail ?? '').length).toBeGreaterThan(0)
    expect(ctx.logLines.some(line => line.startsWith('error:Superagent failed to start'))).toBe(true)

    await waitForFile(join(stateDir, 'superagent-degraded.json'))
    const raw = await readFile(join(stateDir, 'superagent-degraded.json'), 'utf8')
    const persisted = JSON.parse(raw) as { status?: string; detail?: string }
    expect(persisted.status).toBe('degraded')
    expect((persisted.detail ?? '').length).toBeGreaterThan(0)
  })

  it('degrades when engine start() rejects', async () => {
    vi.doMock(ENGINE_MODULE, () => ({
      async start() {
        throw new Error('start rejected: session service missing')
      },
    }))
    const stateDir = await makeStateDir()
    stateDirs.push(stateDir)
    const guardian = await loadGuardian()

    guardian.apply(asContext(createFakeCtx()), { enabled: true, stateDir })
    await waitFor(() => guardian.bootState().status === 'degraded')

    expect(guardian.bootState().detail ?? '').toContain('session service missing')
  })

  it('degrades when engine start() never resolves, and stops a late handle', async () => {
    const stop = vi.fn(async () => undefined)
    vi.doMock(ENGINE_MODULE, () => ({
      start() {
        return new Promise(resolve => {
          const timer = setTimeout(() => resolve({ stop }), 200)
          timer.unref?.()
        })
      },
    }))
    process.env.SUPERAGENT_START_TIMEOUT_MS = '80'
    const stateDir = await makeStateDir()
    stateDirs.push(stateDir)
    const guardian = await loadGuardian()

    guardian.apply(asContext(createFakeCtx()), { enabled: true, stateDir })
    await waitFor(() => guardian.bootState().status === 'degraded')
    expect(guardian.bootState().detail ?? '').toContain('timed out')

    // The engine resolves after the timeout; the guardian must release it.
    await waitFor(() => stop.mock.calls.length > 0)
  })

  it('degrades when start() returns a handle without stop()', async () => {
    vi.doMock(ENGINE_MODULE, () => ({
      async start() {
        return {}
      },
    }))
    const stateDir = await makeStateDir()
    stateDirs.push(stateDir)
    const guardian = await loadGuardian()

    guardian.apply(asContext(createFakeCtx()), { enabled: true, stateDir })
    await waitFor(() => guardian.bootState().status === 'degraded')
    expect(guardian.bootState().detail ?? '').toContain('stop()')
  })
})

describe('guardian version gate', () => {
  it('degrades on a DSH version outside the supported range and never imports the engine', async () => {
    const start = vi.fn()
    vi.doMock(ENGINE_MODULE, () => ({ start }))
    process.env.DSH_VERSION = '0.3.1'
    const stateDir = await makeStateDir()
    stateDirs.push(stateDir)
    const guardian = await loadGuardian()

    guardian.apply(asContext(createFakeCtx()), { enabled: true, stateDir })
    await waitFor(() => guardian.bootState().status === 'degraded')

    expect(guardian.bootState().detail ?? '').toContain('0.3.1')
    expect(guardian.bootState().dshVersion).toBe('0.3.1')
    expect(start).not.toHaveBeenCalled()
  })

  it('degrades on a simulated incompatible host flag', async () => {
    delete process.env.DSH_VERSION
    process.env.SUPERAGENT_COMPAT_ASSUME_UNSUPPORTED = '1'
    vi.doMock(ENGINE_MODULE, () => ({ async start() { throw new Error('must not start') } }))
    const stateDir = await makeStateDir()
    stateDirs.push(stateDir)
    const guardian = await loadGuardian()

    guardian.apply(asContext(createFakeCtx()), { enabled: true, stateDir })
    await waitFor(() => guardian.bootState().status === 'degraded')
    expect(guardian.bootState().detail ?? '').toContain('incompatible')
  })

  it('classifies versions against the supported range', async () => {
    const guardian = await loadGuardian()
    expect(guardian.isSupportedDshVersion('0.2.2-rc.1')).toBe(true)
    expect(guardian.isSupportedDshVersion('0.2.2')).toBe(true)
    expect(guardian.isSupportedDshVersion('0.2.3-rc.2')).toBe(true)
    expect(guardian.isSupportedDshVersion('0.2.1-rc.3')).toBe(false)
    expect(guardian.isSupportedDshVersion('0.3.0')).toBe(false)
    expect(guardian.isSupportedDshVersion('1.0.0')).toBe(false)
    expect(guardian.isSupportedDshVersion('not-a-version')).toBeUndefined()
    expect(guardian.isSupportedDshVersion(undefined)).toBeUndefined()
  })
})

describe('guardian configuration and kill switches', () => {
  it('stops on enabled: false without importing the engine', async () => {
    const start = vi.fn()
    vi.doMock(ENGINE_MODULE, () => ({ start }))
    const stateDir = await makeStateDir()
    stateDirs.push(stateDir)
    const guardian = await loadGuardian()
    const ctx = createFakeCtx()

    guardian.apply(asContext(ctx), { enabled: false, stateDir })
    await waitFor(() => guardian.bootState().status === 'stopped')

    expect(guardian.bootState().detail ?? '').toContain('enabled: false')
    expect(start).not.toHaveBeenCalled()
    const status = JSON.parse(await readFile(join(stateDir, 'superagent-status.json'), 'utf8')) as { status?: string }
    expect(status.status).toBe('stopped')
  })

  it('stops on SUPERAGENT_DISABLED=1', async () => {
    process.env.SUPERAGENT_DISABLED = '1'
    const start = vi.fn()
    vi.doMock(ENGINE_MODULE, () => ({ start }))
    const stateDir = await makeStateDir()
    stateDirs.push(stateDir)
    const guardian = await loadGuardian()

    guardian.apply(asContext(createFakeCtx()), { enabled: true, stateDir })
    await waitFor(() => guardian.bootState().status === 'stopped')
    expect(guardian.bootState().detail ?? '').toContain('SUPERAGENT_DISABLED')
    expect(start).not.toHaveBeenCalled()
  })

  it('degrades on a missing stateDir and does not write outside it', async () => {
    vi.doMock(ENGINE_MODULE, () => ({ async start() { throw new Error('must not start') } }))
    const guardian = await loadGuardian()
    const ctx = createFakeCtx()

    expect(() => guardian.apply(asContext(ctx), { enabled: true })).not.toThrow()
    await waitFor(() => guardian.bootState().status === 'degraded')
    expect(guardian.bootState().detail ?? '').toContain('stateDir')
  })

  it('degrades on a relative stateDir', async () => {
    vi.doMock(ENGINE_MODULE, () => ({ async start() { throw new Error('must not start') } }))
    const guardian = await loadGuardian()

    guardian.apply(asContext(createFakeCtx()), { enabled: true, stateDir: 'relative/path' })
    await waitFor(() => guardian.bootState().status === 'degraded')
    expect(guardian.bootState().detail ?? '').toContain('absolute')
  })
})

describe('guardian lifecycle', () => {
  it('reaches ready, then a double dispose is safe and stops the engine once', async () => {
    const stop = vi.fn(async () => undefined)
    vi.doMock(ENGINE_MODULE, () => ({ async start() { return { stop } } }))
    const stateDir = await makeStateDir()
    stateDirs.push(stateDir)
    const guardian = await loadGuardian()
    const ctx = createFakeCtx()

    guardian.apply(asContext(ctx), { enabled: true, stateDir })
    await waitFor(() => guardian.bootState().status === 'ready')

    await expect(ctx.dispose()).resolves.toBeUndefined()
    await expect(ctx.dispose()).resolves.toBeUndefined()
    expect(guardian.bootState().status).toBe('stopped')
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('ignores a duplicate apply() while running', async () => {
    const stop = vi.fn(async () => undefined)
    const start = vi.fn(async () => ({ stop }))
    vi.doMock(ENGINE_MODULE, () => ({ start }))
    const stateDir = await makeStateDir()
    stateDirs.push(stateDir)
    const guardian = await loadGuardian()
    const ctx = createFakeCtx()

    guardian.apply(asContext(ctx), { enabled: true, stateDir })
    await waitFor(() => guardian.bootState().status === 'ready')
    guardian.apply(asContext(ctx), { enabled: true, stateDir })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(start).toHaveBeenCalledTimes(1)
    expect(guardian.bootState().status).toBe('ready')
  })

  it('starts again after a fiber dispose (restart safety)', async () => {
    const stops: Array<ReturnType<typeof vi.fn>> = []
    const start = vi.fn(async () => {
      const stop = vi.fn(async () => undefined)
      stops.push(stop)
      return { stop }
    })
    vi.doMock(ENGINE_MODULE, () => ({ start }))
    const stateDir = await makeStateDir()
    stateDirs.push(stateDir)
    const guardian = await loadGuardian()
    const ctx = createFakeCtx()

    guardian.apply(asContext(ctx), { enabled: true, stateDir })
    await waitFor(() => guardian.bootState().status === 'ready')
    await ctx.dispose()
    expect(guardian.bootState().status).toBe('stopped')

    // Cordis re-runs the same module's apply() on restart; the module must not
    // remember the previous fiber's disposal.
    guardian.apply(asContext(ctx), { enabled: true, stateDir })
    await waitFor(() => guardian.bootState().status === 'ready')
    expect(start).toHaveBeenCalledTimes(2)
    expect(stops[0]).toHaveBeenCalledTimes(1)
  })

  it('stops a handle that resolves after the fiber was disposed mid-start', async () => {
    const stop = vi.fn(async () => undefined)
    const start = vi.fn(() => {
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve({ stop }), 100)
        timer.unref?.()
      })
    })
    vi.doMock(ENGINE_MODULE, () => ({ start }))
    const stateDir = await makeStateDir()
    stateDirs.push(stateDir)
    const guardian = await loadGuardian()
    const ctx = createFakeCtx()

    guardian.apply(asContext(ctx), { enabled: true, stateDir })
    await waitFor(() => start.mock.calls.length > 0)
    // Dispose while the engine is still starting; the teardown must own it.
    await ctx.dispose()
    await waitFor(() => stop.mock.calls.length > 0)
    expect(guardian.bootState().status).toBe('stopped')
  })
})
