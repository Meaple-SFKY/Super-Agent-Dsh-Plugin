/**
 * Main plugin entry — the failure-isolation guardian.
 *
 * This module performs no optional runtime import at load time: it imports
 * only types and Node built-ins, and every optional dependency (the engine,
 * the host's version helper) is loaded through a guarded dynamic `import()`
 * inside `apply()`. That way a broken engine build, a missing host service
 * after a DSH upgrade, or an incompatible Node/DSH version can never make the
 * DSH host fail to boot: the guardian reports a clear degraded status, writes
 * it under the state directory when it can, and stops.
 *
 * The real application lives in `engine.ts` and is loaded on demand.
 *
 * Rules this file follows (see docs/dsh-api-notes.md §8):
 *  - `apply()` never throws and never rejects.
 *  - Every floating promise has `.catch()`; the host installs `installFailLoud`
 *    and would exit on an unhandled rejection.
 *  - The engine start is bounded; a hung start degrades instead of hanging the
 *    plugin forever.
 *  - Teardown is registered synchronously, before the bounded start begins, so
 *    a fiber disposed mid-start still owns (and can stop) the engine.
 *  - Per-apply state lives in an instance object: Cordis re-runs `apply()` on
 *    config change or `fiber.restart()` without re-importing the module, so
 *    module globals must not remember "this plugin was disposed".
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

/** Plugin name; also the loader entry id used in `cordis.patch.yml`. */
export const name = 'dsh-superagent-personal'

/**
 * No static injections: the guardian must run even when the services the
 * engine needs are missing. The engine waits for its own dependencies.
 */
export const inject: string[] = []

/** Supported range, mirrored in package.json `engines.dsh`. */
export const SUPPORTED_DSH = '>=0.2.2-rc.1 <0.3.0'
/** Minimum Node version, mirrored in package.json `engines.node`. */
const MIN_NODE = [22, 19, 0] as const
/** Default bound for the engine's `start()`; overridable for tests/ops. */
const DEFAULT_START_TIMEOUT_MS = 30_000
/** Bound for engine `stop()` during teardown, so a hung engine cannot stall unload. */
const STOP_TIMEOUT_MS = 15_000
/** Status file names inside `<stateDir>`. */
const STATUS_FILE = 'superagent-status.json'
const DEGRADED_FILE = 'superagent-degraded.json'

/** Where the guardian writes its own state; readable by tests and the watchdog. */
export interface BootState {
  status: 'starting' | 'ready' | 'degraded' | 'stopped'
  detail?: string
  at: string
  /** Detected running DSH version, when detection succeeded. */
  dshVersion?: string
  /** Node version of the host process. */
  node?: string
  /** Absolute state directory from the configuration, when valid. */
  stateDir?: string
}

interface EngineHandle {
  stop(): Promise<void>
}

/**
 * One `apply()` invocation (one Cordis fiber). A restarted fiber gets a fresh
 * instance, which is what makes the plugin restart-safe.
 */
interface Instance {
  ctx: Context
  config: unknown
  state: BootState
  handle?: EngineHandle
  booting: boolean
  disposed: boolean
  /** True once `ctx.effect` accepted the teardown registration. */
  cleanupRegistered: boolean
}

/** Last state reported by any instance; `bootState()` is a diagnostic view. */
let lastState: BootState = { status: 'starting', at: new Date().toISOString() }
/** The live instance, when one exists (single-row deployments have one). */
let current: Instance | undefined

/** Read the last boot state, for diagnostics, the panel and tests. */
export function bootState(): BootState {
  return { ...lastState }
}

function setState(instance: Instance, status: BootState['status'], detail?: string, extra: Partial<BootState> = {}): void {
  const next: BootState = {
    ...extra,
    status,
    ...(detail === undefined ? {} : { detail }),
    at: new Date().toISOString(),
  }
  instance.state = next
  lastState = { ...next }
}

function serverLog(ctx: Context, level: 'info' | 'warn' | 'error', message: string, error?: unknown): void {
  const text = error === undefined ? message : `${message}: ${String(error)}`
  try {
    ctx.logger?.[level]?.(text)
  } catch {
    // Logging must never throw out of the guardian.
  }
}

/**
 * Persist the current boot state under the configured state directory, best
 * effort. The status file always reflects the latest attempt; the degraded
 * file exists only while the plugin is degraded. A write failure is silent: it
 * must never change the boot result.
 */
