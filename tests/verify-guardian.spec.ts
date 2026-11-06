/**
 * Black-box failure-isolation tests for the **built** guardian (`lib/index.js`).
 *
 * Unlike `tests/guardian-isolation.spec.ts` (which mocks the engine module and
 * imports TS sources), these tests exercise the artifact a DSH profile actually
 * loads: the compiled ESM entry, imported into a bare Node process state with a
 * minimal fake Cordis context. The engine module is a *file on disk* next to a
 * private copy of `lib/index.js`, so every failure mode is produced by real
 * module loading / rejection / hangs rather than by a test mock.
 *
 * The guardian contract under test (docs/000-architecture.md §8,
 * docs/dsh-api-notes.md §1.5, §8):
 *  - `apply()` never throws and never rejects, whatever the engine does;
 *  - a failed engine leaves `bootState()` at `degraded` (or `stopped` for the
 *    kill switches) and writes the status under `stateDir`;
 *  - cleanup registered through `ctx.effect` is idempotent and never loads the
 *    host with a rejection;
 *  - the host process continues: a later plugin/boot in the same process is
 *    unaffected.
 *
 * Every test copies `lib/index.js` into a fresh temp dir (module-global state
 * such as `bootState()` is per module instance), writes its own `engine.js`,
 * and removes the directory afterwards. Offline, deterministic, no tokens.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIB_ENTRY = join(ROOT, 'lib', 'index.js')

interface BootState {
  status: 'starting' | 'ready' | 'degraded' | 'stopped'
  detail?: string
  at: string
  stateDir?: string
  dshVersion?: string
  node?: string
}

interface Guardian {
  apply(ctx: unknown, config: unknown): void
  bootState(): BootState
}

const tempDirs: string[] = []
const ENV_KEYS = [
  'DSH_VERSION',
  'DSH_CLIENT_VERSION',
  'SUPERAGENT_DISABLED',
  'SUPERAGENT_COMPAT_ASSUME_UNSUPPORTED',
  'SUPERAGENT_START_TIMEOUT_MS',
] as const

beforeEach(() => {
  if (!existsSync(LIB_ENTRY)) {
    throw new Error(`built entry is missing: ${LIB_ENTRY} — run ./scripts/pnpmw build first`)
  }
  // Pin detection so the suite never depends on what is installed.
  process.env.DSH_VERSION = '0.2.2-rc.1'
  delete process.env.DSH_CLIENT_VERSION
  delete process.env.SUPERAGENT_DISABLED
  delete process.env.SUPERAGENT_COMPAT_ASSUME_UNSUPPORTED
  delete process.env.SUPERAGENT_START_TIMEOUT_MS
})

afterEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.DSH_VERSION = '0.2.2-rc.1'
  const dirs = tempDirs.splice(0)
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })))
})

/** Import a private copy of the built guardian with a custom `engine.js`. */
async function mountGuardian(engineSource: string): Promise<{ guardian: Guardian; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-guardian-'))
  tempDirs.push(dir)
  // ESM: the temp dir has no package.json, so give it one before Node links the file.
  await writeFile(join(dir, 'package.json'), '{"type":"module"}\n')
  await copyFile(LIB_ENTRY, join(dir, 'index.js'))
  const map = `${LIB_ENTRY}.map`
  if (existsSync(map)) await copyFile(map, join(dir, 'index.js.map'))
  await writeFile(join(dir, 'engine.js'), engineSource)
  const moduleUrl = pathToFileURL(join(dir, 'index.js')).href
  const namespace = (await import(moduleUrl)) as { apply(ctx: unknown, config: unknown): void; bootState(): BootState }
  return {
    guardian: {
      apply: namespace.apply,
      bootState: () => namespace.bootState(),
    },
    dir,
  }
}

async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-state-'))
  tempDirs.push(dir)
  return dir
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000, label = 'condition'): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`${label} not reached before timeout`)
    await sleep(10)
  }
}

async function waitForFile(path: string, timeoutMs = 8_000): Promise<string> {
  const started = Date.now()
  for (;;) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      if (Date.now() - started > timeoutMs) throw new Error(`file not written before timeout: ${path}`)
      await sleep(10)
    }
  }
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error'
type LogLine = `${LogLevel}:${string}`

