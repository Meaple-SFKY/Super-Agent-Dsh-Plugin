/**
 * Setup wizard backend tests (docs/002-setup-api.md).
 *
 * Covers: token validation success/failure without token leakage, 0600 secret
 * files + 0700 secrets dir, default vs explicit tokenFile, account state
 * without reading secrets, configEditor persistence (response before edit),
 * the 501 fallback when configEditor is unavailable, permissions content and
 * the HTTP fence/ordering through `registerApi`.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  SetupService,
  SETUP_CONFIG_PATH,
  SETUP_GITHUB_PATH,
  SETUP_PERMISSIONS_PATH,
  SETUP_STATE_PATH,
  SETUP_TELEGRAM_PATH,
  type ConfigEditorLike,
  type GithubHelpers,
  type SetupDeps,
  type TelegramHelpers,
} from '../src/app/setup.js'
import { registerApi, API_HEADER } from '../src/app/api.js'
import { redactDetail, validateConfig, Runtime, type RuntimeConfig } from '../src/app/runtime.js'
import { createMemoryStore } from '../src/app/store.js'
import type { KeyValueStore } from '../src/core/ports.js'
import type { Context } from '@deepseek-ai/cordis'
import { FakeWebServer, RecordingLogger, createFakeHost } from './runtime-host.js'
import { EventEmitter } from 'node:events'

class FakeRequest extends EventEmitter {
  method: string
  headers: Record<string, string>
  socket: { remoteAddress: string }
  bodyText?: string

  constructor(options: { method?: string; headers?: Record<string, string>; address?: string; body?: string } = {}) {
    super()
    this.method = options.method ?? 'GET'
    this.headers = options.headers ?? {}
    this.socket = { remoteAddress: options.address ?? '127.0.0.1' }
    if (options.body !== undefined) this.bodyText = options.body
  }

  feed(text?: string): void {
    if (text !== undefined) this.emit('data', Buffer.from(text))
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

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-setup-'))
  dirs.push(dir)
  return dir
}

class MemoryKV implements KeyValueStore {
  private readonly map = new Map<string, unknown>()

  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined
  }

  set<T>(key: string, value: T): void {
    this.map.set(key, value)
  }

  delete(key: string): void {
    this.map.delete(key)
  }

  keys(prefix?: string): string[] {
    const keys = [...this.map.keys()]
    return prefix === undefined ? keys : keys.filter(key => key.startsWith(prefix))
  }
}

interface FakeEditor extends ConfigEditorLike {
  calls: Array<{ entry: unknown; next: Record<string, unknown> }>
}

function fakeEditor(seen: Array<{ entry: unknown; next: Record<string, unknown> }> = []): FakeEditor {
  return {
    calls: seen,
    async edit(entry, change) {
      const next = change({}, {})
      seen.push({ entry, next })
    },
  }
}

const TELEGRAM_STUB: TelegramHelpers = {
  async validate(token) {
    if (token === 'bad') throw Object.assign(new Error('Telegram token check failed: Unauthorized (Telegram error 401)'), {
      name: 'TelegramTokenValidationError',
      code: 401,
    })
    if (token === 'offline') throw Object.assign(new Error('Telegram token check failed: network error'), {
      name: 'TelegramTokenValidationError',
      code: 0,
    })
    return { botUsername: 'my_super_bot', botId: 4242 }
  },
}

const GITHUB_STUB: GithubHelpers = {
  async validate(token) {
    if (token === 'bad') throw Object.assign(new Error('GitHub token check failed: HTTP 401: Bad credentials'), {
      name: 'GithubTokenValidationError',
      status: 401,
    })
    return { login: 'octocat' }
  },
  async listRepositories() {
    return [
      { fullName: 'octocat/one', private: false, pushedAt: '2026-01-01T00:00:00Z', archived: false, fork: false },
      { fullName: 'octocat/two', private: true, pushedAt: '2025-12-01T00:00:00Z', archived: false, fork: false },
    ]
  },
}

interface Harness {
  stateDir: string
  kv: MemoryKV
  logger: RecordingLogger
  service: SetupService
  editor: FakeEditor
  scheduled: Array<() => void>
  config: Record<string, unknown>
  cleanup: () => void
}

function makeHarness(overrides: Partial<SetupDeps> = {}, options: { editor?: ConfigEditorLike | null } = {}): Harness {
  const stateDir = tempStateDir()
  const kv = new MemoryKV()
  const logger = new RecordingLogger()
  const scheduled: Array<() => void> = []
  const editor = (options.editor ?? fakeEditor()) as FakeEditor
  const config = {
    stateDir,
    sources: {
      telegram: { enabled: true, tokenEnv: 'SUPERAGENT_TELEGRAM_TOKEN', allowedUserIds: ['1'] },
      github: { enabled: true, repositories: ['octocat/one'] },
    },
    policy: { mode: 'observe' as const },
    executor: { maxWorkers: 2 },
  }
  const deps: SetupDeps = {
    stateDir,
    kv,
    logger,
    plugin: () => ({ status: 'ready', detail: null }),
    currentConfig: () => config,
    validateConfig: candidate => validateConfig(candidate).problem?.error,
    configEditor: () => (options.editor === null ? undefined : editor),
    hostEntry: () => ({ id: 'dsh-superagent-personal' }),
    redact: redactDetail,
    schedule: run => {
      scheduled.push(run)
    },
    loadTelegramHelpers: async () => TELEGRAM_STUB,
    loadGithubHelpers: async () => GITHUB_STUB,
    ...overrides,
  }
  return {
    stateDir,
    kv,
    logger,
    service: new SetupService(deps),
    editor,
    scheduled,
    config,
    cleanup: () => rmSync(stateDir, { recursive: true, force: true }),
  }
}

function runScheduled(harness: Harness): void {
  for (const run of harness.scheduled.splice(0)) run()
}

function secretsFile(stateDir: string, name: string): string {
  return join(stateDir, 'secrets', name)
}

describe('setup wizard backend', () => {
  it('validates a Telegram token, writes it 0600 and never leaks it', async () => {
    const harness = makeHarness()
    const token = '123456:AAH-super-secret-token-value'
    const result = await harness.service.saveTelegram({ token })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, botUsername: 'my_super_bot', botId: 4242 })
    const tokenFile = secretsFile(harness.stateDir, 'telegram-token')
    expect(result.body.tokenFile).toBe(tokenFile)
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe(token)
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
    expect(statSync(join(harness.stateDir, 'secrets')).mode & 0o777).toBe(0o700)

    const state = await harness.service.state()
    const telegram = (state.body.accounts as { telegram: Record<string, unknown> }).telegram
    expect(telegram.configured).toBe(true)
    expect(telegram.botUsername).toBe('my_super_bot')
    expect(JSON.stringify(state.body)).not.toContain(token)
    expect(harness.logger.text()).not.toContain(token)
  })

  it('maps invalid tokens to 400 and transport failures to 502, without writing a file', async () => {
    const harness = makeHarness()
    const invalid = await harness.service.saveTelegram({ token: 'bad' })
    expect(invalid.status).toBe(400)
    expect(invalid.body).toMatchObject({ ok: false, error: 'invalid_token' })
    expect(String(invalid.body.description)).toContain('Unauthorized')
    expect(ruin(() => statSync(secretsFile(harness.stateDir, 'telegram-token')))).toBe(true)

    const offline = await harness.service.saveTelegram({ token: 'offline' })
    expect(offline.status).toBe(502)
    expect(offline.body).toMatchObject({ ok: false, error: 'validation_failed' })

    const empty = await harness.service.saveTelegram({ token: '   ' })
    expect(empty.status).toBe(400)
    expect(empty.body.error).toBe('invalid_token')
  })

  it('accepts an explicit absolute tokenFile and rejects relative paths', async () => {
    const harness = makeHarness()
    const custom = join(harness.stateDir, 'custom', 'tg.txt')
    const ok = await harness.service.saveTelegram({ token: 't', tokenFile: custom })
    expect(ok.status).toBe(200)
    expect(ok.body.tokenFile).toBe(custom)
    expect(readFileSync(custom, 'utf8').trim()).toBe('t')
    expect(statSync(custom).mode & 0o777).toBe(0o600)

    const relative = await harness.service.saveTelegram({ token: 't', tokenFile: 'relative/path' })
    expect(relative.status).toBe(400)
    expect(relative.body.error).toBe('invalid_token_file')
  })

  it('reports the GitHub allowSelf option from the current configuration', async () => {
    const harness = makeHarness()
    const byDefault = (await harness.service.state()).body.accounts as { github: { allowSelf: boolean } }
    expect(byDefault.github.allowSelf).toBe(false)

    const configured = harness.config.sources as { github: Record<string, unknown> }
    configured.github.allowSelf = true
    const enabled = (await harness.service.state()).body.accounts as { github: { allowSelf: boolean } }
    expect(enabled.github.allowSelf).toBe(true)
  })

  it('validates a GitHub token, lists repositories and caches only non-secret metadata', async () => {
    const harness = makeHarness()
    const result = await harness.service.saveGithub({ token: 'ghp_super_secret' })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, login: 'octocat' })
    expect((result.body.repositories as unknown[]).length).toBe(2)
    const githubFile = secretsFile(harness.stateDir, 'github-token')
    expect(readFileSync(githubFile, 'utf8').trim()).toBe('ghp_super_secret')
    expect(statSync(githubFile).mode & 0o777).toBe(0o600)

    const state = await harness.service.state()
    const github = (state.body.accounts as { github: Record<string, unknown> }).github
    expect(github.configured).toBe(true)
    expect(github.login).toBe('octocat')
    expect(github.count).toBe(2)
    expect(github.repositories).toEqual(['octocat/one', 'octocat/two'])
    expect(JSON.stringify(state.body)).not.toContain('ghp_super_secret')
  })

  it('returns 501 when the source validation helpers are unavailable', async () => {
    const harness = makeHarness({ loadTelegramHelpers: async () => undefined, loadGithubHelpers: async () => undefined })
    const telegram = await harness.service.saveTelegram({ token: 't' })
    expect(telegram.status).toBe(501)
    expect(telegram.body.error).toBe('validation_unavailable')
    const github = await harness.service.saveGithub({ token: 't' })
    expect(github.status).toBe(501)
  })

  it('reads account state without reading token contents', async () => {
    const harness = makeHarness({
      loadTelegramHelpers: async () => {
        throw new Error('state must not touch the network')
      },
      loadGithubHelpers: async () => {
        throw new Error('state must not touch the network')
      },
    })
    mkdirSync(join(harness.stateDir, 'secrets'), { recursive: true, mode: 0o700 })
    writeFileSync(secretsFile(harness.stateDir, 'telegram-token'), 'SENTINEL-SECRET-VALUE', { mode: 0o600 })
    const state = await harness.service.state()
    expect((state.body.accounts as { telegram: { configured: boolean } }).telegram.configured).toBe(true)
    expect(JSON.stringify(state.body)).not.toContain('SENTINEL-SECRET-VALUE')
  })

  it('persists merged config through configEditor after returning restarting:true', async () => {
    const harness = makeHarness()
    const prepared = harness.service.prepareConfig({
      config: {
        sources: { telegram: { allowedUserIds: ['1', '2'] }, github: { repositories: ['octocat/one', 'octocat/two'] } },
        policy: { mode: 'auto' },
        executor: { maxWorkers: 3 },
      },
    })
    expect(prepared.result.status).toBe(200)
    expect(prepared.result.body).toEqual({ ok: true, restarting: true })
    expect(prepared.patch).toBeDefined()
    expect(harness.editor.calls).toHaveLength(0)

    harness.service.commitConfigSoon(prepared.patch!)
    expect(harness.kv.get<boolean>('superagent.setup.restartPending')).toBe(true)
    expect(harness.editor.calls).toHaveLength(0)
    runScheduled(harness)
    await harness.service.waitForCommit()

    expect(harness.editor.calls).toHaveLength(1)
    const next = harness.editor.calls[0]!.next
    expect(next.stateDir).toBe(harness.stateDir)
    expect(next.sources).toMatchObject({
      telegram: { allowedUserIds: ['1', '2'] },
      github: { repositories: ['octocat/one', 'octocat/two'] },
    })
    expect(next.policy).toMatchObject({ mode: 'auto' })
    expect(next.executor).toMatchObject({ maxWorkers: 3 })

    harness.service.markRestarted()
    expect(harness.kv.get<boolean>('superagent.setup.restartPending')).toBeUndefined()
  })

  it('returns 501 for config writes when configEditor is unavailable', () => {
    const harness = makeHarness({}, { editor: null })
    const prepared = harness.service.prepareConfig({ config: { policy: { mode: 'auto' } } })
    expect(prepared.result.status).toBe(501)
    expect(prepared.result.body.error).toBe('config_editor_unavailable')
    expect(prepared.patch).toBeUndefined()
  })

  it('rejects invalid configuration patches', () => {
    const harness = makeHarness()
    expect(harness.service.prepareConfig({}).result.status).toBe(400)
    expect(harness.service.prepareConfig({ config: { policy: { mode: 'always' } } }).result.status).toBe(400)
    expect(
      harness.service.prepareConfig({ config: { sources: { telegram: { tokenFile: 'relative' } } } }).result.status,
    ).toBe(400)
    expect(
      harness.service.prepareConfig({ config: { sources: { telegram: { enabled: false } } } }).result.status,
    ).toBe(200)
  })

  it('serves the static permissions explanation', () => {
    const harness = makeHarness()
    const result = harness.service.permissions()
    expect(result.status).toBe(200)
    const permissions = result.body.permissions as Array<{ id: string; state: string; restartRequired: boolean }>
    const byId = new Map(permissions.map(permission => [permission.id, permission]))
    expect(byId.get('macos-screen-recording')?.state).toBe('not-required')
    expect(byId.get('macos-accessibility')?.state).toBe('not-required')
    expect(byId.get('macos-full-disk-access')?.state).toBe('not-required')
    expect(byId.get('watchdog')?.state).toBe('optional')
    expect(byId.get('telegram-bot')?.restartRequired).toBe(true)
    expect(byId.get('restart')?.restartRequired).toBe(true)
  })
})

describe('setup HTTP routes', () => {
  function makeApi(harness: Harness): { web: FakeWebServer; dispose: () => void } {
    const web = new FakeWebServer()
    const ctx = { get: (name: string) => (name === 'webServer' ? web : undefined) } as unknown as Context
    const dispose = registerApi(ctx, {
      state: () => {
        throw new Error('not used')
      },
      action: () => ({ ok: false, error: 'not used' }),
      setup: harness.service,
      logger: { warn: () => undefined },
    })
    return { web, dispose }
  }

  async function invoke(web: FakeWebServer, path: string, req: FakeRequest): Promise<FakeResponse> {
    const route = web.route(path)
    if (!route) throw new Error(`route ${path} is not registered`)
    const response = new FakeResponse()
    const promise = route.handler(req, response)
    req.feed(req.bodyText)
    await promise
    return response
  }

  it('registers every setup route behind the loopback + header fence', async () => {
    const harness = makeHarness()
    const api = makeApi(harness)
    for (const path of [
      SETUP_STATE_PATH,
      SETUP_TELEGRAM_PATH,
      SETUP_GITHUB_PATH,
      SETUP_CONFIG_PATH,
      SETUP_PERMISSIONS_PATH,
    ]) {
      expect(api.web.route(path)).toBeDefined()
    }

    const forbidden = await invoke(api.web, SETUP_STATE_PATH, new FakeRequest({}))
    expect(forbidden.statusCode).toBe(403)
    const remote = await invoke(api.web, SETUP_STATE_PATH, new FakeRequest({ headers: { [API_HEADER]: '1' }, address: '10.0.0.9' }))
    expect(remote.statusCode).toBe(403)

    const ok = await invoke(api.web, SETUP_STATE_PATH, new FakeRequest({ headers: { [API_HEADER]: '1' } }))
    expect(ok.statusCode).toBe(200)
    expect(ok.json<{ ok: boolean }>().ok).toBe(true)
    api.dispose()
  })

  it('saves a token through the route and never echoes it', async () => {
    const harness = makeHarness()
    const api = makeApi(harness)
    const response = await invoke(
      api.web,
      SETUP_TELEGRAM_PATH,
      new FakeRequest({ method: 'POST', headers: { [API_HEADER]: '1' }, body: JSON.stringify({ token: 'abc:secret' }) }),
    )
    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain('abc:secret')
    expect(response.json<{ ok: boolean }>().ok).toBe(true)
  })

  it('answers PUT config before the configEditor edit runs (restart safety)', async () => {
    const order: string[] = []
    const harness = makeHarness(
      {
        schedule: run => {
          order.push('schedule')
          run()
        },
      },
      {
        editor: {
          async edit(entry) {
            order.push(`edit:${String((entry as { id?: string }).id)}`)
          },
        },
      },
    )
    const api = makeApi(harness)
    const response = await invoke(
      api.web,
      SETUP_CONFIG_PATH,
      new FakeRequest({
        method: 'PUT',
        headers: { [API_HEADER]: '1' },
        body: JSON.stringify({ config: { policy: { mode: 'auto' } } }),
      }),
    )
    order.push('response')
    await harness.service.waitForCommit()
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, restarting: true })
    expect(order[0]).toBe('schedule')
    expect(order[1]).toBe('edit:dsh-superagent-personal')
    expect(order[2]).toBe('response')
  })
})

describe('runtime setup wiring', () => {
  it('boots a runtime that registers the setup routes and serves state', async () => {
    const stateDir = tempStateDir()
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
    const runtime = new Runtime(host.ctx as unknown as Context, config, {
      store,
      sources: [],
      skipLock: true,
    })
    try {
      await runtime.ready
      expect(runtime.status).toBe('ready')
      expect(host.webServer.route(SETUP_STATE_PATH)).toBeDefined()
      expect(host.webServer.route(SETUP_PERMISSIONS_PATH)).toBeDefined()

      const route = host.webServer.route(SETUP_STATE_PATH)!
      const response = new FakeResponse()
      const promise = route.handler(new FakeRequest({ headers: { [API_HEADER]: '1' } }), response)
      await promise
      expect(response.statusCode).toBe(200)
      const state = response.json<{ ok: boolean; stateDir: string; accounts: unknown }>()
      expect(state.ok).toBe(true)
      expect(state.stateDir).toBe(stateDir)
      expect(state.accounts).toBeDefined()
    } finally {
      await runtime.stop()
    }
  })
})

function ruin(run: () => unknown): boolean {
  try {
    run()
    return false
  } catch {
    return true
  }
}