async function persistState(instance: Instance): Promise<void> {
  const dir = instance.state.stateDir
  if (dir === undefined || !isAbsolute(dir)) return
  const body = `${JSON.stringify({ plugin: name, ...instance.state }, null, 2)}\n`
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeAtomic(join(dir, STATUS_FILE), body)
    if (instance.state.status === 'degraded') {
      await writeAtomic(join(dir, DEGRADED_FILE), body)
    } else {
      await unlink(join(dir, DEGRADED_FILE)).catch(() => undefined)
    }
  } catch {
    // Best effort by contract.
  }
}

async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(tmp, body, { mode: 0o600 })
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

function nodeTooOld(): string | undefined {
  const raw = process.versions.node ?? '0.0.0'
  const parts = raw.split('.').map(part => Number.parseInt(part, 10))
  const [major = 0, minor = 0, patch = 0] = parts
  if (major > MIN_NODE[0]) return undefined
  if (major < MIN_NODE[0]) return `Node ${raw} is older than ${MIN_NODE.join('.')}`
  if (minor > MIN_NODE[1]) return undefined
  if (minor < MIN_NODE[1]) return `Node ${raw} is older than ${MIN_NODE.join('.')}`
  return patch >= MIN_NODE[2] ? undefined : `Node ${raw} is older than ${MIN_NODE.join('.')}`
}

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

function parseVersion(raw: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim())
  if (match === null) return undefined
  const [, major, minor, patch, prerelease] = match
  if (major === undefined || minor === undefined || patch === undefined) return undefined
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  }
}

/**
 * Whether the running DSH version is inside `SUPPORTED_DSH`. Returns
 * `undefined` for a string that is not a version at all; callers decide
 * whether an unknown version is fatal (it is not: the host's `engines.dsh`
 * gate is authoritative, this is the defensive second check).
 */
export function isSupportedDshVersion(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined
  const version = parseVersion(raw)
  if (version === undefined) return undefined
  if (version.major !== 0 || version.minor !== 2) return false
  return version.patch >= 2
}

function configEnabled(config: unknown): boolean {
  if (config === null || typeof config !== 'object') return true
  const value = (config as { enabled?: unknown }).enabled
  return value !== false
}

function configuredStateDir(config: unknown): string | undefined {
  if (config === null || typeof config !== 'object') return undefined
  const value = (config as { stateDir?: unknown }).stateDir
  return typeof value === 'string' && value.length > 0 && isAbsolute(value) ? value : undefined
}

/**
 * Validate the configuration without a schema import. A missing dependency can
 * therefore never fail the module load; invalid configuration is reported as a
 * degraded status instead.
 */
function validateConfig(config: unknown): string | undefined {
  if (config === null || typeof config !== 'object') return 'configuration must be an object'
  const stateDir = (config as { stateDir?: unknown }).stateDir
  if (typeof stateDir !== 'string' || stateDir.length === 0) return 'configuration.stateDir is required'
  if (!isAbsolute(stateDir)) return 'configuration.stateDir must be an absolute path'
  return undefined
}

function startTimeoutMs(): number {
  // Operational escape hatch; tests use a small value to exercise the timeout
  // path without waiting 30 s. Kept in the 50 ms–2 min range so a typo cannot
  // disable the bound.
  const raw = process.env.SUPERAGENT_START_TIMEOUT_MS
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed >= 50 && parsed <= 120_000) return parsed
  }
  return DEFAULT_START_TIMEOUT_MS
}

/** Read `version` from a package.json path; used only as a fallback. */
async function readPackageVersion(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') {
      const version = (parsed as { version?: unknown }).version
      if (typeof version === 'string' && version.length > 0) return version
    }
  } catch {
    // Missing or unreadable; try the next source.
  }
  return undefined
}

/**
 * Detect the running DSH version. Every source is optional and guarded; the
 * helper never throws and never imports a dependency at module load time.
 */