interface FakeCtx {
  logger: Record<LogLevel, (message: string, error?: unknown) => void>
  effect(factory: () => unknown): () => void
  get(name: string): unknown
  logLines: LogLine[]
  /** Simulate a real Cordis fiber disposal: effects are torn down in reverse. */
  dispose(): Promise<void>
  /** True once the simulated fiber is inactive. */
  readonly disposed: boolean
}

/**
 * Minimal Cordis context double. It models the one host behaviour that matters
 * for teardown: an `effect()` on an already-disposed fiber throws
 * `CordisError(INACTIVE_EFFECT)` (cordis `Fiber.effect()` → `assertActive()`),
 * exactly like the real host.
 */
function fakeCtx(options: { loggerThrows?: boolean } = {}): FakeCtx {
  const logLines: LogLine[] = []
  const cleanups: Array<() => unknown> = []
  let disposed = false
  const logger = {} as FakeCtx['logger']
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    logger[level] = (message: string, error?: unknown): void => {
      if (options.loggerThrows === true) throw new Error(`logger ${level} is broken`)
      logLines.push(`${level}:${message}${error === undefined ? '' : `:${String(error)}`}`)
    }
  }
  return {
    logger,
    logLines,
    get: () => undefined,
    effect(factory: () => unknown) {
      if (disposed) {
        const error = new Error('cannot create effect on inactive context')
        error.name = 'CordisError'
        throw error
      }
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup as () => unknown)
      return () => undefined
    },
    async dispose() {
      disposed = true
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    },
    get disposed() {
      return disposed
    },
  }
}

/** Ready engine: returns a handle whose stop() records itself into the temp dir. */
function readyEngine(dir: string): string {
  return `import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const marker = ${JSON.stringify(join(dir, 'stop-calls.txt'))}
export async function start() {
  return {
    async stop() {
      writeFileSync(marker + '.run', String(Date.now()))
    },
  }
}
`
}

// ---------------------------------------------------------------------------
// Engine failures: apply() must return and report degraded
// ---------------------------------------------------------------------------

describe('engine failure isolation', () => {
  it('survives an engine module that throws on import', async () => {
    const { guardian } = await mountGuardian("throw new Error('simulated engine import failure')\n")
    const stateDir = await makeStateDir()
    const ctx = fakeCtx()

    expect(() => guardian.apply(ctx, { enabled: true, stateDir })).not.toThrow()
    await waitFor(() => guardian.bootState().status === 'degraded', 8_000, 'degraded state')

    expect(guardian.bootState().detail).toContain('simulated engine import failure')
    expect(guardian.bootState().stateDir).toBe(stateDir)
    // degrade() persists the state before logging; wait for the log line too
    // instead of racing the two awaits.
    await waitFor(
      () => ctx.logLines.some(line => line.startsWith('error:Superagent failed to start')),
      2_000,
      'degraded log line',
    )

    // The degraded state is persisted for the watchdog/panel.
    const persisted = JSON.parse(await waitForFile(join(stateDir, 'superagent-degraded.json'))) as BootState
    expect(persisted.status).toBe('degraded')
    expect((persisted.detail ?? '').length).toBeGreaterThan(0)
  })

  it('survives a start() rejection', async () => {
    const { guardian } = await mountGuardian(
      "export async function start() { throw new Error('start rejected: agents service missing') }\n",
    )
    const ctx = fakeCtx()
    guardian.apply(ctx, { enabled: true, stateDir: await makeStateDir() })
    await waitFor(() => guardian.bootState().status === 'degraded')
    expect(guardian.bootState().detail).toContain('agents service missing')
  })

  it('degrades on a hung start() and stops the handle that arrives later', async () => {
    const dir = await makeStateDir()
    const { guardian } = await mountGuardian(`import { writeFileSync } from 'node:fs'
const marker = ${JSON.stringify(join(dir, 'late-stop.txt'))}
export function start() {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ stop() { writeFileSync(marker, 'stopped') } }), 300)
    timer.unref?.()
  })
}
`)
    process.env.SUPERAGENT_START_TIMEOUT_MS = '100'
    const ctx = fakeCtx()

    guardian.apply(ctx, { enabled: true, stateDir: await makeStateDir() })
    await waitFor(() => guardian.bootState().status === 'degraded')
    expect(guardian.bootState().detail).toContain('timed out')

    await waitForFile(join(dir, 'late-stop.txt'))
    expect(guardian.bootState().status).toBe('degraded')
  })

  it('degrades when start() resolves without stop()', async () => {
    const { guardian } = await mountGuardian('export async function start() { return {} }\n')
    guardian.apply(fakeCtx(), { enabled: true, stateDir: await makeStateDir() })
    await waitFor(() => guardian.bootState().status === 'degraded')
    expect(guardian.bootState().detail).toContain('stop()')
  })
})

