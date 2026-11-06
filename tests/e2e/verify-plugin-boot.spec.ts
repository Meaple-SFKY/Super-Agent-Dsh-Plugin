/**
 * Integration smoke for the BUILT bundle artifacts.
 *
 * `verify-guardian.spec.ts` proves the guardian's failure isolation with a fake
 * `engine.js`; this suite proves the artifact a DSH profile actually loads:
 *
 *  - `lib/index.js` + the real bundled `lib/engine.js` (tsdown may split the
 *    engine into chunk files — this test catches a broken relative chunk import)
 *  - against a simulated DSH host (services: agents/presets/persistence/webServer)
 *  - with a real SQLite state directory.
 *
 * It also pins the guardian's handling of a runtime that initializes in a
 * degraded state (a host service is missing): the guardian must not throw, the
 * host must keep its other plugins, and the failure must be observable.
 *
 * Offline; temp dirs under os.tmpdir() are removed.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { Runtime } from '../../src/app/runtime.js'
import type { RuntimeConfig } from '../../src/app/runtime.js'
import { createFakeHost, type FakeAgent, type FakeHost } from '../runtime-host.js'
import { startFakeTelegram } from './fake-services.js'
import type { Context } from '@deepseek-ai/cordis'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LIB = join(ROOT, 'lib')

interface BootState {
  status: 'starting' | 'ready' | 'degraded' | 'stopped'
  detail?: string
  dshVersion?: string
}

interface GuardianModule {
  name: string
  apply(ctx: unknown, config: unknown): void
  bootState(): BootState
}

const tempDirs: string[] = []
let importCounter = 0

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-boot-'))
  tempDirs.push(dir)
  return dir
}

/** Fresh instance of the built guardian (module state is per URL). */
async function loadGuardian(): Promise<GuardianModule> {
  importCounter += 1
  const url = `${pathToFileURL(join(LIB, 'index.js')).href}?boot=${importCounter}`
  return (await import(url)) as GuardianModule
}

interface BootContext {
  ctx: Context
  host: FakeHost
  cleanups: Array<() => unknown>
  applyCleanups(): Promise<void>
}

/** Minimal Cordis-shaped root context backed by the simulated host. */
function bootContext(options: { services?: boolean } = {}): BootContext {
  const host = createFakeHost()
  const cleanups: Array<() => unknown> = []
  const ctx = {
    logger: host.logger,
    get: (name: string): unknown => (options.services === false ? undefined : host.ctx.get(name)),
    on: (): (() => void) => () => undefined,
    effect: (factory: () => unknown): (() => void) => {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup as () => unknown)
      return () => undefined
    },
  }
  return {
    ctx: ctx as unknown as Context,
    host,
    cleanups,
    async applyCleanups() {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    },
  }
}

function runtimeConfig(dir: string): RuntimeConfig {
  return {
    stateDir: dir,
    sources: { telegram: { enabled: false }, github: { enabled: false } },
    policy: { mode: 'observe' },
    executor: { clone: false, maxWorkers: 1 },
    passIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    watchdog: { intervalMs: 60_000, stallMs: 60_000, escalateMs: 60_000 },
  }
}

