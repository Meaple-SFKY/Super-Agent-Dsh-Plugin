/**
 * Independent adversarial verification of the P0 GitHub fixes
 * (task-59, part 3/4).
 *
 *  1. repository invitations: `off` never lists, `allowlist` accepts only
 *     trusted inviters/owners (default), `all` accepts; case-insensitive;
 *     untrusted invitations are skipped, not crashed on.
 *  2. worker `superagent_github`:
 *     - `create_repository` on an EXISTING repository sends no collaborator
 *       invitation, even when the model passes `collaborators`;
 *     - writes outside `sources.github.repositories` are refused before any
 *       API call; wildcard mode trusts only token/operator owners;
 *     - with an operator PAT the new-repository flow invites the operator and
 *       accepts the operator's invitation for the bot.
 *
 * A compact fake GitHub server is implemented here rather than reusing the
 * implementation's fixture, so the assertions are independent.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

import { createSource as createGithubSource } from '../src/sources/github.js'
import type { SourceContext } from '../src/sources/kind.js'
import { registerWorkerTools } from '../src/tools/worker.js'
import type { ToolDeps } from '../src/tools/shared.js'
import { Sessions } from '../src/app/sessions.js'
import { makeHarness, makePolicy } from './core-fixtures.js'
import type { AppLogger } from '../src/app/support.js'
import { createFakeHost } from './runtime-host.js'

const appLogger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

// ---------------------------------------------------------------------------
// Fake GitHub server
// ---------------------------------------------------------------------------

interface Invitation {
  id: number
  repository: { full_name: string; owner: { login: string } }
  inviter: { login: string }
}

interface FakeBehaviour {
  userLogin?: string
  /** token → login (defaults to userLogin for every token). */
  tokenLogins?: Record<string, string>
  invitations?: Invitation[]
  /** POST /user/repos answer: created (201) or exists (422). */
  createRepository?: 'created' | 'exists'
  repoFullName?: string
}

interface Recorded {
  method: string
  path: string
  authorization: string
  body: string
}

interface FakeGithub {
  url: string
  requests: Recorded[]
  invitations: Invitation[]
}

const servers: Server[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

function tempDir(prefix = 'superagent-p0-gh-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function startFakeGithub(behaviour: FakeBehaviour = {}): Promise<FakeGithub> {
  const requests: Recorded[] = []
  const invitations = behaviour.invitations ?? []
  const login = behaviour.userLogin ?? 'sa-bot'
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const body = await readBody(request)
    const authorization = String(request.headers.authorization ?? '')
    requests.push({ method: request.method ?? 'GET', path: url.pathname, authorization, body })
    const json = (status: number, value: unknown): void => {
      const text = JSON.stringify(value)
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      response.end(text)
    }
    const token = authorization.replace(/^Bearer\s+/i, '')
    const tokenLogin = behaviour.tokenLogins?.[token] ?? login
    const path = url.pathname

    if (request.method === 'GET' && path === '/user') return json(200, { login: tokenLogin, id: 1, type: 'User' })
    if (request.method === 'GET' && path === '/user/repository_invitations') return json(200, invitations)
    if (request.method === 'PATCH' && path.startsWith('/user/repository_invitations/')) return json(204, {})
    if (request.method === 'GET' && path === '/user/repos') return json(200, [])
    if (request.method === 'POST' && path === '/user/repos') {
      const name = String((JSON.parse(body) as { name?: string }).name ?? 'repo')
      if (behaviour.createRepository === 'exists') {
        return json(422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] })
      }
      return json(201, {
        full_name: `${tokenLogin}/${name}`,
        name,
        private: true,
        html_url: `https://github.com/${tokenLogin}/${name}`,
        ssh_url: `git@github.com:${tokenLogin}/${name}.git`,
        clone_url: `https://github.com/${tokenLogin}/${name}.git`,
        default_branch: 'main',
      })
    }
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path)
    if (request.method === 'GET' && repoMatch) {
      const full = `${repoMatch[1]}/${repoMatch[2]}`
      return json(200, {
        full_name: full,
        name: repoMatch[2],
        owner: { login: repoMatch[1] },
        default_branch: 'main',
        html_url: `https://github.com/${full}`,
        ssh_url: `git@github.com:${full}.git`,
        clone_url: `https://github.com/${full}.git`,
      })
    }
    if (request.method === 'PUT' && /^\/repos\/[^/]+\/[^/]+\/collaborators\/[^/]+$/.test(path)) return json(204, {})
    // Repository streams for the Source's poll: everything is empty.
    if (request.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/(issues|pulls|issues\/comments|pulls\/comments)$/.test(path)) {
      return json(200, [])
    }
    if (request.method === 'GET' && path === '/rate_limit') {
      return json(200, { resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } } })
    }
    return json(404, { message: 'Not Found' })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  servers.push(server)
  return { url: `http://127.0.0.1:${address.port}`, requests, invitations }
}