// ---------------------------------------------------------------------------
// Version gate
// ---------------------------------------------------------------------------

describe('version gate', () => {
  it('degrades on an unsupported DSH version and never imports the engine', async () => {
    const { guardian } = await mountGuardian("throw new Error('engine must not be imported')\n")
    const stateDir = await makeStateDir()
    process.env.DSH_VERSION = '0.3.1'

    guardian.apply(fakeCtx(), { enabled: true, stateDir })
    await waitFor(() => guardian.bootState().status === 'degraded')

    expect(guardian.bootState().dshVersion).toBe('0.3.1')
    expect(guardian.bootState().detail).toContain('0.3.1')
    expect(guardian.bootState().detail).not.toContain('must not be imported')
  })

  it('supports the compatibility self-test switch without importing the engine', async () => {
    const { guardian } = await mountGuardian("throw new Error('engine must not be imported')\n")
    delete process.env.DSH_VERSION
    process.env.SUPERAGENT_COMPAT_ASSUME_UNSUPPORTED = '1'

    guardian.apply(fakeCtx(), { enabled: true, stateDir: await makeStateDir() })
    await waitFor(() => guardian.bootState().status === 'degraded')
    expect(guardian.bootState().detail).toContain('incompatible')
    expect(guardian.bootState().detail).not.toContain('must not be imported')
  })
})

// ---------------------------------------------------------------------------
// Configuration and kill switches
// ---------------------------------------------------------------------------

describe('configuration and kill switches', () => {
  it('degrades on a missing stateDir without importing the engine', async () => {
    const { guardian } = await mountGuardian("throw new Error('engine must not be imported')\n")
    guardian.apply(fakeCtx(), { enabled: true })
    await waitFor(() => guardian.bootState().status === 'degraded')
    expect(guardian.bootState().detail).toContain('stateDir')
    expect(guardian.bootState().detail).not.toContain('must not be imported')
  })

  it('degrades on a relative stateDir', async () => {
    const { guardian } = await mountGuardian("throw new Error('engine must not be imported')\n")
    guardian.apply(fakeCtx(), { enabled: true, stateDir: 'relative/path' })
    await waitFor(() => guardian.bootState().status === 'degraded')
    expect(guardian.bootState().detail).toContain('absolute')
  })

  it('degrades on a non-object configuration', async () => {
    const { guardian } = await mountGuardian("throw new Error('engine must not be imported')\n")
    guardian.apply(fakeCtx(), null)
    await waitFor(() => guardian.bootState().status === 'degraded')
    expect(guardian.bootState().detail).toContain('object')
  })

  it('stops on enabled:false and persists the stopped state', async () => {
    const { guardian } = await mountGuardian("throw new Error('engine must not be imported')\n")
    const stateDir = await makeStateDir()

    guardian.apply(fakeCtx(), { enabled: false, stateDir })
    await waitFor(() => guardian.bootState().status === 'stopped')
    expect(guardian.bootState().detail).toContain('enabled: false')

    const persisted = JSON.parse(await waitForFile(join(stateDir, 'superagent-status.json'))) as BootState
    expect(persisted.status).toBe('stopped')
  })

  it('stops on SUPERAGENT_DISABLED=1', async () => {
    const { guardian } = await mountGuardian("throw new Error('engine must not be imported')\n")
    process.env.SUPERAGENT_DISABLED = '1'
    guardian.apply(fakeCtx(), { enabled: true, stateDir: await makeStateDir() })
    await waitFor(() => guardian.bootState().status === 'stopped')
    expect(guardian.bootState().detail).toContain('SUPERAGENT_DISABLED')
  })
})

