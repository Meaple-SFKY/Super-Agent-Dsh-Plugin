/**
 * Main plugin entry — the failure-isolation guardian.
 *
 * This module is deliberately dependency-free at load time: it imports only
 * types (erased at build time) and performs every runtime import through a
 * guarded dynamic import. That way a broken engine build, a missing host
 * service after a DSH upgrade, or an incompatible Node version can never make
 * the DSH host fail to boot: the guardian reports a clear degraded status and
 * stops.
 *
 * The real application lives in `engine.ts` and is loaded on demand.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Plugin name; also the loader entry id used in `cordis.patch.yml`. */
export const name = 'dsh-superagent-personal'

/**
 * No static injections: the guardian must run even when the services the
 * engine needs are missing. The engine waits for its own dependencies.
 */
export const inject: string[] = []

/** Supported ranges, mirrored in package.json `engines`. */
const SUPPORTED_DSH = '>=0.2.2-rc.1 <0.3.0'
const MIN_NODE = [22, 19, 0] as const

interface EngineHandle {
  stop(): Promise<void>
}

interface BootState {
  status: 'starting' | 'ready' | 'degraded' | 'stopped'
  detail?: string
  at: string
}

let state: BootState = { status: 'starting', at: new Date().toISOString() }
let handle: EngineHandle | undefined
let booting = false

/** Read the last boot state, for diagnostics and tests. */
export function bootState(): BootState {
  return { ...state }
}

function setState(status: BootState['status'], detail?: string): void {
  state = { status, ...(detail ? { detail } : {}), at: new Date().toISOString() }
}

function serverLog(ctx: Context, level: 'info' | 'warn' | 'error', message: string, error?: unknown): void {
  const text = error === undefined ? message : `${message}: ${String(error)}`
  try {
    ctx.logger?.[level]?.(text)
  } catch {
    // Logging must never throw out of the guardian.
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

function dshVersionAtLeast(minimum: readonly number[]): boolean | undefined {
  const raw = (process.env.DSH_VERSION ?? '').trim()
  if (!raw) return undefined
  const parts = raw.split(/[.-]/).map(part => Number.parseInt(part, 10))
  for (let index = 0; index < minimum.length; index++) {
    const have = parts[index] ?? 0
    const want = minimum[index] ?? 0
    if (have > want) return true
    if (have < want) return false
  }
  return true
}

function configEnabled(config: unknown): boolean {
  if (config === null || typeof config !== 'object') return true
  const value = (config as { enabled?: unknown }).enabled
  return value !== false
}

/**
 * Required environment: absolute stateDir, optional fields. Validation happens
 * here (not in a schema import) so a missing dependency cannot fail the load.
 */
function validateConfig(config: unknown): string | undefined {
  if (config === null || typeof config !== 'object') return 'configuration must be an object'
  const stateDir = (config as { stateDir?: unknown }).stateDir
  if (typeof stateDir !== 'string' || stateDir.length === 0) return 'configuration.stateDir is required'
  if (!stateDir.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(stateDir)) return 'configuration.stateDir must be absolute'
  return undefined
}

async function loadEngine(
  ctx: Context,
  config: unknown,
): Promise<EngineHandle> {
  const runtime = await import('./engine.js')
  if (typeof runtime.start !== 'function') {
    throw new Error('engine module does not export start()')
  }
  return runtime.start(ctx, config)
}

async function boot(ctx: Context, config: unknown): Promise<void> {
  if (!configEnabled(config)) {
    setState('stopped', 'disabled by configuration (enabled: false)')
    serverLog(ctx, 'info', 'Superagent is disabled by configuration; the host starts normally.')
    return
  }

  const nodeProblem = nodeTooOld()
  if (nodeProblem) {
    setState('degraded', nodeProblem)
    serverLog(ctx, 'warn', `Superagent is disabled: ${nodeProblem}. Update the host or set enabled: false.`)
    return
  }

  const configProblem = validateConfig(config)
  if (configProblem) {
    setState('degraded', configProblem)
    serverLog(ctx, 'warn', `Superagent is disabled: ${configProblem}.`)
    return
  }

  if (process.env.SUPERAGENT_DISABLED === '1') {
    setState('stopped', 'disabled by SUPERAGENT_DISABLED=1')
    serverLog(ctx, 'info', 'Superagent is disabled by SUPERAGENT_DISABLED=1; the host starts normally.')
    return
  }

  if (process.env.SUPERAGENT_COMPAT_ASSUME_UNSUPPORTED === '1') {
    setState('degraded', `DSH ${SUPPORTED_DSH} required (simulated incompatible host)`)
    serverLog(ctx, 'warn', 'Superagent is disabled: the running DSH version is outside the supported range. The host starts normally.')
    return
  }

  const dshParts = process.env.DSH_VERSION?.trim()
  if (dshParts) {
    const ok = dshVersionAtLeast([0, 2, 2])
    if (ok === false) {
      setState('degraded', `DSH ${dshParts} is outside the supported range ${SUPPORTED_DSH}`)
      serverLog(ctx, 'warn', `Superagent is disabled: DSH ${dshParts} is outside ${SUPPORTED_DSH}. The host starts normally.`)
      return
    }
  }

  try {
    handle = await loadEngine(ctx, config)
    if (typeof handle.stop !== 'function') {
      throw new Error('engine start() returned no stop()')
    }
    setState('ready')
    serverLog(ctx, 'info', 'Superagent engine started.')
    ctx.effect(() => async () => {
      const current = handle
      handle = undefined
      setState('stopped', 'host disposed the plugin')
      await current?.stop()
    })
  } catch (error) {
    setState('degraded', error instanceof Error ? error.message : String(error))
    serverLog(ctx, 'error', 'Superagent failed to start and was disabled; DSH is unaffected', error)
    try {
      await handle?.stop()
    } catch {
      // Ignore cleanup failures: the host must keep running.
    }
    handle = undefined
  }
}

/**
 * Cordis entry point. It never throws and never rejects: every failure becomes
 * a degraded state with a log line.
 */
export function apply(ctx: Context, config: unknown): void {
  if (booting) {
    serverLog(ctx, 'warn', 'Superagent is already booting; ignoring a duplicate apply().')
    return
  }
  booting = true
  // Defer one microtask so a synchronous loader return is never blocked.
  void Promise.resolve()
    .then(() => boot(ctx, config))
    .catch((error: unknown) => {
      setState('degraded', error instanceof Error ? error.message : String(error))
      serverLog(ctx, 'error', 'Superagent guardian failed; DSH is unaffected', error)
    })
    .finally(() => {
      booting = false
    })
}
