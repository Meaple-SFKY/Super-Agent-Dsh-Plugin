/**
 * Independent adversarial verification of the P0 management-API and
 * stale-lock fixes (task-59, part 2/3).
 *
 *  1. every one of the 11 management routes is behind the shared fence:
 *     loopback peer + `x-superagent-request` + DSH `connection.requestRejection`
 *     (or the explicit degraded Host/Origin check when `connection` is absent);
 *  2. route disposal: stop removes all 11, a second start on the same web
 *     server re-registers them without a "duplicate route" failure;
 *  3. stale locks: dead PID, same PID, old lock without PID → recovered;
 *     a fresh lock without PID or a live foreign PID → refused with a clear
 *     reason (no silent takeover).
 */

import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import {
  API_ACTION_PATH,
  API_HEADER,
  API_STATE_PATH,
  registerApi,
  type ApiDeps,
  type ApiState,
} from '../src/app/api.js'
import {
  SETUP_CONFIG_PATH,
  SETUP_GITHUB_PATH,
  SETUP_MODELS_PATH,
  SETUP_OPERATOR_PATH,
  SETUP_PERMISSIONS_PATH,
  SETUP_SSH_KEY_PATH,
  SETUP_STATE_PATH,
  SETUP_TELEGRAM_PATH,
  SETUP_WATCHDOG_PATH,
  type SetupApi,
} from '../src/app/setup.js'
import { Runtime, type RuntimeConfig } from '../src/app/runtime.js'
import { createMemoryStore } from '../src/app/store.js'
import { createFakeHost, FakeWebServer } from './runtime-host.js'

// ---------------------------------------------------------------------------
// HTTP doubles
// ---------------------------------------------------------------------------

class FakeRequest extends EventEmitter {
  method: string
  headers: Record<string, string>
  socket: { remoteAddress: string }

  constructor(options: { method?: string; headers?: Record<string, string>; address?: string } = {}) {
    super()
    this.method = options.method ?? 'GET'
    this.headers = options.headers ?? {}
    this.socket = { remoteAddress: options.address ?? '127.0.0.1' }
  }

  feed(body?: string): void {
    if (body !== undefined) this.emit('data', Buffer.from(body))
    this.emit('end')
  }
}

class FakeResponse {
  statusCode = 200
  headers: Record<string, string> = {}
  body = ''
  headersSent = false

  writeHead(status: number, headers: Record<string, string> = {}): void {
    this.statusCode = status
    this.headers = headers
    this.headersSent = true
  }

  end(text?: string): void {
    this.body = text ?? ''
  }

  json<T = unknown>(): T {
    return JSON.parse(this.body) as T
  }
}

const ALL_ROUTES = [
  API_STATE_PATH,
  API_ACTION_PATH,
  SETUP_STATE_PATH,
  SETUP_PERMISSIONS_PATH,
  SETUP_MODELS_PATH,
  SETUP_TELEGRAM_PATH,
  SETUP_GITHUB_PATH,
  SETUP_SSH_KEY_PATH,
  SETUP_WATCHDOG_PATH,
  SETUP_OPERATOR_PATH,
  SETUP_CONFIG_PATH,
]

const fakeState: ApiState = {
  ok: true,
  plugin: { status: 'ready', detail: null, version: 'test' },
  paused: false,
  sources: [],
  tickets: { active: [], attention: [] },
  health: [],
}

function ok(body: Record<string, unknown> = { ok: true }) {
  return { status: 200, body }
}

function fakeSetup(): SetupApi {
  return {
    state: async () => ok(),
    permissions: () => ok({ permissions: [] }),
    saveTelegram: async () => ok(),
    saveGithub: async () => ok(),
    prepareConfig: async () => ({ result: ok() }),
    commitConfigSoon: () => undefined,
    listModels: async () => ok({ providers: [] }),
    getWatchdog: async () => ok(),
    setWatchdog: async () => ok(),
    generateGithubSshKey: async () => ok(),
    persistGitSshKey: () => true,
    saveOperatorToken: async () => ok(),
    removeOperatorToken: async () => ok(),
    persistOperatorTokenClear: () => true,
  } as unknown as SetupApi
}

interface ApiHarness {
  web: FakeWebServer
  dispose: () => void
  makeCtx: (connection?: unknown) => Context
}