export async function detectDshVersion(ctx: Context): Promise<string | undefined> {
  const fromEnv = (process.env.DSH_VERSION ?? process.env.DSH_CLIENT_VERSION ?? '').trim()
  if (fromEnv.length > 0) return fromEnv

  // 1. The authoritative accessor of the host runtime.
  try {
    const boot: unknown = await import('@deepseek-ai/dsh-app-boot')
    if (boot !== null && typeof boot === 'object') {
      const getter = (boot as { getDshRuntimeVersion?: () => unknown }).getDshRuntimeVersion
      if (typeof getter === 'function') {
        const version = getter()
        if (typeof version === 'string' && version.length > 0) return version
      }
    }
  } catch {
    // Not resolvable in this deployment; fall through.
  }

  // 2. The profile context names the profile directory; the dsh package there
  //    may be the one that launched us.
  try {
    const profile = ctx.get?.('profileContext') as { dir?: unknown } | undefined
    if (profile !== undefined && typeof profile.dir === 'string' && profile.dir.length > 0) {
      const version = await readPackageVersion(join(profile.dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
      if (version !== undefined) return version
    }
  } catch {
    // Optional service; ignore.
  }

  // 3. Resolve `@deepseek-ai/dsh`'s own metadata from the host module graph.
  try {
    // A variable specifier keeps TypeScript from resolving a package that may
    // not be installed in this workspace; the import stays runtime-resolved.
    const specifier = '@deepseek-ai/dsh/package.json'
    const metadata: unknown = await import(/* @vite-ignore */ specifier, { with: { type: 'json' } })
    if (metadata !== null && typeof metadata === 'object') {
      const version = (metadata as { default?: { version?: unknown }; version?: unknown }).default?.version
      if (typeof version === 'string' && version.length > 0) return version
      const direct = (metadata as { version?: unknown }).version
      if (typeof direct === 'string' && direct.length > 0) return direct
    }
  } catch {
    // No package metadata; the version stays unknown.
  }

  return undefined
}

/** Resolve or reject with a bound; a late resolution is stopped, not leaked. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`${label} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    timer.unref?.()
    promise.then(
      value => {
        if (settled) {
          // The caller already degraded; release whatever arrived late.
          void Promise.resolve()
            .then(() => (value as unknown as EngineHandle | undefined)?.stop?.())
            .catch(() => undefined)
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

async function stopQuietly(target: EngineHandle | undefined, timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
  if (target === undefined || typeof target.stop !== 'function') return
  try {
    await withTimeout(Promise.resolve().then(() => target.stop()), timeoutMs, 'engine stop()')
  } catch {
    // Cleanup failures (including a hung stop) must not affect the host.
  }
}

async function loadEngine(ctx: Context, config: unknown): Promise<EngineHandle> {
  const runtime: unknown = await import('./engine.js')
  if (runtime === null || typeof runtime !== 'object') {
    throw new Error('engine module did not export an object')
  }
  const start = (runtime as { start?: unknown }).start
  if (typeof start !== 'function') {
    throw new Error('engine module does not export start()')
  }
  const started: unknown = await (start as (ctx: Context, config: unknown) => Promise<unknown>)(ctx, config)
  if (started === null || typeof started !== 'object' || typeof (started as EngineHandle).stop !== 'function') {
    throw new Error('engine start() returned no stop()')
  }
  return started as EngineHandle
}

/** Mark the plugin degraded, persist it and log one clear line. */
async function degrade(instance: Instance, detail: string, error?: unknown): Promise<void> {
  setState(instance, 'degraded', detail, { ...instance.state })
  await persistState(instance)
  serverLog(instance.ctx, 'error', 'Superagent failed to start and was disabled; DSH is unaffected', error)
}

function earlyExit(instance: Instance, status: 'stopped' | 'degraded', detail: string, message: string): Promise<void> {
  setState(instance, status, detail, { stateDir: configuredStateDir(instance.config) })
  return persistState(instance).then(() => {
    serverLog(instance.ctx, status === 'degraded' ? 'warn' : 'info', message)
  })
}

async function boot(instance: Instance): Promise<void> {
  const { ctx, config } = instance
  if (instance.disposed) {
    setState(instance, 'stopped', 'host disposed the plugin before it started', { stateDir: configuredStateDir(config) })
    await persistState(instance)
    return
  }

  if (!configEnabled(config)) {
    await earlyExit(instance, 'stopped', 'disabled by configuration (enabled: false)', 'Superagent is disabled by configuration; the host starts normally.')
    return
  }

  if (process.env.SUPERAGENT_DISABLED === '1') {
    await earlyExit(instance, 'stopped', 'disabled by SUPERAGENT_DISABLED=1', 'Superagent is disabled by SUPERAGENT_DISABLED=1; the host starts normally.')
    return
  }

  const nodeProblem = nodeTooOld()
  if (nodeProblem !== undefined) {
    await earlyExit(instance, 'degraded', nodeProblem, `Superagent is disabled: ${nodeProblem}. Update Node or set enabled: false.`)
    return
  }

  const configProblem = validateConfig(config)
  if (configProblem !== undefined) {
    await earlyExit(instance, 'degraded', configProblem, `Superagent is disabled: ${configProblem}. See examples/profile.cordis.patch.yml.`)
    return
  }

  const stateDir = configuredStateDir(config)
  setState(instance, 'starting', undefined, {
    ...instance.state,
    node: process.versions.node,
    ...(stateDir === undefined ? {} : { stateDir }),
  })
  await persistState(instance)

  const dshVersion = await detectDshVersion(ctx)
  if (instance.disposed) {
    setState(instance, 'stopped', 'host disposed the plugin during version detection', { stateDir })
    await persistState(instance)
    return
  }
  if (dshVersion !== undefined) {
    setState(instance, 'starting', undefined, { ...instance.state, dshVersion })
    // Self-test switch: pretend the running host is incompatible, so the
    // degraded path can be exercised without changing the installed DSH. It is
    // documented in SETUP.md and checked before any engine import.
    if (process.env.SUPERAGENT_COMPAT_ASSUME_UNSUPPORTED === '1') {
      await degrade(instance, `DSH ${SUPPORTED_DSH} required (simulated incompatible host)`)
      serverLog(ctx, 'warn', 'Superagent is disabled: the running DSH version is outside the supported range. The host starts normally.')
      return
    }
    const supported = isSupportedDshVersion(dshVersion)
    if (supported === false) {
      await degrade(instance, `running DSH ${dshVersion} is outside the supported range ${SUPPORTED_DSH}`)
      serverLog(ctx, 'warn', `Superagent is disabled: DSH ${dshVersion} is outside ${SUPPORTED_DSH}. The host starts normally.`)
      return
    }
  }

  const timeoutMs = startTimeoutMs()
  let started: EngineHandle
  try {
    started = await withTimeout(loadEngine(ctx, config), timeoutMs, 'engine start()')
  } catch (error) {
    await degrade(instance, error instanceof Error ? error.message : String(error), error)
    return
  }

  if (instance.disposed) {
    // The fiber was disposed while the engine was starting; release it and do
    // not keep a handle that nobody owns.
    await stopQuietly(started)
    setState(instance, 'stopped', 'host disposed the plugin during start', { stateDir })
    await persistState(instance)
    return
  }

  instance.handle = started
  setState(instance, 'ready', undefined, { ...instance.state, stateDir, node: process.versions.node })
  await persistState(instance)
  serverLog(ctx, 'info', `Superagent engine started (dsh ${dshVersion ?? 'unknown'}).`)
}

/** The teardown body shared by the registered effect. Safe to run twice. */
async function teardown(instance: Instance): Promise<void> {
  instance.disposed = true
  const stopped = instance.handle
  instance.handle = undefined
  if (current === instance) current = undefined
  setState(instance, 'stopped', 'host disposed the plugin', { stateDir: configuredStateDir(instance.config) })
  await persistState(instance)
  await stopQuietly(stopped)
}

/**
 * Cordis entry point. It never throws and never rejects: every failure becomes
 * a degraded state with a log line. `boot` runs in the background so that a
 * slow engine start cannot delay the host's own startup path.
 */
export function apply(ctx: Context, config: unknown): void {
  try {
    const previous = current
    if (previous !== undefined && !previous.disposed && (previous.booting || previous.handle !== undefined)) {
      serverLog(ctx, 'warn', 'Superagent is already running; ignoring a duplicate apply().')
      return
    }

    const instance: Instance = {
      ctx,
      config,
      state: { status: 'starting', at: new Date().toISOString(), stateDir: configuredStateDir(config) },
      booting: true,
      disposed: false,
      cleanupRegistered: false,
    }
    current = instance

    // Register the teardown synchronously, before the bounded start: if the
    // fiber is disposed during start(), `ctx.effect` would throw
    // INACTIVE_EFFECT afterwards and the engine would be left unowned.
    try {
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => async () => {
          await teardown(instance)
        })
        instance.cleanupRegistered = true
      }
    } catch (error) {
      // The fiber is already inactive; do not start anything.
      instance.disposed = true
      instance.booting = false
      if (current === instance) current = undefined
      setState(instance, 'stopped', 'host disposed the plugin before it started', {
        stateDir: configuredStateDir(config),
      })
      serverLog(ctx, 'warn', 'Superagent was disposed before it could start; nothing was loaded.', error)
      return
    }

    // A microtask boundary keeps a synchronous loader return non-blocking and
    // guarantees nothing thrown here can escape into the host.
    void Promise.resolve()
      .then(() => boot(instance))
      .catch((error: unknown) => {
        // degrade() is internally guarded; the extra catch keeps a future
        // change from turning this into an unhandled rejection.
        void degrade(instance, error instanceof Error ? error.message : String(error), error).catch(() => undefined)
      })
      .finally(() => {
        instance.booting = false
      })
  } catch (error) {
    // Defensive: nothing above should throw, but the host must keep running.
    lastState = {
      status: 'degraded',
      ...(error instanceof Error ? { detail: error.message } : { detail: String(error) }),
      at: new Date().toISOString(),
      stateDir: configuredStateDir(config),
    }
    try {
      ctx.logger?.error?.('Superagent guardian failed synchronously; DSH is unaffected', error)
    } catch {
      // Ignore.
    }
  }
}
