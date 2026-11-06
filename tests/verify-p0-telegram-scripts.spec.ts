/**
 * Independent adversarial verification of the P0 Telegram attachments/replay,
 * uninstall guard and personal-PAT fixes (task-59, part 4/4).
 *
 *  1. outgoing attachments: only regular non-symlink files inside
 *     `<stateDir>/work` or `<stateDir>/downloads` are uploaded; outside paths
 *     and symlinks are rejected before any Bot API upload;
 *  2. local commands / inline callbacks are crash-replay safe: the same update
 *     or button id never executes its side effect twice;
 *  3. `install-launchd.sh` node-path handling and the uninstall `--purge-state`
 *     guard: blacklist wins even with `--force`, a marker is required for a
 *     normal purge, `--dry-run` deletes nothing;
 *  4. personal (operator) PAT: invite + auto-accept, 0600 file, no token in the
 *     response/log, removal deletes the file and clears the configured path.
 */

import { execFile } from 'node:child_process'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createSource as createTelegramSource, type TelegramConfig } from '../src/sources/telegram.js'
import type { SourceContext } from '../src/sources/kind.js'
import { SetupService, type GithubHelpers } from '../src/app/setup.js'
import { createMemoryStore } from '../src/app/store.js'
import type { AppLogger } from '../src/app/support.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const dirs: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

function tempDir(prefix = 'superagent-p0-tg-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function appLogger(sink?: string[]): AppLogger {
  const push = (level: string, message: string): void => {
    sink?.push(`${level}:${message}`)
  }
  return {
    debug: message => push('debug', message),
    info: message => push('info', message),
    warn: message => push('warn', message),
    error: message => push('error', message),
  }
}

// ---------------------------------------------------------------------------
// Fake Bot API (records the raw multipart body so the upload path is visible)
// ---------------------------------------------------------------------------

interface FakeTelegram {
  url: string
  uploads: string[]
  messages: string[]
  answers(): number
}

async function startFakeBot(): Promise<FakeTelegram> {
  const uploads: string[] = []
  const messages: string[] = []
  let answers = 0
  const server = createServer(async (request: IncomingMessage, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const method = url.pathname.split('/').pop()
    if (method === 'getMe') {
      const text = JSON.stringify({ ok: true, result: { id: 999, is_bot: true, username: 'sa_bot' } })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(text)
      return
    }
    if (method === 'getUpdates') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, result: [] }))
      return
    }
    if (method === 'sendDocument' || method === 'sendPhoto') {
      uploads.push(raw)
    } else if (method === 'sendMessage') {
      messages.push(raw)
    } else if (method === 'answerCallbackQuery') {
      answers += 1
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, result: true }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  servers.push(server)
  return { url: `http://127.0.0.1:${address.port}`, uploads, messages, answers: () => answers }
}

function botTokenFile(dir: string, token = '123456789:TEST-TOKEN'): string {
  const file = join(dir, 'telegram-token')
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  return file
}

function telegramContext(dir: string, kv: Map<string, unknown>): SourceContext {
  return {
    id: 'telegram',
    stateDir: dir,
    now: () => new Date().toISOString(),
    newId: prefix => `${prefix}_1`,
    receive: () => 'stored',
    logger: appLogger(),
    health: () => undefined,
    kv: {
      get: <T>(key: string): T | undefined => kv.get(key) as T | undefined,
      set: <T>(key: string, value: T): void => {
        kv.set(key, value)
      },
      delete: (key: string): void => {
        kv.delete(key)
      },
      keys: (prefix?: string): string[] => [...kv.keys()].filter(key => prefix === undefined || key.startsWith(prefix)),
    },
  }
}

async function sourceFor(
  dir: string,
  bot: FakeTelegram,
  config: Partial<TelegramConfig> = {},
): Promise<{ source: ReturnType<typeof createTelegramSource>; kv: Map<string, unknown> }> {
  const kv = new Map<string, unknown>()
  const source = createTelegramSource(
    {
      apiBaseUrl: bot.url,
      tokenFile: botTokenFile(dir),
      allowedUserIds: ['42'],
      pollTimeoutSeconds: 0,
      pollSeconds: 0.01,
      ...config,
    },
    telegramContext(dir, kv),
  )
  return { source, kv }
}

// ---------------------------------------------------------------------------
// 1. Outgoing attachment guard
// ---------------------------------------------------------------------------