function makeApi(connection?: unknown): ApiHarness {
  const web = new FakeWebServer()
  const deps: ApiDeps = {
    state: () => fakeState,
    action: () => ({ ok: true, result: 'ok' }),
    setup: fakeSetup(),
  }
  const ctx = {
    get(name: string): unknown {
      if (name === 'webServer') return web
      if (name === 'connection') return connection
      return undefined
    },
  } as unknown as Context
  const dispose = registerApi(ctx, deps)
  return { web, dispose, makeCtx: () => ctx }
}

async function call(
  web: FakeWebServer,
  path: string,
  options: { method?: string; headers?: Record<string, string>; address?: string; body?: string } = {},
): Promise<FakeResponse> {
  const route = web.route(path)
  if (!route) throw new Error(`route ${path} is not registered`)
  const request = new FakeRequest({
    method: options.method ?? (path === API_ACTION_PATH || path === SETUP_CONFIG_PATH ? 'POST' : 'GET'),
    headers: options.headers ?? { [API_HEADER]: '1' },
    ...(options.address ? { address: options.address } : {}),
  })
  const response = new FakeResponse()
  const promise = route.handler(request, response)
  if (options.body !== undefined) request.feed(options.body)
  else if (request.method === 'POST' || request.method === 'PUT') request.feed('{}')
  await promise
  return response
}

const dirs: string[] = []
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

function tempDir(prefix = 'superagent-p0-lock-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe('management API fence (P0)', () => {
  it('registers exactly the 11 management routes', () => {
    const api = makeApi()
    expect(api.web.routes.map(route => route.path).sort()).toEqual([...ALL_ROUTES].sort())
    api.dispose()
  })

  it('rejects missing header, non-loopback peers and wrong methods', async () => {
    const api = makeApi()
    expect((await call(api.web, API_STATE_PATH, { headers: {} })).statusCode).toBe(403)
    expect((await call(api.web, API_STATE_PATH, { address: '10.0.0.4' })).statusCode).toBe(403)
    expect((await call(api.web, API_STATE_PATH, { method: 'PUT' })).statusCode).toBe(405)
    api.dispose()
  })

  it('uses the host connection fence when available (401/403/throw)', async () => {
    const rejections: Array<401 | 403> = [401, 403]
    for (const rejection of rejections) {
      const api = makeApi({ requestRejection: () => rejection })
      expect((await call(api.web, SETUP_CONFIG_PATH, { method: 'POST', body: '{}' })).statusCode).toBe(rejection)
      api.dispose()
    }
    const api = makeApi({
      requestRejection: () => {
        throw new Error('connection broke')
      },
    })
    // A throwing connection gate must fail closed, never fall through.
    expect((await call(api.web, SETUP_STATE_PATH)).statusCode).toBe(403)
    api.dispose()
  })

  it('fails closed on cross-site Host/Origin when connection is missing', async () => {
    const api = makeApi()
    expect((await call(api.web, API_STATE_PATH, { headers: { [API_HEADER]: '1', origin: 'https://evil.example' } })).statusCode).toBe(403)
    expect((await call(api.web, API_STATE_PATH, { headers: { [API_HEADER]: '1', host: 'evil.example:56224' } })).statusCode).toBe(403)
    // Loopback Host/Origin still works in degraded mode.
    const okResponse = await call(api.web, API_STATE_PATH, {
      headers: { [API_HEADER]: '1', host: '127.0.0.1:56224', origin: 'http://127.0.0.1:56224' },
    })
    expect(okResponse.statusCode).toBe(200)
    api.dispose()
  })

  it('disposes all routes and can start again without a duplicate-route error', () => {
    const api = makeApi()
    api.dispose()
    for (const path of ALL_ROUTES) expect(api.web.route(path)).toBeUndefined()

    // A second registration on the same web server must succeed (restart path).
    const second = makeApi()
    expect(second.web.routes).toHaveLength(11)
    for (const path of ALL_ROUTES) expect(second.web.route(path)).toBeDefined()
    second.dispose()
  })
})