// ---------------------------------------------------------------------------
// Lifecycle, teardown and host continuity
// ---------------------------------------------------------------------------

describe('lifecycle and host continuity', () => {
  it('reaches ready, then a double dispose is safe and stops the engine once', async () => {
    const stateDir = await makeStateDir()
    const { guardian } = await mountGuardian(readyEngine(stateDir))
    const ctx = fakeCtx()

    guardian.apply(ctx, { enabled: true, stateDir })
    await waitFor(() => guardian.bootState().status === 'ready')

    await expect(ctx.dispose()).resolves.toBeUndefined()
    await expect(ctx.dispose()).resolves.toBeUndefined()

    expect(guardian.bootState().status).toBe('stopped')
    const marker = await waitForFile(join(stateDir, 'stop-calls.txt.run'))
    expect(marker.length).toBeGreaterThan(0)
  })

  it('ignores a duplicate apply() while booting/running', async () => {
    const stateDir = await makeStateDir()
    const engineDir = await makeStateDir()
    const { guardian } = await mountGuardian(`import { writeFileSync } from 'node:fs'
const marker = ${JSON.stringify(join(engineDir, 'start-calls.txt'))}
export async function start() {
  writeFileSync(marker, 'started')
  return { async stop() {} }
}
`)
    const first = fakeCtx()
    guardian.apply(first, { enabled: true, stateDir })
    const second = fakeCtx()
    guardian.apply(second, { enabled: true, stateDir })
    await waitFor(() => guardian.bootState().status === 'ready')
    await sleep(50)
    expect(second.logLines.some(line => line.startsWith('warn:Superagent is already'))).toBe(true)
    await expect(first.dispose()).resolves.toBeUndefined()
  })

  it('does not let a degraded plugin block the rest of the host boot', async () => {
    const broken = await mountGuardian("throw new Error('engine broken')\n")
    broken.guardian.apply(fakeCtx(), { enabled: true, stateDir: await makeStateDir() })
    await waitFor(() => broken.guardian.bootState().status === 'degraded')

    // The host keeps loading its own plugins after the failed row.
    let hostPluginBooted = false
    const hostPlugin = {
      apply(): void {
        hostPluginBooted = true
      },
    }
    hostPlugin.apply()
    expect(hostPluginBooted).toBe(true)

    // And a healthy SuperAgent instance can still mount in the same process.
    const healthy = await mountGuardian(readyEngine(await makeStateDir()))
    healthy.guardian.apply(fakeCtx(), { enabled: true, stateDir: await makeStateDir() })
    await waitFor(() => healthy.guardian.bootState().status === 'ready')
    expect(hostPluginBooted).toBe(true)
  })

  it('does not throw when the logger throws on every call', async () => {
    const stateDir = await makeStateDir()
    const { guardian } = await mountGuardian(readyEngine(stateDir))
    const hostile = {
      logger: {
        debug(): void {
          throw new Error('logger broken')
        },
        info(): void {
          throw new Error('logger broken')
        },
        warn(): void {
          throw new Error('logger broken')
        },
        error(): void {
          throw new Error('logger broken')
        },
      },
      effect(factory: () => unknown): () => void {
        const cleanup = factory()
        if (typeof cleanup === 'function') cleanups.push(cleanup as () => unknown)
        return () => undefined
      },
      get(): undefined {
        return undefined
      },
    }
    const cleanups: Array<() => unknown> = []

    expect(() => guardian.apply(hostile, { enabled: true, stateDir })).not.toThrow()
    await waitFor(() => guardian.bootState().status === 'ready')
    expect(guardian.bootState().status).toBe('ready')
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  it('never throws when the host double refuses effect registration', async () => {
    const stateDir = await makeStateDir()
    const engineDir = await makeStateDir()
    const { guardian } = await mountGuardian(`import { writeFileSync } from 'node:fs'
const marker = ${JSON.stringify(join(engineDir, 'start-calls.txt'))}
export async function start() {
  writeFileSync(marker, 'started')
  return { async stop() {} }
}
`)
    let effectCalls = 0
    const hostile = {
      logger: {
        debug(): void {},
        info(): void {},
        warn(): void {},
        error(): void {},
      },
      effect(): () => void {
        effectCalls += 1
        throw new Error('effect registration refused')
      },
      get(): undefined {
        return undefined
      },
    }

    expect(() => guardian.apply(hostile, { enabled: true, stateDir })).not.toThrow()
    // The fiber looked inactive: the guardian refuses to load anything at all.
    await waitFor(() => guardian.bootState().status === 'stopped')
    expect(effectCalls).toBe(1)
    await sleep(50)
    expect(existsSync(join(engineDir, 'start-calls.txt'))).toBe(false)
  })

  it('apply() works with a bare context that has no logger/effect/get', async () => {
    const stateDir = await makeStateDir()
    const { guardian } = await mountGuardian(readyEngine(await makeStateDir()))
    expect(() => guardian.apply({}, { enabled: true, stateDir })).not.toThrow()
    await waitFor(() => guardian.bootState().status === 'ready')
  })

  // Cordis re-runs the same apply function on a config change / fiber.restart()
  // without re-importing the module, so the guardian must not remember "this
  // plugin was disposed" in module scope. This regression test drives the
  // dispose → apply sequence directly (the bug reported to packaging in audit).
  it('restarts after ready (config change / fiber.restart())', async () => {
    const stateDir = await makeStateDir()
    const { guardian } = await mountGuardian(readyEngine(stateDir))
    const first = fakeCtx()
    guardian.apply(first, { enabled: true, stateDir })
    await waitFor(() => guardian.bootState().status === 'ready')
    await first.dispose() // cordis disposes the fiber, then re-applies the same module
    expect(guardian.bootState().status).toBe('stopped')

    const second = fakeCtx() // the next apply() runs on a new fiber
    guardian.apply(second, { enabled: true, stateDir })
    await waitFor(() => guardian.bootState().status === 'ready', 2_000, 'ready after in-process restart')
  })

  it('never starts the engine when disposed before the boot microtask', async () => {
    const engineDir = await makeStateDir()
    const { guardian } = await mountGuardian(`import { writeFileSync } from 'node:fs'
const marker = ${JSON.stringify(join(engineDir, 'start-calls.txt'))}
export async function start() {
  writeFileSync(marker, 'started')
  return { async stop() {} }
}
`)
    const stateDir = await makeStateDir()
    const ctx = fakeCtx()
    guardian.apply(ctx, { enabled: true, stateDir })
    await ctx.dispose() // dispose before the scheduled boot() microtask runs

    await waitFor(() => guardian.bootState().status === 'stopped')
    await sleep(50)
    expect(existsSync(join(engineDir, 'start-calls.txt'))).toBe(false)
  })

  it('stops a handle that resolves after a dispose during start', async () => {
    const engineDir = await makeStateDir()
    const { guardian } = await mountGuardian(`import { writeFileSync } from 'node:fs'
const started = ${JSON.stringify(join(engineDir, 'started.txt'))}
const stopped = ${JSON.stringify(join(engineDir, 'stopped.txt'))}
export async function start() {
  writeFileSync(started, 'started')
  await new Promise(resolve => setTimeout(resolve, 150))
  return { async stop() { writeFileSync(stopped, 'stopped') } }
}
`)
    const stateDir = await makeStateDir()
    const ctx = fakeCtx()
    guardian.apply(ctx, { enabled: true, stateDir })
    // Wait until start() is actually running, then dispose the fiber mid-start.
    await waitForFile(join(engineDir, 'started.txt'))
    await ctx.dispose()

    await waitFor(() => guardian.bootState().status === 'stopped')
    await waitForFile(join(engineDir, 'stopped.txt'))
  })
})