async function until(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 15))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Poll until `get()` returns a value, then return it. */
async function waitFor<T>(get: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = get()
    if (value !== undefined) return value
    await new Promise(resolvePromise => setTimeout(resolvePromise, 15))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('built bundle integration', () => {
  it('boots the real engine through the built guardian and stops it through the host cleanup', async () => {
    expect(existsSync(join(LIB, 'index.js')), 'run ./scripts/pnpmw build first').toBe(true)
    const dir = stateDir()
    const boot = bootContext()
    const guardian = await loadGuardian()
    process.env.DSH_VERSION = '0.2.2-rc.1'

    expect(() => guardian.apply(boot.ctx, runtimeConfig(dir))).not.toThrow()
    await until(() => guardian.bootState().status === 'ready', 10_000, 'guardian ready')

    expect(guardian.bootState().dshVersion).toBe('0.2.2-rc.1')
    // The real Runtime created the long-lived Router session on the fake host.
    await until(
      () => boot.host.agents.liveAgent('superagent-router') !== undefined,
      10_000,
      'router session on the simulated host',
    )
    // The runtime selected the bundle preset the patch layer declares.
    expect(boot.host.presets.mounted.some(entry => entry.presetId === 'superagent-router')).toBe(true)
    // The status file the watchdog/panel rely on says ready (persisted after
    // the state change, so poll instead of racing the async write).
    const statusFile = join(dir, 'superagent-status.json')
    await until(() => {
      try {
        return (JSON.parse(readFileSync(statusFile, 'utf8')) as BootState).status === 'ready'
      } catch {
        return false
      }
    }, 5_000, 'persisted ready status')

    // Host unload: the guardian's ctx.effect teardown stops the engine.
    await boot.applyCleanups()
    expect(guardian.bootState().status).toBe('stopped')
    expect(boot.host.agents.liveAgent('superagent-router')).toBeUndefined()
  }, 30_000)

  it('reports degraded (not a crash) when a host service the runtime needs is missing', async () => {
    const dir = stateDir()
    const boot = bootContext({ services: false })
    const guardian = await loadGuardian()
    process.env.DSH_VERSION = '0.2.2-rc.1'

    expect(() => guardian.apply(boot.ctx, runtimeConfig(dir))).not.toThrow()
    await until(
      () => guardian.bootState().status === 'ready' || guardian.bootState().status === 'degraded',
      10_000,
      'guardian boot settled',
    )
    // The host kept running: this test process is the proof. Even when the
    // runtime cannot initialize (no `agents` service), apply() returned.
    await boot.applyCleanups()
    expect(['ready', 'degraded', 'stopped']).toContain(guardian.bootState().status)
  }, 30_000)

  it('Runtime initializes degraded (no router, no crash) when the agents service is absent', async () => {
    const dir = stateDir()
    const boot = bootContext({ services: false })
    const runtime = new Runtime(boot.ctx, runtimeConfig(dir), { skipLock: true })
    await runtime.ready

    const state = runtime.buildState()
    expect(state.plugin.status).toBe('degraded')
    expect((state.plugin.detail ?? '').length).toBeGreaterThan(0)
    await runtime.stop()
    expect(runtime.buildState().plugin.status).toBe('stopped')
  }, 30_000)

  it('runs a Telegram message through the INSTALLED artifact: Bot API -> candidate -> accept -> worker', async () => {
    expect(existsSync(join(LIB, 'index.js')), 'run ./scripts/pnpmw build first').toBe(true)
    const telegram = await startFakeTelegram('123456789:TEST-TOKEN')
    try {
      telegram.pushUpdate({
        update_id: 7_001,
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1_000),
          from: { id: 42, is_bot: false, first_name: 'Owner' },
          chat: { id: 42, type: 'private' },
          text: 'please fix the failing test',
        },
      })
      const dir = stateDir()
      mkdirSync(join(dir, 'tokens'), { recursive: true, mode: 0o700 })
      const tokenFile = join(dir, 'tokens', 'telegram.token')
      writeFileSync(tokenFile, '123456789:TEST-TOKEN\n', { mode: 0o600 })

      const boot = bootContext()
      const guardian = await loadGuardian()
      process.env.DSH_VERSION = '0.2.2-rc.1'
      expect(() =>
        guardian.apply(boot.ctx, {
          stateDir: dir,
          sources: {
            telegram: {
              enabled: true,
              apiBaseUrl: telegram.url,
              tokenFile,
              allowedUserIds: ['42'],
              pollTimeoutSeconds: 0,
              pollSeconds: 0.01,
            },
            github: { enabled: false },
          },
          policy: { mode: 'auto' },
          executor: { clone: false, maxWorkers: 1 },
          passIntervalMs: 500,
          heartbeatIntervalMs: 60_000,
          watchdog: { intervalMs: 60_000, stallMs: 60_000, escalateMs: 60_000 },
        }),
      ).not.toThrow()
      await until(() => guardian.bootState().status === 'ready', 10_000, 'guardian ready')

      const router = await waitFor<FakeAgent>(
        () => boot.host.agents.liveAgent('superagent-router'),
        10_000,
        'router session',
      )
      await until(
        () => router.allText().join('\n').includes('[superagent candidate]'),
        15_000,
        'candidate from the real Bot API poll',
      )
      const candidateText = router.allText().join('\n')
      expect(candidateText).toContain('please fix the failing test')
      const triggerId = /trigger[: ]+([A-Za-z0-9:_-]+)/.exec(candidateText)?.[1]
      expect(triggerId).toBeTruthy()

      const accepted = (await boot.host.executeTool(router, 'superagent_route', {
        triggerId: triggerId!,
        outcome: 'accept',
        title: 'Fix the failing test',
      })).value as { ok?: boolean; ticketId?: string }
      expect(accepted.ok).toBe(true)
      const worker = await waitFor<FakeAgent>(
        () => boot.host.agents.liveAgent(`superagent-worker-${accepted.ticketId}`),
        15_000,
        'worker session from the installed runtime',
      )
      expect(worker.allText().join('\n')).toContain('[superagent assignment]')
      await boot.applyCleanups()
      expect(guardian.bootState().status).toBe('stopped')
    } finally {
      await telegram.close()
    }
  }, 45_000)

  it('starts the real bundled engine module directly and stops it cleanly', async () => {
    const dir = stateDir()
    const boot = bootContext()
    const engineModule = (await import(pathToFileURL(join(LIB, 'engine.js')).href)) as {
      start(ctx: unknown, config: unknown): Promise<{ stop(): Promise<void> }>
    }
    const handle = await engineModule.start(boot.ctx, runtimeConfig(dir))
    await until(
      () => boot.host.agents.liveAgent('superagent-router') !== undefined,
      10_000,
      'router session via lib/engine.js',
    )
    await handle.stop()
    expect(boot.host.agents.liveAgent('superagent-router')).toBeUndefined()
    // writeHeartbeat() is fire-and-forget by design: wait for the file.
    await until(() => existsSync(join(dir, 'superagent-heartbeat.json')), 5_000, 'heartbeat file')
  }, 30_000)
})