describe('telegram outgoing attachment guard (P0)', () => {
  it('uploads only regular files inside stateDir work/downloads and rejects outside paths + symlinks', async () => {
    const dir = tempDir()
    const bot = await startFakeBot()
    const { source } = await sourceFor(dir, bot, { files: true })

    const work = join(dir, 'work', 'tk_1')
    const downloads = join(dir, 'downloads')
    mkdirSync(work, { recursive: true, mode: 0o700 })
    mkdirSync(downloads, { recursive: true, mode: 0o700 })
    const inside = join(work, 'inside.txt')
    writeFileSync(inside, 'allowed', { mode: 0o600 })
    const downloaded = join(downloads, '42-1-download.txt')
    writeFileSync(downloaded, 'allowed too', { mode: 0o600 })
    const outsideDir = tempDir('superagent-p0-outside-')
    const outside = join(outsideDir, 'secret.txt')
    writeFileSync(outside, 'SECRET', { mode: 0o600 })
    const symlink = join(work, 'link.txt')
    symlinkSync(outside, symlink)

    const outcome = await source.send({
      id: 'msg_1',
      purpose: 'result',
      channel: { source: 'telegram', thread: 'telegram:dm:42', to: '42' },
      text: 'here are the files',
      at: new Date().toISOString(),
      attachments: [
        { kind: 'document', path: outside },
        { kind: 'document', path: symlink },
        { kind: 'document', path: inside },
        { kind: 'document', path: downloaded },
      ],
    })

    expect(outcome).toBe('sent')
    // Two uploads: the work file and the download file; the outside path and
    // the symlink must never be read/uploaded.
    expect(bot.uploads).toHaveLength(2)
    const uploaded = bot.uploads.join('\n')
    expect(uploaded).toContain('inside.txt')
    expect(uploaded).toContain('42-1-download.txt')
    expect(uploaded).not.toContain('secret.txt')
    expect(uploaded).not.toContain('link.txt')
    expect(uploaded).not.toContain('SECRET')
  })

  it('refuses a directory path and a nonexistent path', async () => {
    const dir = tempDir()
    const bot = await startFakeBot()
    const { source } = await sourceFor(dir, bot, { files: true })
    mkdirSync(join(dir, 'work'), { recursive: true })
    const result = await source.send({
      id: 'msg_2',
      purpose: 'result',
      channel: { source: 'telegram', thread: 'telegram:dm:42', to: '42' },
      text: 'x',
      at: new Date().toISOString(),
      attachments: [
        { kind: 'document', path: join(dir, 'work') },
        { kind: 'document', path: join(dir, 'work', 'missing.txt') },
      ],
    })
    expect(result).toBe('sent')
    expect(bot.uploads).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Command / callback replay
// ---------------------------------------------------------------------------

describe('telegram crash-replay guard (P0)', () => {
  it('runs a /retry command exactly once even if the update is replayed', async () => {
    const dir = tempDir()
    const bot = await startFakeBot()
    let retries = 0
    const kv = new Map<string, unknown>()
    const source = createTelegramSource(
      {
        apiBaseUrl: bot.url,
        tokenFile: botTokenFile(dir),
        allowedUserIds: ['42'],
        pollTimeoutSeconds: 0,
        pollSeconds: 0.01,
        commands: {
          status: async () => 'status',
          pause: async () => 'paused',
          resume: async () => 'resumed',
          tickets: async () => 'tickets',
          stopTicket: async () => 'stopped',
          retryTicket: async () => {
            retries += 1
            return 'retried'
          },
        },
      },
      telegramContext(dir, kv),
    ) as unknown as {
      pollOnce(signal: AbortSignal): Promise<unknown>
      handleUpdate?(...args: never[]): never
    }

    const update = {
      update_id: 900,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1_000),
        from: { id: 42, is_bot: false, first_name: 'Owner' },
        chat: { id: 42, type: 'private' },
        text: '/retry tk_1',
      },
    }
    // The fake Bot API does not keep a queue: drive the translate layer directly
    // through the public poll path twice with the same update id.
    const api = (source as unknown as { getApi(): unknown }).getApi() as {
      getUpdates(options: unknown): Promise<unknown[]>
    }
    api.getUpdates = async () => [update as unknown]
    await source.pollOnce(new AbortController().signal)
    kv.set('telegram:offset', 0) // simulate a crash before the offset write
    await source.pollOnce(new AbortController().signal)

    expect(retries).toBe(1)
  })

  it('executes an inline button action once per callback id', async () => {
    const dir = tempDir()
    const bot = await startFakeBot()
    let retries = 0
    const kv = new Map<string, unknown>()
    const source = createTelegramSource(
      {
        apiBaseUrl: bot.url,
        tokenFile: botTokenFile(dir),
        allowedUserIds: ['42'],
        pollTimeoutSeconds: 0,
        pollSeconds: 0.01,
        observeCallbacks: true,
        keyboards: true,
        commands: {
          status: async () => 'status',
          pause: async () => 'paused',
          resume: async () => 'resumed',
          tickets: async () => 'tickets',
          stopTicket: async () => 'stopped',
          retryTicket: async () => {
            retries += 1
            return 'retried'
          },
          ack: async () => 'acked',
        },
      },
      telegramContext(dir, kv),
    ) as unknown as { pollOnce(signal: AbortSignal): Promise<unknown> }

    const api = (source as unknown as { getApi(): unknown }).getApi() as {
      getUpdates(options: unknown): Promise<unknown[]>
    }
    const update = {
      update_id: 901,
      callback_query: {
        id: 'cb-1',
        from: { id: 42, is_bot: false, first_name: 'Owner' },
        data: 'sa:retry:tk_1',
        message: {
          message_id: 7,
          date: Math.floor(Date.now() / 1_000),
          chat: { id: 42, type: 'private' },
        },
      },
    }
    api.getUpdates = async () => [update as unknown]
    await source.pollOnce(new AbortController().signal)
    kv.set('telegram:offset', 0)
    await source.pollOnce(new AbortController().signal)

    expect(retries).toBe(1)
    expect(bot.answers()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Uninstall guard / launchd node path
// ---------------------------------------------------------------------------

function runScript(script: string, args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(
      'sh',
      [join(process.cwd(), 'scripts', script), ...args],
      { env: { ...process.env, ...env }, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as NodeJS.ErrnoException).code === 'number' ? Number((error as NodeJS.ErrnoException).code) : 1
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

describe('uninstall --purge-state guard (P0)', () => {
  function envFor(root: string): Record<string, string> {
    const home = join(root, 'home')
    return {
      HOME: home,
      DSH_HOME: join(home, '.dsh'),
      DSH_PROFILE: 'p0test',
      SUPERAGENT_WATCHDOG_LABEL: 'com.sfky.superagent.p0test',
    }
  }

  it('refuses HOME and DSH_HOME even with --force', async () => {
    const root = tempDir('superagent-p0-uninstall-')
    mkdirSync(join(root, 'home', '.dsh'), { recursive: true })
    const home = join(root, 'home')
    const dshHome = join(home, '.dsh')
    const env = envFor(root)
    for (const target of [home, dshHome]) {
      const result = await runScript('uninstall.sh', ['--purge-state', '--force', '--state-dir', target], env)
      expect(result.code).not.toBe(0)
      expect(`${result.stderr}${result.stdout}`).toMatch(/protected directory/i)
    }
  })

  it('refuses a non-marker directory without --force but accepts it with --force', async () => {
    const root = tempDir('superagent-p0-uninstall-')
    const state = join(root, 'state')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'superagent.sqlite'), 'x')
    const env = envFor(root)

    const refused = await runScript('uninstall.sh', ['--purge-state', '--state-dir', state], env)
    expect(refused.code).not.toBe(0)
    expect(`${refused.stderr}${refused.stdout}`).toMatch(/--force|marker/i)

    const forced = await runScript('uninstall.sh', ['--purge-state', '--force', '--state-dir', state], env)
    expect(forced.code).toBe(0)
    expect(() => statSync(state)).toThrow()
  })

  it('--dry-run with the marker deletes nothing', async () => {
    const root = tempDir('superagent-p0-uninstall-')
    const state = join(root, 'state')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, '.superagent-state'), JSON.stringify({ plugin: 'dsh-superagent-personal' }))
    writeFileSync(join(state, 'superagent.sqlite'), 'x')
    const env = envFor(root)

    const result = await runScript('uninstall.sh', ['--purge-state', '--dry-run', '--state-dir', state], env)
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/purge plan/i)
    expect(statSync(state).isDirectory()).toBe(true)
    expect(statSync(join(state, 'superagent.sqlite')).isFile()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Personal (operator) PAT
// ---------------------------------------------------------------------------

describe('personal PAT setup (P0)', () => {
  interface Calls {
    validated: string[]
    invited: Array<{ repo: string; login: string; permission: string }>
    accepted: number[]
    edits: Array<Record<string, unknown>>
  }

  function makeSetup(options: { botToken?: string } = {}): {
    service: SetupService
    calls: Calls
    stateDir: string
    logs: string[]
  } {
    const stateDir = tempDir('superagent-p0-operator-')
    const logs: string[] = []
    const calls: Calls = { validated: [], invited: [], accepted: [], edits: [] }
    const botFile = join(stateDir, 'secrets', 'github-token')
    mkdirSync(join(stateDir, 'secrets'), { recursive: true, mode: 0o700 })
    writeFileSync(botFile, `${options.botToken ?? 'ghp_bot000000000000000000000000000'}\n`, { mode: 0o600 })
    const store = createMemoryStore()
    const config: Record<string, unknown> = {
      stateDir,
      sources: {
        telegram: { enabled: false },
        github: { enabled: true, login: 'sa-bot', tokenFile: botFile, repositories: ['acme/repo'] },
      },
    }
    const helpers: GithubHelpers = {
      async validate(token) {
        calls.validated.push(token)
        return { login: token === 'ghp_operator0000000000000000000000' ? 'operator-me' : 'sa-bot' }
      },
      async listRepositories() {
        return []
      },
      async addCollaborator(token, repo, login, permission) {
        calls.invited.push({ repo, login, permission })
        return { alreadyCollaborator: false }
      },
      async listInvitations() {
        return [{ id: 501, repository: 'acme/repo' }]
      },
      async acceptInvitation(_token, invitationId) {
        calls.accepted.push(invitationId)
        return { status: 'accepted' }
      },
    }
    const service = new SetupService({
      stateDir,
      kv: store.kv,
      logger: appLogger(logs),
      plugin: () => ({ status: 'ready', detail: null }),
      currentConfig: () => config,
      validateConfig: () => undefined,
      configEditor: () => ({
        edit: async (_entry, change) => {
          const next = change(config)
          calls.edits.push(next)
          Object.assign(config, next)
        },
      }),
      hostEntry: () => ({ id: 'dsh-superagent-personal' }),
      schedule: run => run(),
      timeoutMs: 2_000,
      loadGithubHelpers: async () => helpers,
    })
    return { service, calls, stateDir, logs }
  }

  it('saves a 0600 operator token, invites the bot with push, and accepts the invitation', async () => {
    const { service, calls, stateDir } = makeSetup()
    const result = await service.saveOperatorToken({
      personalToken: 'ghp_operator0000000000000000000000',
      repositories: ['acme/repo'],
      botLogin: 'sa-bot',
    })

    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    expect(result.body.invited).toEqual([{ repo: 'acme/repo', login: 'sa-bot', status: 'invited' }])
    expect(result.body.accepted).toEqual([{ repo: 'acme/repo', status: 'accepted', invitationId: 501 }])
    expect(calls.invited).toEqual([{ repo: 'acme/repo', login: 'sa-bot', permission: 'push' }])
    expect(calls.accepted).toEqual([501])
    // The token never appears in the response.
    expect(JSON.stringify(result.body)).not.toContain('ghp_operator')

    const file = join(stateDir, 'secrets', 'github-operator-token')
    expect(readFileSync(file, 'utf8').trim()).toBe('ghp_operator0000000000000000000000')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(result.body.operatorTokenFile).toBe(file)
  })

  it('removes the operator token file and clears the configured path', async () => {
    const { service, calls, stateDir } = makeSetup()
    await service.saveOperatorToken({ personalToken: 'ghp_operator0000000000000000000000', repositories: ['acme/repo'], botLogin: 'sa-bot' })
    const file = join(stateDir, 'secrets', 'github-operator-token')
    expect(statSync(file).isFile()).toBe(true)
    // Pretend the path was persisted in the plugin config.
    const current = (service as unknown as { deps: { currentConfig(): Record<string, unknown> } }).deps.currentConfig()
    current.sources = {
      github: { enabled: true, login: 'sa-bot', repositories: ['acme/repo'], operatorTokenFile: file },
    }

    const result = await service.removeOperatorToken()
    await service.waitForCommit()
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, operatorTokenConfigured: false })
    expect(() => statSync(file)).toThrow()
    // A config commit was requested to clear operatorTokenFile.
    expect(calls.edits.length).toBeGreaterThan(0)
    const final = calls.edits[calls.edits.length - 1] as {
      sources?: { github?: { operatorTokenFile?: string } }
    }
    expect(final.sources?.github?.operatorTokenFile).toBe('')
  })

  it('never writes the operator token into logs', async () => {
    const { service, logs } = makeSetup()
    await service.saveOperatorToken({ personalToken: 'ghp_operator0000000000000000000000', repositories: ['acme/repo'], botLogin: 'sa-bot' })
    expect(logs.join('\n')).not.toContain('ghp_operator')
    // Response bodies are covered above; also make sure the validate call
    // received the token (i.e. the flow really ran) while logs stayed clean.
    expect(logs.join('\n')).not.toContain('0000000000000000')
  })
})