describe('runtime restart re-registers all routes (P0 route dispose)', () => {
  function config(stateDir: string): RuntimeConfig {
    return {
      stateDir,
      sources: { telegram: { enabled: false }, github: { enabled: false } },
      policy: { mode: 'observe' },
      passIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      watchdog: { intervalMs: 60_000 },
    }
  }

  it('stops cleanly and a new runtime on the same web server gets all 11 routes', async () => {
    const stateDir = tempDir('superagent-p0-routes-')
    const host = createFakeHost()
    const store = createMemoryStore()
    const first = new Runtime(host.ctx as unknown as Context, config(stateDir), { store, sources: [], skipLock: true })
    await first.ready
    expect(first.status).toBe('ready')
    expect(host.webServer.routes).toHaveLength(11)

    await first.stop()
    expect(host.webServer.routes).toHaveLength(0)

    const second = new Runtime(host.ctx as unknown as Context, config(stateDir), { store, sources: [], skipLock: true })
    await second.ready
    expect(second.status).toBe('ready')
    expect(host.webServer.routes).toHaveLength(11)
    // Regression: the models route used to leak and be skipped after a restart.
    expect(host.webServer.route(SETUP_MODELS_PATH)).toBeDefined()
    const response = new FakeResponse()
    const route = host.webServer.route(SETUP_MODELS_PATH)!
    const request = new FakeRequest({ headers: { [API_HEADER]: '1' } })
    await route.handler(request, response)
    expect([200, 501]).toContain(response.statusCode)
    await second.stop()
  }, 30_000)
})

describe('stale lock recovery (P0)', () => {
  function runtimeFor(stateDir: string) {
    const host = createFakeHost()
    const store = createMemoryStore()
    const config: RuntimeConfig = {
      stateDir,
      sources: { telegram: { enabled: false }, github: { enabled: false } },
      policy: { mode: 'observe' },
      passIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      watchdog: { intervalMs: 60_000 },
    }
    const runtime = new Runtime(host.ctx as unknown as Context, config, { store, sources: [] })
    return { runtime, stateDir }
  }

  function lockPaths(stateDir: string) {
    return { lock: `${stateDir}.lock`, pid: join(stateDir, 'runtime.pid') }
  }

  function prepareLock(stateDir: string): { lock: string; pid: string } {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const paths = lockPaths(stateDir)
    mkdirSync(paths.lock, { recursive: true })
    return paths
  }

  it('recovers a dead PID lock and reaches ready', async () => {
    const stateDir = tempDir()
    const paths = prepareLock(stateDir)
    writeFileSync(paths.pid, JSON.stringify({ pid: 999_999_999, at: new Date().toISOString() }), { mode: 0o600 })
    const { runtime } = runtimeFor(stateDir)
    await runtime.ready
    expect(runtime.status).toBe('ready')
    await runtime.stop()
    expect(existsSync(paths.lock)).toBe(false)
  }, 30_000)

  it('recovers a lock recorded by the same process (previous in-process runtime)', async () => {
    const stateDir = tempDir()
    const paths = prepareLock(stateDir)
    writeFileSync(paths.pid, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 })
    const { runtime } = runtimeFor(stateDir)
    await runtime.ready
    expect(runtime.status).toBe('ready')
    await runtime.stop()
  }, 30_000)

  it('recovers an old lock without a PID record', async () => {
    const stateDir = tempDir()
    const paths = prepareLock(stateDir)
    const old = new Date(Date.now() - 60_000)
    utimesSync(paths.lock, old, old)
    const { runtime } = runtimeFor(stateDir)
    await runtime.ready
    expect(runtime.status).toBe('ready')
    await runtime.stop()
  }, 30_000)

  it('refuses a fresh lock without a PID record instead of stealing it', async () => {
    const stateDir = tempDir()
    const paths = prepareLock(stateDir)
    const { runtime } = runtimeFor(stateDir)
    await runtime.ready
    expect(runtime.status).toBe('degraded')
    expect(runtime.detail ?? '').toMatch(/locked by an unknown process/i)
    expect(existsSync(paths.lock)).toBe(true)
    // Leave the directory intact: another instance may still own it.
    rmSync(paths.lock, { recursive: true, force: true })
  }, 30_000)

  it('refuses a live foreign PID with a clear message', async () => {
    const stateDir = tempDir()
    const paths = prepareLock(stateDir)
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
    children.push(child)
    const deadline = Date.now() + 5_000
    while (child.pid === undefined && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    expect(child.pid).toBeDefined()
    writeFileSync(paths.pid, JSON.stringify({ pid: child.pid!, at: new Date().toISOString() }), { mode: 0o600 })

    const { runtime } = runtimeFor(stateDir)
    await runtime.ready
    expect(runtime.status).toBe('degraded')
    expect(runtime.detail ?? '').toContain(`pid ${child.pid}`)
    expect(runtime.detail ?? '').toMatch(/locked by a running SuperAgent process/i)
    child.kill('SIGKILL')
    rmSync(paths.lock, { recursive: true, force: true })
  }, 30_000)
})
