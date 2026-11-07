/**
 * Setup wizard backend tests (docs/002-setup-api.md).
 *
 * Covers: token validation success/failure without token leakage, 0600 secret
 * files + 0700 secrets dir, default vs explicit tokenFile, account state
 * without reading secrets, configEditor persistence (response before edit),
 * the 501 fallback when configEditor is unavailable, permissions content and
 * the HTTP fence/ordering through `registerApi`.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  SetupService,
  SETUP_MODELS_PATH,
  SETUP_OPERATOR_PATH,
  SETUP_SSH_KEY_PATH,
  SETUP_WATCHDOG_PATH,
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
import { FakeLlm, FakeWebServer, RecordingLogger, createFakeHost } from './runtime-host.js'
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
    // Watchdog defaults never touch the real launchctl/plist in unit tests.
    runProcess: async () => ({ code: 1, stdout: '', stderr: '' }),
    watchdogPlistPath: () => join(stateDir, 'watchdog.plist'),
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
    configured.github.collaborators = ['me-owner', 'reviewer']
    const enabled = (await harness.service.state()).body.accounts as {
      github: { allowSelf: boolean; collaborators: string[] }
    }
    expect(enabled.github.allowSelf).toBe(true)
    expect(enabled.github.collaborators).toEqual(['me-owner', 'reviewer'])
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
    const prepared = await harness.service.prepareConfig({
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

  it('returns 501 for config writes when configEditor is unavailable', async () => {
    const harness = makeHarness({}, { editor: null })
    const prepared = await harness.service.prepareConfig({ config: { policy: { mode: 'auto' } } })
    expect(prepared.result.status).toBe(501)
    expect(prepared.result.body.error).toBe('config_editor_unavailable')
    expect(prepared.patch).toBeUndefined()
  })

  it('rejects invalid configuration patches', async () => {
    const harness = makeHarness()
    expect((await harness.service.prepareConfig({})).result.status).toBe(400)
    expect((await harness.service.prepareConfig({ config: { policy: { mode: 'always' } } })).result.status).toBe(400)
    expect(
      (await harness.service.prepareConfig({ config: { sources: { telegram: { tokenFile: 'relative' } } } })).result.status,
    ).toBe(400)
    expect(
      (await harness.service.prepareConfig({ config: { sources: { telegram: { enabled: false } } } })).result.status,
    ).toBe(200)
  })

  it('exposes and accepts the bot language (zh default, en switch)', async () => {
    const harness = makeHarness()
    const initial = (await harness.service.state()).body as { language: string }
    expect(initial.language).toBe('zh')

    harness.config.language = 'en'
    const switched = (await harness.service.state()).body as { language: string }
    expect(switched.language).toBe('en')

    const prepared = await harness.service.prepareConfig({ config: { language: 'en' } })
    expect(prepared.result.status).toBe(200)
    expect(prepared.result.body).toEqual({ ok: true, restarting: true })
    expect(prepared.patch?.language).toBe('en')
    harness.service.commitConfigSoon(prepared.patch!)
    runScheduled(harness)
    await harness.service.waitForCommit()
    expect(harness.editor.calls[0]!.next.language).toBe('en')

    const invalid = await harness.service.prepareConfig({ config: { language: 'fr' } })
    expect(invalid.result.status).toBe(400)
    expect(invalid.result.body.error).toBe('invalid_config')
  })

  it('exposes the bot git identity without reading the key file', async () => {
    const harness = makeHarness()
    const keyFile = join(harness.stateDir, 'secrets', 'bot_ed25519')
    mkdirSync(join(harness.stateDir, 'secrets'), { recursive: true, mode: 0o700 })
    writeFileSync(keyFile, 'PRIVATE-KEY-CONTENT', { mode: 0o600 })
    const config = harness.config.sources as { github: Record<string, unknown> }
    config.github.login = 'cine-bot'
    const executor = harness.config.executor as Record<string, unknown>
    executor.gitSshKeyFile = keyFile

    const state = (await harness.service.state()).body as {
      git: { name: string; email: string; sshKeyFile: string; sshKeyConfigured: boolean }
    }
    expect(state.git).toEqual({
      name: 'cine-bot',
      email: 'cine-bot@users.noreply.github.com',
      sshKeyFile: keyFile,
      sshKeyConfigured: true,
    })
    expect(JSON.stringify(state)).not.toContain('PRIVATE-KEY-CONTENT')

    executor.gitName = 'Cine Bot'
    executor.gitEmail = 'bot@example.com'
    const explicit = (await harness.service.state()).body as { git: { name: string; email: string } }
    expect(explicit.git).toMatchObject({ name: 'Cine Bot', email: 'bot@example.com' })

    const prepared = await harness.service.prepareConfig({
      config: { executor: { gitName: 'Cine Bot', gitEmail: 'bot@example.com', gitSshKeyFile: keyFile } },
    })
    expect(prepared.result.status).toBe(200)
    expect(prepared.patch?.executor).toMatchObject({ gitName: 'Cine Bot', gitEmail: 'bot@example.com' })

    const relativeKey = await harness.service.prepareConfig({ config: { executor: { gitSshKeyFile: 'relative/key' } } })
    expect(relativeKey.result.status).toBe(400)
    expect(relativeKey.result.body.error).toBe('invalid_config')
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
  function makeApi(
    harness: Harness,
    options: { connection?: unknown; warnings?: string[] } = {},
  ): { web: FakeWebServer; dispose: () => void } {
    const web = new FakeWebServer()
    const ctx = {
      get: (name: string) => {
        if (name === 'webServer') return web
        if (name === 'connection') return options.connection
        return undefined
      },
    } as unknown as Context
    const dispose = registerApi(ctx, {
      state: () => {
        throw new Error('not used')
      },
      action: () => ({ ok: false, error: 'not used' }),
      setup: harness.service,
      logger: { warn: (message: string) => options.warnings?.push(message) },
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
      SETUP_PERMISSIONS_PATH,
      SETUP_MODELS_PATH,
      SETUP_TELEGRAM_PATH,
      SETUP_GITHUB_PATH,
      SETUP_SSH_KEY_PATH,
      SETUP_WATCHDOG_PATH,
      SETUP_OPERATOR_PATH,
      SETUP_CONFIG_PATH,
    ]) {
      expect(api.web.route(path)).toBeDefined()
    }
    expect(api.web.routes).toHaveLength(11) // state/action + 9 setup routes

    const forbidden = await invoke(api.web, SETUP_STATE_PATH, new FakeRequest({}))
    expect(forbidden.statusCode).toBe(403)
    const remote = await invoke(api.web, SETUP_STATE_PATH, new FakeRequest({ headers: { [API_HEADER]: '1' }, address: '10.0.0.9' }))
    expect(remote.statusCode).toBe(403)

    const ok = await invoke(api.web, SETUP_STATE_PATH, new FakeRequest({ headers: { [API_HEADER]: '1' } }))
    expect(ok.statusCode).toBe(200)
    expect(ok.json<{ ok: boolean }>().ok).toBe(true)
    api.dispose()
    expect(api.web.routes).toHaveLength(0)
  })

  it('applies the host connection fence when available', async () => {
    const harness = makeHarness()
    const api = makeApi(harness, { connection: { requestRejection: () => 403 as const } })
    const rejected = await invoke(api.web, SETUP_STATE_PATH, new FakeRequest({ headers: { [API_HEADER]: '1' } }))
    expect(rejected.statusCode).toBe(403)
    expect(rejected.json<{ error: string }>().error).toBe('forbidden')

    api.dispose()
    const unauthorized = makeApi(harness, { connection: { requestRejection: () => 401 as const } })
    const response = await invoke(unauthorized.web, SETUP_MODELS_PATH, new FakeRequest({ headers: { [API_HEADER]: '1' } }))
    expect(response.statusCode).toBe(401)
    expect(response.json<{ error: string }>().error).toBe('unauthorized')
    unauthorized.dispose()
  })

  it('degrades explicitly without a connection service: loopback Host/Origin checks', async () => {
    const harness = makeHarness()
    const warnings: string[] = []
    const api = makeApi(harness, { warnings })
    const evilOrigin = await invoke(
      api.web,
      SETUP_STATE_PATH,
      new FakeRequest({ headers: { [API_HEADER]: '1', origin: 'https://evil.example' } }),
    )
    expect(evilOrigin.statusCode).toBe(403)
    const evilHost = await invoke(
      api.web,
      SETUP_STATE_PATH,
      new FakeRequest({ headers: { [API_HEADER]: '1', host: 'evil.example' } }),
    )
    expect(evilHost.statusCode).toBe(403)
    const loopback = await invoke(
      api.web,
      SETUP_STATE_PATH,
      new FakeRequest({ headers: { [API_HEADER]: '1', origin: 'http://127.0.0.1:1234', host: '127.0.0.1:1234' } }),
    )
    expect(loopback.statusCode).toBe(200)
    expect(warnings.some(line => line.includes('connection service is unavailable'))).toBe(true)
    api.dispose()
  })

  it('does not throw or duplicate routes when registered twice', async () => {
    const harness = makeHarness()
    const web = new FakeWebServer()
    const ctx = { get: (name: string) => (name === 'webServer' ? web : undefined) } as unknown as Context
    const deps = {
      state: () => {
        throw new Error('not used')
      },
      action: () => ({ ok: false, error: 'not used' }),
      setup: harness.service,
      logger: { warn: () => undefined },
    }
    const first = registerApi(ctx, deps)
    expect(() => registerApi(ctx, deps)).not.toThrow()
    expect(web.routes).toHaveLength(11)
    first()
    expect(web.routes).toHaveLength(0)
    const second = registerApi(ctx, deps)
    expect(web.routes).toHaveLength(11)
    second()
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

describe('runtime route lifecycle (task-49)', () => {
  it('releases every route on stop and re-registers cleanly on restart', async () => {
    const stateDir = tempStateDir()
    const host = createFakeHost()
    const store = createMemoryStore()
    const make = (): Runtime =>
      new Runtime(
        host.ctx as unknown as Context,
        {
          stateDir,
          sources: { telegram: { enabled: false }, github: { enabled: false } },
          policy: { mode: 'observe' },
          passIntervalMs: 60_000,
          heartbeatIntervalMs: 60_000,
          watchdog: { intervalMs: 60_000 },
        },
        { store, sources: [], skipLock: true },
      )

    const first = make()
    await first.ready
    expect(host.webServer.routes).toHaveLength(11)
    const firstPaths = host.webServer.routes.map(route => route.path).sort()
    expect(new Set(firstPaths).size).toBe(11)
    await first.stop()
    expect(host.webServer.routes).toHaveLength(0)

    const second = make()
    await second.ready
    expect(host.webServer.routes).toHaveLength(11)
    expect(host.webServer.routes.map(route => route.path).sort()).toEqual(firstPaths)
    await second.stop()
  })
})

describe('runtime setup ssh-key route (task-33)', () => {
  it('registers POST setup/github/ssh-key behind the fence and generates the key pair', async () => {
    const stateDir = tempStateDir()
    const host = createFakeHost()
    const store = createMemoryStore()
    const calls: string[][] = []
    let generationCount = 0
    const runtime = new Runtime(
      host.ctx as unknown as Context,
      {
        stateDir,
        sources: { telegram: { enabled: false }, github: { enabled: false } },
        policy: { mode: 'observe' },
        passIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        watchdog: { intervalMs: 60_000 },
      },
      {
        store,
        sources: [],
        skipLock: true,
        runSshKeygen: async (args: string[]) => {
          calls.push(args)
          generationCount += 1
          const keyFile = args[args.indexOf('-f') + 1]!
          mkdirSync(join(keyFile, '..'), { recursive: true, mode: 0o700 })
          writeFileSync(keyFile, 'PRIVATE-KEY', { mode: 0o600 })
          writeFileSync(`${keyFile}.pub`, 'ssh-ed25519 AAAA ROUTEKEY superagent-bot', { mode: 0o644 })
        },
      },
    )
    try {
      await runtime.ready
      const route = host.webServer.route(SETUP_SSH_KEY_PATH)
      expect(route).toBeDefined()

      const forbidden = new FakeResponse()
      await route!.handler(new FakeRequest({ method: 'POST' }), forbidden)
      expect(forbidden.statusCode).toBe(403)

      const response = new FakeResponse()
      await route!.handler(new FakeRequest({ method: 'POST', headers: { [API_HEADER]: '1' } }), response)
      expect(response.statusCode).toBe(200)
      const body = response.json<{ ok: boolean; publicKey: string; keyFile: string; created: boolean; restarting?: boolean }>()
      expect(body).toMatchObject({ ok: true, created: true, restarting: false })
      expect(body.publicKey).toContain('ssh-ed25519 AAAA ROUTEKEY')
      expect(body.keyFile).toBe(join(stateDir, 'secrets', 'github-ssh', 'id_ed25519'))
      expect(response.body).not.toContain('PRIVATE-KEY')
      expect(statSync(body.keyFile).mode & 0o777).toBe(0o600)

      const again = new FakeResponse()
      await route!.handler(new FakeRequest({ method: 'POST', headers: { [API_HEADER]: '1' } }), again)
      expect(again.json<{ created: boolean }>().created).toBe(false)
      expect(generationCount).toBe(1)
      expect(calls).toHaveLength(1)

      const wrongMethod = new FakeResponse()
      await route!.handler(new FakeRequest({ method: 'GET', headers: { [API_HEADER]: '1' } }), wrongMethod)
      expect(wrongMethod.statusCode).toBe(405)
    } finally {
      await runtime.stop()
    }
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
      // The watchdog writes the uninstall state marker once it starts.
      const marker = JSON.parse(readFileSync(join(stateDir, '.superagent-state'), 'utf8')) as {
        plugin: string
        markerVersion: number
      }
      expect(marker).toMatchObject({ plugin: 'dsh-superagent-personal', markerVersion: 1 })
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

describe('setup generated SSH key (task-33)', () => {
  interface KeygenCall {
    args: string[]
  }

  function fakeKeygen(calls: KeygenCall[], options: { failWith?: NodeJS.ErrnoException; skipPublic?: boolean } = {}) {
    return async (args: string[]): Promise<void> => {
      calls.push({ args })
      if (options.failWith) throw options.failWith
      const file = args[args.indexOf('-f') + 1]!
      mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
      writeFileSync(file, 'PRIVATE-KEY-MATERIAL-MUST-NOT-LEAK', { mode: 0o600 })
      if (!options.skipPublic) {
        writeFileSync(`${file}.pub`, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEY superagent-bot\n', { mode: 0o644 })
      }
    }
  }

  it('generates the key pair with strict permissions and is idempotent', async () => {
    const calls: KeygenCall[] = []
    const harness = makeHarness({ runSshKeygen: fakeKeygen(calls) })
    const first = await harness.service.generateGithubSshKey()
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ ok: true, created: true, keyFile: join(harness.stateDir, 'secrets', 'github-ssh', 'id_ed25519') })
    expect(String(first.body.publicKey)).toContain('ssh-ed25519 ')
    expect(JSON.stringify(first.body)).not.toContain('PRIVATE-KEY-MATERIAL')
    const keyFile = String(first.body.keyFile)
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    expect(statSync(join(harness.stateDir, 'secrets', 'github-ssh')).mode & 0o777).toBe(0o700)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toEqual(['-t', 'ed25519', '-f', keyFile, '-N', '', '-C', 'superagent-bot', '-q'])

    const second = await harness.service.generateGithubSshKey()
    expect(second.body).toMatchObject({ ok: true, created: false, keyFile })
    expect(calls).toHaveLength(1) // existing key is never overwritten
    expect(JSON.stringify(second.body)).not.toContain('PRIVATE-KEY-MATERIAL')
  })

  it('reports a broken existing pair and a missing ssh-keygen without leaking the private key', async () => {
    const calls: KeygenCall[] = []
    const broken = makeHarness({ runSshKeygen: fakeKeygen(calls) })
    const brokenKeyDir = join(broken.stateDir, 'secrets', 'github-ssh')
    mkdirSync(brokenKeyDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(brokenKeyDir, 'id_ed25519'), 'PRIVATE-ONLY', { mode: 0o600 })
    const incomplete = await broken.service.generateGithubSshKey()
    expect(incomplete.status).toBe(409)
    expect(incomplete.body.error).toBe('ssh_key_pair_incomplete')
    expect(String(incomplete.body.description)).toContain('ssh-keygen -t ed25519')

    const missing = makeHarness({
      runSshKeygen: async () => {
        throw Object.assign(new Error('spawn ssh-keygen ENOENT'), { code: 'ENOENT' })
      },
    })
    const unavailable = await missing.service.generateGithubSshKey()
    expect(unavailable.status).toBe(501)
    expect(unavailable.body.error).toBe('ssh_keygen_unavailable')
    expect(String(unavailable.body.description)).toContain('ssh-keygen -t ed25519')
    expect(JSON.stringify(unavailable.body)).not.toContain('PRIVATE-KEY-MATERIAL')
  })

  it('persists executor.gitSshKeyFile after generation and exposes the public key in state', async () => {
    const calls: KeygenCall[] = []
    const harness = makeHarness({ runSshKeygen: fakeKeygen(calls) })
    const generated = await harness.service.generateGithubSshKey()
    const keyFile = String(generated.body.keyFile)

    expect(await harness.service.state()).toBeDefined()
    const state = (await harness.service.state()).body as {
      git: { sshKeyFile: string; sshKeyConfigured: boolean; publicKey?: string }
    }
    expect(state.git.sshKeyFile).toBe(keyFile)
    expect(state.git.sshKeyConfigured).toBe(true)
    expect(state.git.publicKey).toContain('ssh-ed25519 ')
    expect(JSON.stringify(state)).not.toContain('PRIVATE-KEY-MATERIAL')

    expect(harness.service.persistGitSshKey(keyFile)).toBe(true)
    expect(harness.kv.get<boolean>('superagent.setup.restartPending')).toBe(true)
    runScheduled(harness)
    await harness.service.waitForCommit()
    expect(harness.editor.calls).toHaveLength(1)
    expect((harness.editor.calls[0]!.next.executor as Record<string, unknown>).gitSshKeyFile).toBe(keyFile)
  })

  it('honours a custom configured key path in state and persists it only when configEditor exists', async () => {
    const harness = makeHarness({}, { editor: null })
    const custom = join(harness.stateDir, 'custom', 'bot_key')
    mkdirSync(join(harness.stateDir, 'custom'), { recursive: true })
    writeFileSync(custom, 'PRIVATE', { mode: 0o600 })
    writeFileSync(`${custom}.pub`, 'ssh-ed25519 AAAACUSTOM superagent-bot', { mode: 0o644 })
    const executor = harness.config.executor as Record<string, unknown>
    executor.gitSshKeyFile = custom
    const state = (await harness.service.state()).body as { git: { sshKeyFile: string; publicKey?: string } }
    expect(state.git.sshKeyFile).toBe(custom)
    expect(state.git.publicKey).toContain('AAAACUSTOM')
    expect(harness.service.persistGitSshKey(custom)).toBe(false)
  })
})

describe('setup model catalog + selection (task-34)', () => {
  it('lists providers and models, isolating a single failing provider', async () => {
    const llm = new FakeLlm()
    const harness = makeHarness({ llm: () => llm })
    const listed = await harness.service.listModels()
    expect(listed.status).toBe(200)
    const body = listed.body as {
      ok: boolean
      providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string; inputModalities?: string[] }> }>
      errors?: Array<{ provider: string; error: string }>
    }
    expect(body.ok).toBe(true)
    expect(body.providers.map(provider => provider.id)).toEqual(['deepseek', 'openrouter'])
    expect(body.providers[0]!.models.map(model => model.id)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(body.providers[0]!.models[0]!.description).toBe('fast')
    expect(body.errors).toBeUndefined()

    const partial = new FakeLlm(undefined, undefined, new Set(['openrouter']))
    const partialHarness = makeHarness({ llm: () => partial })
    const partialResult = await partialHarness.service.listModels()
    expect(partialResult.status).toBe(200)
    const partialBody = partialResult.body as {
      providers: Array<{ id: string }>
      errors?: Array<{ provider: string; error: string }>
    }
    expect(partialBody.providers.map(provider => provider.id)).toEqual(['deepseek'])
    expect(partialBody.errors?.[0]?.provider).toBe('openrouter')
    expect(partialBody.errors?.[0]?.error).toContain('unavailable')
  })

  it('returns 501 when the DSH llm service is unavailable', async () => {
    const harness = makeHarness({ llm: () => undefined })
    const result = await harness.service.listModels()
    expect(result.status).toBe(501)
    expect(result.body.error).toBe('llm_unavailable')
  })

  it('validates explicit provider/model/settings before saving', async () => {
    const seen: Array<{ provider: string; model: string; effort?: string }> = []
    const harness = makeHarness({
      validateModel: async (provider, model, reasoningEffort) => {
        seen.push({ provider, model, ...(reasoningEffort ? { effort: reasoningEffort } : {}) })
        return provider === 'bad-provider' ? 'unknown model bad-provider/x' : undefined
      },
    })
    const invalid = await harness.service.prepareConfig({
      config: { router: { provider: 'bad-provider', model: 'x' } },
    })
    expect(invalid.result.status).toBe(400)
    expect(invalid.result.body.error).toBe('invalid_model')
    expect(String(invalid.result.body.description)).toContain('router: unknown model')

    const valid = await harness.service.prepareConfig({
      config: {
        router: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
        executor: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'low' },
      },
    })
    expect(valid.result.status).toBe(200)
    expect(valid.result.body).toEqual({ ok: true, restarting: true })
    expect(seen).toEqual([
      { provider: 'bad-provider', model: 'x' },
      { provider: 'deepseek', model: 'deepseek-chat', effort: 'high' },
      { provider: 'deepseek', model: 'deepseek-reasoner', effort: 'low' },
    ])

    const pair = await harness.service.prepareConfig({ config: { router: { provider: 'deepseek' } } })
    expect(pair.result.status).toBe(400)
    expect(pair.result.body.error).toBe('invalid_config')
  })

  it('exposes the currently effective router/worker/default selections in state', async () => {
    const harness = makeHarness({
      models: () => ({
        router: { provider: 'router-provider', model: 'router-model', reasoningEffort: 'high' },
        worker: { provider: 'worker-provider', model: 'worker-model' },
        default: { provider: 'host', model: 'host-model' },
      }),
    })
    const state = (await harness.service.state()).body as { models: unknown }
    expect(state.models).toEqual({
      router: { provider: 'router-provider', model: 'router-model', reasoningEffort: 'high' },
      worker: { provider: 'worker-provider', model: 'worker-model' },
      default: { provider: 'host', model: 'host-model' },
    })
  })

  it('serves GET setup/models from the runtime route and reports effective state models', async () => {
    const llm = new FakeLlm()
    const stateDir = tempStateDir()
    const host = createFakeHost({ llm })
    const runtime = new Runtime(
      host.ctx as unknown as Context,
      {
        stateDir,
        sources: { telegram: { enabled: false }, github: { enabled: false } },
        policy: { mode: 'observe' },
        router: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
        executor: { provider: 'deepseek', model: 'deepseek-reasoner' },
        passIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        watchdog: { intervalMs: 60_000 },
      },
      { store: createMemoryStore(), sources: [], skipLock: true },
    )
    try {
      await runtime.ready

      const route = host.webServer.route(SETUP_MODELS_PATH)
      expect(route).toBeDefined()
      const forbidden = new FakeResponse()
      await route!.handler(new FakeRequest({ method: 'GET' }), forbidden)
      expect(forbidden.statusCode).toBe(403)
      const wrongMethod = new FakeResponse()
      await route!.handler(new FakeRequest({ method: 'POST', headers: { [API_HEADER]: '1' } }), wrongMethod)
      expect(wrongMethod.statusCode).toBe(405)

      const response = new FakeResponse()
      await route!.handler(new FakeRequest({ method: 'GET', headers: { [API_HEADER]: '1' } }), response)
      expect(response.statusCode).toBe(200)
      const body = response.json<{ ok: boolean; providers: Array<{ id: string }> }>()
      expect(body.ok).toBe(true)
      expect(body.providers.map(provider => provider.id)).toEqual(['deepseek', 'openrouter'])

      const stateRoute = host.webServer.route('/superagent/api/setup/state')!
      const stateResponse = new FakeResponse()
      await stateRoute.handler(new FakeRequest({ method: 'GET', headers: { [API_HEADER]: '1' } }), stateResponse)
      const state = stateResponse.json<{
        models: { router: unknown; worker: unknown; default: unknown }
      }>()
      expect(state.models.router).toEqual({
        provider: 'deepseek',
        model: 'deepseek-chat',
        reasoningEffort: 'high',
      })
      expect(state.models.worker).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
      expect(state.models.default).toBeNull()
    } finally {
      await runtime.stop()
    }
  })
})

describe('setup watchdog toggle (task-36)', () => {
  it('reports the LaunchAgent state (installed / running) without throwing', async () => {
    const harness = makeHarness()
    const idle = await harness.service.getWatchdog(true)
    expect(idle.status).toBe(200)
    expect(idle.body).toMatchObject({
      ok: true,
      installed: false,
      running: false,
      label: 'com.sfky.superagent.watchdog',
      stateDir: harness.stateDir,
    })
    expect(String(idle.body.detail)).toContain('not installed')

    const installedHarness = makeHarness()
    const plistPath = join(installedHarness.stateDir, 'watchdog.plist')
    writeFileSync(plistPath, '<plist/>', { mode: 0o600 })
    const calls: Array<{ file: string; args: string[] }> = []
    installedHarness.service = new SetupService({
      ...({
        stateDir: installedHarness.stateDir,
        kv: installedHarness.kv,
        logger: installedHarness.logger,
        plugin: () => ({ status: 'ready', detail: null }),
        currentConfig: () => installedHarness.config,
        validateConfig: candidate => validateConfig(candidate).problem?.error,
        configEditor: () => installedHarness.editor,
        hostEntry: () => ({ id: 'dsh-superagent-personal' }),
        runProcess: async (file, args) => {
          calls.push({ file, args })
          return { code: 0, stdout: '', stderr: '' }
        },
        watchdogPlistPath: () => plistPath,
      } satisfies SetupDeps),
    })
    const running = await installedHarness.service.getWatchdog(true)
    expect(running.body).toMatchObject({ installed: true, running: true, plistPath })
    expect(String(running.body.detail)).toContain('running')
    expect(calls[0]!.file).toBe('launchctl')
    expect(calls[0]!.args[0]).toBe('print')
    expect(calls[0]!.args[1]).toContain('com.sfky.superagent.watchdog')
  })

  it('enables/disables by running the repo scripts with --state-dir, output only in logs', async () => {
    const scriptPath = join(tempStateDir(), 'install-launchd.sh')
    const uninstallPath = join(tempStateDir(), 'uninstall.sh')
    writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(uninstallPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const calls: Array<{ file: string; args: string[]; timeout: number }> = []
    const harness = makeHarness({
      scriptPath: name => (name === 'install-launchd.sh' ? scriptPath : uninstallPath),
      runProcess: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeout: timeoutMs })
        return { code: 0, stdout: 'installed ok (secret-output-should-not-leak)', stderr: '' }
      },
    })

    const enabled = await harness.service.setWatchdog(true)
    expect(enabled.status).toBe(200)
    expect(enabled.body).toMatchObject({ ok: true, enabled: true })
    const scriptCalls = calls.filter(call => call.file === 'sh')
    expect(scriptCalls).toHaveLength(1)
    expect(scriptCalls[0]!.args).toEqual([scriptPath, '--state-dir', harness.stateDir])
    expect(scriptCalls[0]!.timeout).toBe(30_000)
    expect(calls.some(call => call.file === 'launchctl')).toBe(true)
    expect(JSON.stringify(enabled.body)).not.toContain('secret-output-should-not-leak')
    expect(
      harness.logger.lines.some(line => JSON.stringify(line.extra ?? {}).includes('secret-output-should-not-leak')),
    ).toBe(true)

    const disabled = await harness.service.setWatchdog(false)
    expect(disabled.status).toBe(200)
    expect(disabled.body).toMatchObject({ ok: true, enabled: false })
    const afterDisable = calls.filter(call => call.file === 'sh')
    expect(afterDisable[1]!.args).toEqual([uninstallPath, '--state-dir', harness.stateDir])
  })

  it('returns readable failures (script error, missing script) without leaking output', async () => {
    const scriptPath = join(tempStateDir(), 'install-launchd.sh')
    writeFileSync(scriptPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const failing = makeHarness({
      scriptPath: () => scriptPath,
      runProcess: async () => ({ code: 1, stdout: 'rm -rf /Users/secret/path', stderr: 'permission denied' }),
    })
    const failure = await failing.service.setWatchdog(true)
    expect(failure.status).toBe(500)
    expect(failure.body).toMatchObject({ ok: false, enabled: true, error: 'watchdog_script_failed' })
    expect(JSON.stringify(failure.body)).not.toContain('rm -rf')
    expect(JSON.stringify(failure.body)).not.toContain('/Users/secret')

    const missing = makeHarness({ scriptPath: () => undefined })
    const unavailable = await missing.service.setWatchdog(true)
    expect(unavailable.status).toBe(501)
    expect(unavailable.body.error).toBe('watchdog_script_unavailable')
    expect(String(unavailable.body.description)).toContain('install-launchd.sh --state-dir')
  })

  it('serves GET/POST setup/watchdog from the runtime route and backfills state', async () => {
    const stateDir = tempStateDir()
    const plistPath = join(stateDir, 'watchdog.plist')
    const scriptPath = join(stateDir, 'install-launchd.sh')
    const uninstallPath = join(stateDir, 'uninstall.sh')
    const watchdogPath = join(stateDir, 'watchdog.mjs')
    writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(uninstallPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(watchdogPath, '// watchdog\n', { mode: 0o644 })
    const calls: string[][] = []
    const host = createFakeHost()
    const runtime = new Runtime(
      host.ctx as unknown as Context,
      {
        stateDir,
        sources: { telegram: { enabled: false }, github: { enabled: false } },
        policy: { mode: 'observe' },
        passIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        watchdog: { intervalMs: 60_000 },
      },
      {
        store: createMemoryStore(),
        sources: [],
        skipLock: true,
        scriptPath: name =>
          name === 'install-launchd.sh' ? scriptPath : name === 'watchdog.mjs' ? watchdogPath : uninstallPath,
        watchdogPlistPath: () => plistPath,
        runProcess: async (file, args) => {
          calls.push([file, ...args])
          if (file === 'launchctl') return { code: existsSync(plistPath) ? 0 : 1, stdout: '', stderr: '' }
          writeFileSync(plistPath, '<plist/>', { mode: 0o600 })
          return { code: 0, stdout: 'ok', stderr: '' }
        },
      },
    )
    try {
      await runtime.ready
      const route = host.webServer.route('/superagent/api/setup/watchdog')
      expect(route).toBeDefined()

      const forbidden = new FakeResponse()
      await route!.handler(new FakeRequest({ method: 'GET' }), forbidden)
      expect(forbidden.statusCode).toBe(403)

      const idle = new FakeResponse()
      await route!.handler(new FakeRequest({ method: 'GET', headers: { [API_HEADER]: '1' } }), idle)
      expect(idle.statusCode).toBe(200)
      expect(idle.json<{ installed: boolean; running: boolean; manualCommands: unknown }>()).toMatchObject({
        installed: false,
        running: false,
        manualCommands: {
          dryRun: `node '${watchdogPath}' --state-dir '${stateDir}' --dry-run`,
          install: `sh '${scriptPath}' --state-dir '${stateDir}'`,
          uninstall: `sh '${uninstallPath}' --state-dir '${stateDir}'`,
        },
      })

      const invalid = new FakeResponse()
      const invalidReq = new FakeRequest({ method: 'POST', headers: { [API_HEADER]: '1' } })
      const invalidPromise = route!.handler(invalidReq, invalid)
      invalidReq.feed('{"enabled":"yes"}')
      await invalidPromise
      expect(invalid.statusCode).toBe(400)

      const enable = new FakeResponse()
      const enableReq = new FakeRequest({ method: 'POST', headers: { [API_HEADER]: '1' } })
      const enablePromise = route!.handler(enableReq, enable)
      enableReq.feed('{"enabled":true}')
      await enablePromise
      expect(enable.statusCode).toBe(200)
      expect(enable.json()).toMatchObject({ ok: true, enabled: true, installed: true, running: true })
      expect(calls.some(call => call[0] === 'sh' && call[1] === scriptPath && call[2] === '--state-dir')).toBe(true)

      const disable = new FakeResponse()
      const disableReq = new FakeRequest({ method: 'POST', headers: { [API_HEADER]: '1' } })
      const disablePromise = route!.handler(disableReq, disable)
      disableReq.feed('{"enabled":false}')
      await disablePromise
      expect(disable.json()).toMatchObject({ ok: true, enabled: false })

      const stateRoute = host.webServer.route('/superagent/api/setup/state')!
      const stateResponse = new FakeResponse()
      await stateRoute.handler(new FakeRequest({ method: 'GET', headers: { [API_HEADER]: '1' } }), stateResponse)
      const state = stateResponse.json<{ watchdog: { installed: boolean; stateDir: string; label: string } }>()
      expect(state.watchdog).toMatchObject({
        installed: true,
        stateDir,
        label: 'com.sfky.superagent.watchdog',
      })
    } finally {
      await runtime.stop()
    }
  })
})

describe('stale state-directory lock recovery (task-49)', () => {
  const lockPathFor = (stateDir: string): string => `${stateDir}.lock`
  const pidPathFor = (stateDir: string): string => join(stateDir, 'runtime.pid')

  function createLock(stateDir: string, pid?: number): void {
    mkdirSync(stateDir, { recursive: true })
    mkdirSync(lockPathFor(stateDir), { recursive: true })
    if (pid !== undefined) {
      writeFileSync(pidPathFor(stateDir), JSON.stringify({ pid, at: new Date().toISOString() }), { mode: 0o600 })
    }
  }

  async function startRuntimeWithLock(stateDir: string): Promise<Runtime> {
    const host = createFakeHost()
    const runtime = new Runtime(
      host.ctx as unknown as Context,
      {
        stateDir,
        sources: { telegram: { enabled: false }, github: { enabled: false } },
        policy: { mode: 'observe' },
        passIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        watchdog: { intervalMs: 60_000 },
      },
      { store: createMemoryStore(), sources: [], skipLock: false },
    )
    await runtime.ready
    return runtime
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(lockPathFor(dir), { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    }
  })

  it('removes a lock whose recorded PID is dead', async () => {
    const stateDir = tempStateDir()
    createLock(stateDir, 999_999)
    const runtime = await startRuntimeWithLock(stateDir)
    try {
      expect(runtime.status).toBe('ready')
      const record = JSON.parse(readFileSync(pidPathFor(stateDir), 'utf8')) as { pid: number }
      expect(record.pid).toBe(process.pid)
    } finally {
      await runtime.stop()
    }
    expect(existsSync(lockPathFor(stateDir))).toBe(false)
  })

  it('removes a lock left by a previous in-process runtime (same PID)', async () => {
    const stateDir = tempStateDir()
    createLock(stateDir, process.pid)
    const runtime = await startRuntimeWithLock(stateDir)
    try {
      expect(runtime.status).toBe('ready')
    } finally {
      await runtime.stop()
    }
  })

  it('removes an old lock that has no PID record (30 s threshold)', async () => {
    const stateDir = tempStateDir()
    createLock(stateDir)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPathFor(stateDir), old, old)
    const runtime = await startRuntimeWithLock(stateDir)
    try {
      expect(runtime.status).toBe('ready')
    } finally {
      await runtime.stop()
    }
  })

  it('fails fast and clearly for a recent lock with no PID record', async () => {
    const stateDir = tempStateDir()
    createLock(stateDir)
    const runtime = await startRuntimeWithLock(stateDir)
    try {
      expect(runtime.status).toBe('degraded')
      expect(runtime.detail ?? '').toContain('unknown process')
    } finally {
      await runtime.stop()
    }
  })

  it('fails fast while a live foreign process owns the lock', async () => {
    const stateDir = tempStateDir()
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' })
    try {
      await new Promise(resolve => child.once('spawn', resolve))
      createLock(stateDir, child.pid!)
      const runtime = await startRuntimeWithLock(stateDir)
      try {
        expect(runtime.status).toBe('degraded')
        expect(runtime.detail ?? '').toContain('locked by a running SuperAgent process')
      } finally {
        await runtime.stop()
      }
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('releases the lock and PID file on stop, so a restart acquires it again', async () => {
    const stateDir = tempStateDir()
    const first = await startRuntimeWithLock(stateDir)
    expect(first.status).toBe('ready')
    expect(existsSync(pidPathFor(stateDir))).toBe(true)
    await first.stop()
    expect(existsSync(lockPathFor(stateDir))).toBe(false)

    const second = await startRuntimeWithLock(stateDir)
    try {
      expect(second.status).toBe('ready')
    } finally {
      await second.stop()
    }
  })
})

describe('personal (operator) PAT bootstrap (task-52)', () => {
  interface OperatorHarness {
    harness: Harness
    calls: Array<{ kind: string; args: unknown[] }>
    operatorFile: string
  }

  async function makeOperatorHarness(options: { failRepo?: string } = {}): Promise<OperatorHarness> {
    const calls: Array<{ kind: string; args: unknown[] }> = []
    const harness = makeHarness({
      loadGithubHelpers: async () => ({
        async validate(token: string) {
          if (token === 'bad') {
            throw Object.assign(new Error('GitHub token check failed: HTTP 401: Bad credentials'), {
              name: 'GithubTokenValidationError',
              status: 401,
            })
          }
          return { login: 'operator-user' }
        },
        async listRepositories() {
          return []
        },
        async addCollaborator(token, repo, login, permission) {
          calls.push({ kind: 'add', args: [token, repo, login, permission] })
          if (repo === options.failRepo) {
            throw Object.assign(new Error(`forbidden on ${repo}`), { status: 403 })
          }
          return { alreadyCollaborator: false }
        },
        async acceptForRepo(token, repo) {
          calls.push({ kind: 'accept', args: [token, repo] })
          return { status: 'accepted', invitationId: 11 }
        },
      }),
    })
    const github = harness.config.sources as { github: Record<string, unknown> }
    github.github.login = 'bot-user'
    github.github.repositories = ['octocat/one', 'octocat/two']
    mkdirSync(join(harness.stateDir, 'secrets'), { recursive: true, mode: 0o700 })
    writeFileSync(join(harness.stateDir, 'secrets', 'github-token'), 'ghp_bot_token', { mode: 0o600 })
    return {
      harness,
      calls,
      operatorFile: join(harness.stateDir, 'secrets', 'github-operator-token'),
    }
  }

  it('invites the bot as a push collaborator, accepts invitations and saves the PAT 0600', async () => {
    const { harness, calls, operatorFile } = await makeOperatorHarness()
    const result = await harness.service.saveOperatorToken({ token: 'op-secret-token' })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      ok: true,
      login: 'operator-user',
      operatorTokenFile: operatorFile,
      invited: [
        { repo: 'octocat/one', login: 'bot-user', status: 'invited' },
        { repo: 'octocat/two', login: 'bot-user', status: 'invited' },
      ],
      accepted: [
        { repo: 'octocat/one', status: 'accepted', invitationId: 11 },
        { repo: 'octocat/two', status: 'accepted', invitationId: 11 },
      ],
    })
    expect(calls.filter(call => call.kind === 'add')).toHaveLength(2)
    expect(calls[0]!.args).toEqual(['op-secret-token', 'octocat/one', 'bot-user', 'push'])
    expect(calls.filter(call => call.kind === 'accept')[0]!.args).toEqual(['ghp_bot_token', 'octocat/one'])
    expect(readFileSync(operatorFile, 'utf8').trim()).toBe('op-secret-token')
    expect(statSync(operatorFile).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(result.body)).not.toContain('op-secret-token')
    expect(JSON.stringify(result.body)).not.toContain('ghp_bot_token')

    expect(harness.service.persistOperatorTokenFile(operatorFile)).toBe(true)
    runScheduled(harness)
    await harness.service.waitForCommit()
    expect((harness.editor.calls[0]!.next.sources as Record<string, unknown>).github).toMatchObject({
      operatorTokenFile: operatorFile,
    })
  })

  it('keeps per-repository failures as warnings and still saves the token', async () => {
    const { harness } = await makeOperatorHarness({ failRepo: 'octocat/two' })
    const result = await harness.service.saveOperatorToken({ token: 'op-secret-token', repositories: ['octocat/one', 'octocat/two'] })
    expect(result.status).toBe(200)
    const warnings = result.body.warnings as string[]
    expect(warnings.some(line => line.includes('octocat/two'))).toBe(true)
    expect(result.body.invited).toEqual([{ repo: 'octocat/one', login: 'bot-user', status: 'invited' }])
    expect(result.body.accepted).toEqual([{ repo: 'octocat/one', status: 'accepted', invitationId: 11 }])
  })

  it('rejects an invalid operator token without writing a file', async () => {
    const { harness, operatorFile } = await makeOperatorHarness()
    const result = await harness.service.saveOperatorToken({ token: 'bad' })
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('invalid_token')
    expect(JSON.stringify(result.body)).not.toContain('bad')
    expect(existsSync(operatorFile)).toBe(false)
  })

  it('requires the bot login (or a saved bot token) before inviting', async () => {
    const { harness } = await makeOperatorHarness()
    const github = harness.config.sources as { github: Record<string, unknown> }
    delete github.github.login
    rmSync(join(harness.stateDir, 'secrets', 'github-token'), { force: true })
    const result = await harness.service.saveOperatorToken({ token: 'op-secret-token' })
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('bot_login_unknown')
  })

  it('exposes only the operator-token path/configured flag in setup state', async () => {
    const { harness, operatorFile } = await makeOperatorHarness()
    await harness.service.saveOperatorToken({ token: 'op-secret-token' })
    const github = harness.config.sources as { github: Record<string, unknown> }
    github.github.operatorTokenFile = operatorFile
    const state = (await harness.service.state()).body as {
      accounts: { github: { operatorTokenConfigured: boolean; operatorTokenFile?: string } }
    }
    expect(state.accounts.github.operatorTokenConfigured).toBe(true)
    expect(state.accounts.github.operatorTokenFile).toBe(operatorFile)
    expect(JSON.stringify(state)).not.toContain('op-secret-token')
  })
})

describe('operator PAT removal (task-52)', () => {
  it('removes the token file, clears the configured path and reports configured:false', async () => {
    const harness = makeHarness()
    const operatorFile = join(harness.stateDir, 'secrets', 'github-operator-token')
    mkdirSync(join(harness.stateDir, 'secrets'), { recursive: true, mode: 0o700 })
    writeFileSync(operatorFile, 'op-secret', { mode: 0o600 })
    const github = harness.config.sources as { github: Record<string, unknown> }
    github.github.operatorTokenFile = operatorFile

    const stateBefore = (await harness.service.state()).body as {
      accounts: { github: { operatorTokenConfigured: boolean } }
    }
    expect(stateBefore.accounts.github.operatorTokenConfigured).toBe(true)

    const result = await harness.service.saveOperatorToken({ remove: true })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, removed: true, operatorTokenConfigured: false })
    expect(existsSync(operatorFile)).toBe(false)

    github.github.operatorTokenFile = ''
    const stateAfter = (await harness.service.state()).body as {
      accounts: { github: { operatorTokenConfigured: boolean } }
    }
    expect(stateAfter.accounts.github.operatorTokenConfigured).toBe(false)

    runScheduled(harness)
    await harness.service.waitForCommit()
    expect((harness.editor.calls[0]!.next.sources as Record<string, unknown>).github).toMatchObject({
      operatorTokenFile: '',
    })
    expect(JSON.stringify(result.body)).not.toContain('op-secret')
  })

  it('is idempotent when the file is already missing', async () => {
    const harness = makeHarness()
    const result = await harness.service.saveOperatorToken({ remove: true })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, operatorTokenConfigured: false })
  })
})

describe('native bridge in setup state and config (task-65)', () => {
  function nativeAccount(state: Record<string, unknown>): Record<string, unknown> {
    const accounts = state.accounts as { native?: Record<string, unknown> }
    return accounts.native ?? {}
  }

  it('exposes accounts.native enabled/configured/port with sensible defaults', async () => {
    const harness = makeHarness()
    const state = (await harness.service.state()).body as Record<string, unknown>
    expect(accountsNative(state)).toEqual({ enabled: true, configured: false, port: 47_821 })
  })

  it('reflects the discovery port once native.json exists', async () => {
    const harness = makeHarness()
    writeFileSync(join(harness.stateDir, 'native.json'), JSON.stringify({ port: 50_001, version: '1.0.0' }), {
      mode: 0o600,
    })
    const state = (await harness.service.state()).body as Record<string, unknown>
    expect(accountsNative(state)).toMatchObject({ enabled: true, configured: true, port: 50_001 })
  })

  it('reflects sources.native.enabled and the configured port', async () => {
    const harness = makeHarness()
    const githubConfig = harness.config.sources as Record<string, Record<string, unknown>>
    githubConfig.native = { enabled: false, port: 49_999 }
    const state = (await harness.service.state()).body as Record<string, unknown>
    expect(accountsNative(state)).toMatchObject({ enabled: false, port: 49_999 })
  })

  it('accepts sources.native in PUT config and persists it through configEditor', async () => {
    const harness = makeHarness()
    const prepared = await harness.service.prepareConfig({
      config: { sources: { native: { enabled: false, port: 49_999 } } },
    })
    expect(prepared.result.status).toBe(200)
    expect(prepared.result.body).toEqual({ ok: true, restarting: true })
    expect((prepared.patch?.sources as Record<string, unknown>).native).toEqual({ enabled: false, port: 49_999 })

    harness.service.commitConfigSoon(prepared.patch!)
    runScheduled(harness)
    await harness.service.waitForCommit()
    expect((harness.editor.calls[0]!.next.sources as Record<string, unknown>).native).toEqual({
      enabled: false,
      port: 49_999,
    })

    // Re-enabling works the same way.
    const again = await harness.service.prepareConfig({ config: { sources: { native: { enabled: true } } } })
    expect(again.result.status).toBe(200)
    expect((again.patch?.sources as Record<string, unknown>).native).toEqual({ enabled: true })
  })

  it('rejects malformed native config patches', async () => {
    const harness = makeHarness()
    expect(
      (await harness.service.prepareConfig({ config: { sources: { native: { enabled: 'yes' } } } })).result.status,
    ).toBe(400)
    expect(
      (await harness.service.prepareConfig({ config: { sources: { native: { port: 70_000 } } } })).result.status,
    ).toBe(400)
    expect(
      (await harness.service.prepareConfig({ config: { sources: { native: { port: -1 } } } })).result.status,
    ).toBe(400)
  })

  it('starts/stops the native Source from the config and reports it in the Overview sources list', async () => {
    const stateDir = tempStateDir()
    const boot = async (enabled: boolean) => {
      const host = createFakeHost()
      const store = createMemoryStore()
      const runtime = new Runtime(
        host.ctx as unknown as Context,
        {
          stateDir,
          sources: {
            telegram: { enabled: false },
            github: { enabled: false },
            native: { enabled, port: 0 },
          },
          policy: { mode: 'observe' },
          passIntervalMs: 60_000,
          heartbeatIntervalMs: 60_000,
          watchdog: { intervalMs: 60_000 },
        },
        { store, skipLock: true },
      )
      await runtime.ready
      const deadline = Date.now() + 2_000
      while (
        Date.now() < deadline &&
        !runtime.buildState().sources.some(entry => entry.id === 'native' && entry.health === 'ready')
      ) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      return runtime
    }

    const enabledRuntime = await boot(true)
    try {
      const sources = enabledRuntime.buildState().sources
      expect(sources.find(entry => entry.id === 'native')).toMatchObject({ id: 'native', health: 'ready' })
    } finally {
      await enabledRuntime.stop()
    }

    const disabledRuntime = await boot(false)
    try {
      expect(disabledRuntime.buildState().sources.some(entry => entry.id === 'native')).toBe(false)
    } finally {
      await disabledRuntime.stop()
    }
  })
})

function accountsNative(state: Record<string, unknown>): Record<string, unknown> {
  const accounts = state.accounts as { native?: Record<string, unknown> } | undefined
  return accounts?.native ?? {}
}

describe('onboarding completion marker (task-65 follow-up)', () => {
  it('is false before the wizard persists anything', async () => {
    const harness = makeHarness()
    const state = (await harness.service.state()).body as { onboardingComplete: boolean }
    expect(state.onboardingComplete).toBe(false)
    expect(existsSync(join(harness.stateDir, 'setup-complete.json'))).toBe(false)
  })

  it('writes setup-complete.json 0600 only after a successful config persistence', async () => {
    const harness = makeHarness()
    const prepared = await harness.service.prepareConfig({ config: { sources: { native: { enabled: true } } } })
    expect(prepared.result.status).toBe(200)
    // Scheduling is not persistence: the marker must not exist yet.
    expect(existsSync(join(harness.stateDir, 'setup-complete.json'))).toBe(false)
    expect(((await harness.service.state()).body as { onboardingComplete: boolean }).onboardingComplete).toBe(false)

    harness.service.commitConfigSoon(prepared.patch!)
    runScheduled(harness)
    await harness.service.waitForCommit()

    const markerPath = join(harness.stateDir, 'setup-complete.json')
    expect(existsSync(markerPath)).toBe(true)
    expect(statSync(markerPath).mode & 0o777).toBe(0o600)
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>
    expect(typeof marker.completedAt).toBe('string')
    const state = (await harness.service.state()).body as { onboardingComplete: boolean }
    expect(state.onboardingComplete).toBe(true)
  })

  it('treats a legacy token-configured install as onboarded', async () => {
    const harness = makeHarness()
    mkdirSync(join(harness.stateDir, 'secrets'), { recursive: true, mode: 0o700 })
    writeFileSync(join(harness.stateDir, 'secrets', 'telegram-token'), '123:legacy', { mode: 0o600 })
    const state = (await harness.service.state()).body as { accounts: { telegram: { configured: boolean } }; onboardingComplete: boolean }
    expect(state.accounts.telegram.configured).toBe(true)
    expect(state.onboardingComplete).toBe(true)
    expect(existsSync(join(harness.stateDir, 'setup-complete.json'))).toBe(false)
  })

  it('does not mark onboarding complete when the config editor fails', async () => {
    const failingEditor = {
      calls: [] as Array<{ entry: unknown; next: Record<string, unknown> }>,
      async edit(): Promise<void> {
        throw new Error('editor rejected the change')
      },
    }
    const harness = makeHarness({}, { editor: failingEditor })
    const prepared = await harness.service.prepareConfig({ config: { policy: { mode: 'auto' } } })
    expect(prepared.result.status).toBe(200)
    harness.service.commitConfigSoon(prepared.patch!)
    runScheduled(harness)
    await harness.service.waitForCommit()
    expect(existsSync(join(harness.stateDir, 'setup-complete.json'))).toBe(false)
    expect(((await harness.service.state()).body as { onboardingComplete: boolean }).onboardingComplete).toBe(false)
  })
})