function tokenFile(dir: string, name: string, token: string): string {
  mkdirSync(join(dir, 'secrets'), { recursive: true, mode: 0o700 })
  const file = join(dir, 'secrets', name)
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  return file
}

function sourceContext(stateDir: string, kv: Map<string, unknown>): SourceContext {
  return {
    id: 'github',
    stateDir,
    now: () => new Date().toISOString(),
    newId: prefix => `${prefix}_1`,
    receive: () => 'stored',
    logger: appLogger,
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

// ---------------------------------------------------------------------------
// 1. Invitation acceptance policy
// ---------------------------------------------------------------------------

describe('GitHub invitation allowlist (P0)', () => {
  function countRequests(fake: FakeGithub, method: string, fragment: string): number {
    return fake.requests.filter(entry => entry.method === method && entry.path.includes(fragment)).length
  }

  async function pollWith(behaviour: FakeBehaviour, config: { acceptInvitations?: 'off' | 'allowlist' | 'all'; allowedLogins?: string[]; collaborators?: string[] }) {
    const fake = await startFakeGithub(behaviour)
    const dir = tempDir()
    const file = tokenFile(dir, 'github-token', 'ghp_bot0000000000000000000000000000')
    const source = createGithubSource(
      {
        apiBaseUrl: fake.url,
        tokenFile: file,
        login: 'sa-bot',
        repositories: ['acme/repo'],
        allowedLogins: config.allowedLogins ?? [],
        collaborators: config.collaborators ?? [],
        ...(config.acceptInvitations ? { acceptInvitations: config.acceptInvitations } : {}),
        pollSeconds: 60,
        adaptivePolling: false,
        notifications: 'off',
        observeCi: false,
      },
      sourceContext(dir, new Map<string, unknown>()),
    )
    await (source as unknown as { pollOnce(signal: AbortSignal): Promise<unknown> }).pollOnce(
      new AbortController().signal,
    )
    return fake
  }

  const untrusted: Invitation = {
    id: 77,
    repository: { full_name: 'evil/repo', owner: { login: 'evil' } },
    inviter: { login: 'mallory' },
  }
  const trustedInviter: Invitation = {
    id: 78,
    repository: { full_name: 'acme/repo', owner: { login: 'acme' } },
    inviter: { login: 'Alice' },
  }

  it('default (allowlist) accepts a trusted inviter, case-insensitively, and skips untrusted', async () => {
    const fake = await pollWith({ invitations: [untrusted, trustedInviter] }, { allowedLogins: ['alice'] })
    const accepted = fake.requests.filter(entry => entry.method === 'PATCH' && entry.path.includes('/repository_invitations/'))
    expect(accepted.map(entry => entry.path.split('/').pop())).toEqual(['78'])
    expect(fake.requests.some(entry => entry.method === 'PATCH' && entry.path.endsWith('/77'))).toBe(false)
  })

  it('treats a configured collaborator/owner as trusted', async () => {
    const ownerInvite: Invitation = {
      id: 79,
      repository: { full_name: 'acme/repo', owner: { login: 'acme' } },
      inviter: { login: 'random-person' },
    }
    const fake = await pollWith({ invitations: [ownerInvite] }, { collaborators: ['acme'] })
    expect(fake.requests.some(entry => entry.method === 'PATCH' && entry.path.endsWith('/79'))).toBe(true)
  })

  it('mode off never even lists invitations', async () => {
    const fake = await pollWith({ invitations: [untrusted] }, { acceptInvitations: 'off' })
    expect(countRequests(fake, 'GET', '/user/repository_invitations')).toBe(0)
    expect(fake.requests.some(entry => entry.method === 'PATCH')).toBe(false)
  })

  it('mode all accepts an untrusted invitation (explicit opt-in)', async () => {
    const fake = await pollWith({ invitations: [untrusted] }, { acceptInvitations: 'all' })
    expect(fake.requests.some(entry => entry.method === 'PATCH' && entry.path.endsWith('/77'))).toBe(true)
  })

  it('an allowlist skip is stable across repeated polls (no crash, no accept)', async () => {
    const fake = await startFakeGithub({ invitations: [untrusted] })
    const dir = tempDir()
    const file = tokenFile(dir, 'github-token', 'ghp_bot0000000000000000000000000000')
    const kv = new Map<string, unknown>()
    const source = createGithubSource(
      { apiBaseUrl: fake.url, tokenFile: file, login: 'sa-bot', repositories: ['acme/repo'], adaptivePolling: false, notifications: 'off' },
      sourceContext(dir, kv),
    )
    const pollable = source as unknown as { pollOnce(signal: AbortSignal): Promise<unknown> }
    await pollable.pollOnce(new AbortController().signal)
    // Force another invitation scan (discovery refresh path) and poll again.
    const mutable = source as unknown as { invitationsChecked: boolean }
    mutable.invitationsChecked = false
    await pollable.pollOnce(new AbortController().signal)
    expect(fake.requests.some(entry => entry.method === 'PATCH')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Worker GitHub tool
// ---------------------------------------------------------------------------

interface ToolHarness {
  host: ReturnType<typeof createFakeHost>
  agent: Agent
  deps: ToolDeps
  store: ReturnType<typeof makeHarness>['store']
}

async function makeToolHarness(options: {
  github: Parameters<typeof makePolicy>[0] extends never ? never : { apiBaseUrl: string; token?: string; tokenFile?: string; operatorTokenFile?: string; login?: string; collaborators?: string[] }
  repositories?: string[]
  ticketId?: string
}): Promise<ToolHarness> {
  const harness = makeHarness()
  const policy = makePolicy({ sources: { ...makePolicy().sources, github: { allowed: [{ id: 'u1' }], bots: [], repositories: options.repositories ?? ['owner/repo'] } } })
  harness.policy.set(policy)
  const host = createFakeHost()
  const sessions = new Sessions({
    agents: host.agents,
    presets: host.presets,
    persistence: host.persistence,
    logger: appLogger,
    kv: harness.store.kv,
    maxWorkers: 4,
  })
  const ticketId = options.ticketId ?? 'tk_tool_1'
  const agent = await sessions.ensureWorker(ticketId, '/tmp')
  sessions.bindAssignment(ticketId, (agent as unknown as { session: { id: never } }).session.id, 'as_1')
  const deps: ToolDeps = {
    engine: harness.engine,
    store: harness.store,
    sessions,
    logger: appLogger,
    github: {
      ...(options.github.token ? { token: options.github.token } : {}),
      apiBaseUrl: options.github.apiBaseUrl,
      ...(options.github.login ? { login: options.github.login } : {}),
      ...(options.github.collaborators ? { collaborators: options.github.collaborators } : {}),
      ...(options.github.operatorTokenFile ? { operatorTokenFile: options.github.operatorTokenFile } : {}),
    },
  }
  registerWorkerTools(agent.ctx as unknown as Context, deps)
  const worker = host.agents.liveAgent(String((agent as unknown as { id: string }).id))!
  return { host, agent: worker as unknown as Agent, deps, store: harness.store }
}

async function execute(harness: ToolHarness, args: Record<string, unknown>) {
  return (await harness.host.executeTool(harness.agent as unknown as never, 'superagent_github', args)).value as Record<string, unknown>
}

function collaboratorPuts(fake: FakeGithub): Recorded[] {
  return fake.requests.filter(entry => entry.method === 'PUT' && entry.path.includes('/collaborators/'))
}

describe('worker superagent_github (P0)', () => {
  it('does not invite anyone when create_repository hits an EXISTING repository', async () => {
    const fake = await startFakeGithub({ createRepository: 'exists' })
    const harness = await makeToolHarness({
      github: { apiBaseUrl: fake.url, token: 'ghp_tool00000000000000000000000000', collaborators: ['alice'], login: 'sa-bot' },
    })
    const result = await execute(harness, {
      action: 'create_repository',
      name: 'existing-repo',
      collaborators: ['attacker'],
    })
    expect(result.ok).toBe(true)
    expect(result.created).toBe(false)
    expect(collaboratorPuts(fake)).toHaveLength(0)
    expect(fake.requests.some(entry => entry.method === 'PUT')).toBe(false)
  })

  it('invites only configured collaborators for a NEW repository (model-supplied list ignored)', async () => {
    const fake = await startFakeGithub({ createRepository: 'created' })
    const harness = await makeToolHarness({
      github: { apiBaseUrl: fake.url, token: 'ghp_tool00000000000000000000000000', collaborators: ['alice'], login: 'sa-bot' },
    })
    const result = await execute(harness, {
      action: 'create_repository',
      name: 'brand-new',
      collaborators: ['attacker'], // no longer in the schema; must be ignored even if sent
    })
    expect(result.ok).toBe(true)
    expect(result.created).toBe(true)
    const logins = collaboratorPuts(fake).map(entry => entry.path.split('/collaborators/')[1])
    expect(logins).toEqual(['alice'])
    expect(logins).not.toContain('attacker')
  })

  it('rejects writes to a repository outside the configured allowlist before any API call', async () => {
    const fake = await startFakeGithub({ createRepository: 'created' })
    const harness = await makeToolHarness({
      github: { apiBaseUrl: fake.url, token: 'ghp_tool00000000000000000000000000', login: 'sa-bot' },
      repositories: ['owner/repo'],
    })
    const result = await execute(harness, { action: 'comment', repo: 'someone/else', number: 1, body: 'hi' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('repo_not_allowed')
    // No comment write was attempted for the denied repository.
    expect(fake.requests.some(entry => entry.method === 'POST' && entry.path.includes('/issues/'))).toBe(false)
  })

  it('wildcard mode trusts the token owner but not a random owner', async () => {
    const fake = await startFakeGithub({ createRepository: 'created', userLogin: 'sa-bot' })
    const harness = await makeToolHarness({
      github: { apiBaseUrl: fake.url, token: 'ghp_tool00000000000000000000000000', login: 'sa-bot' },
      repositories: ['*'],
    })
    const own = await execute(harness, { action: 'comment', repo: 'sa-bot/project', number: 1, body: 'note' })
    // Allowed by the allowlist check; the fake has no comment endpoint so the
    // error is an API error, never repo_not_allowed.
    expect(own.error).not.toBe('repo_not_allowed')
    const foreign = await execute(harness, { action: 'comment', repo: 'random-owner/project', number: 1, body: 'note' })
    expect(foreign.error).toBe('repo_not_allowed')
  })

  it('with an operator PAT, a new repository invites the operator and accepts their invitation', async () => {
    const fake = await startFakeGithub({
      createRepository: 'created',
      tokenLogins: {
        ghp_tool00000000000000000000000000: 'sa-bot',
        ghp_operator0000000000000000000000: 'operator-me',
      },
      invitations: [
        {
          id: 501,
          repository: { full_name: 'sa-bot/operator-repo', owner: { login: 'sa-bot' } },
          inviter: { login: 'sa-bot' },
        },
      ],
    })
    const dir = tempDir()
    const operatorFile = tokenFile(dir, 'github-operator-token', 'ghp_operator0000000000000000000000')
    const harness = await makeToolHarness({
      github: {
        apiBaseUrl: fake.url,
        token: 'ghp_tool00000000000000000000000000',
        login: 'sa-bot',
        operatorTokenFile: operatorFile,
      },
    })
    const result = await execute(harness, { action: 'create_repository', name: 'operator-repo' })
    expect(result.ok).toBe(true)
    expect(result.created).toBe(true)
    expect(collaboratorPuts(fake).map(entry => entry.path.split('/collaborators/')[1])).toEqual(['operator-me'])
    const accepted = fake.requests.filter(entry => entry.method === 'PATCH' && entry.path.includes('/repository_invitations/'))
    expect(accepted.map(entry => entry.path.split('/').pop())).toEqual(['501'])
    expect(result.operator).toMatchObject({ status: 'accepted' })
    // The operator token never appears in the tool result.
    expect(JSON.stringify(result)).not.toContain('ghp_operator')
  })
})
