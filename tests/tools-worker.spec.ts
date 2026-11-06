/**
 * Worker GitHub tool (`superagent_github`) tests against a fake GitHub server.
 *
 * Covers: PR creation with marker, idempotent return of an existing PR,
 * duplicate-422 recovery, comment idempotency, checks/workflows tolerance,
 * token resolution (literal/env/secret file), structured failures, token never
 * leaking into results or logs, and the tool being worker-only.
 */

import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { registerWorkerTools } from '../src/tools/worker.js'
import type { ToolDeps } from '../src/tools/shared.js'
import { Sessions, type HostAgentRegistry } from '../src/app/sessions.js'
import type { Ticket, Trigger } from '../src/core/model.js'
import type { Context } from '@deepseek-ai/cordis'
import { makeHarness, makeTrigger } from './core-fixtures.js'
import { createFakeHost, textOf } from './runtime-host.js'

const dirs: string[] = []
const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `superagent-${prefix}-`))
  dirs.push(dir)
  return dir
}

// ---------------------------------------------------------------------------
// Fake GitHub REST server
// ---------------------------------------------------------------------------

interface FakePullInput {
  number: number
  head: string
  base: string
  state?: 'open' | 'closed'
  title?: string
  body?: string
  merged?: boolean
}

interface FakeCommentInput {
  id: number
  body: string
}

interface FakeGithubBehaviour {
  pulls?: FakePullInput[]
  /** Called for each list request; returns the pulls to serve (default: `pulls`). */
  listPulls?: (call: number) => FakePullInput[]
  createPullResponse?: (body: Record<string, unknown>) => { status: number; body: unknown }
  comments?: FakeCommentInput[]
  defaultBranch?: string
  /** Login returned by GET /user (default octocat). */
  userLogin?: string
  createRepositoryResponse?: (body: Record<string, unknown>) => { status: number; body: unknown }
  checkRuns?: { status: number; body: unknown }
  workflowRuns?: { status: number; body: unknown }
}

interface RecordedRequest {
  method: string
  path: string
  authorization: string
  body?: string
}

interface FakeGithub {
  baseUrl: string
  requests: RecordedRequest[]
  behaviour: FakeGithubBehaviour
}

function pullJson(repo: string, pull: FakePullInput): Record<string, unknown> {
  return {
    number: pull.number,
    title: pull.title ?? 'Fix the thing',
    body: pull.body ?? null,
    state: pull.state ?? 'open',
    merged: pull.merged === true,
    merged_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    user: { login: 'octocat' },
    html_url: `https://github.com/${repo}/pull/${pull.number}`,
    head: { ref: pull.head, sha: 'abc1234567890abc1234567890abc1234567890' },
    base: { ref: pull.base, sha: 'def4567890abc1234567890abc1234567890abcd' },
    draft: false,
  }
}

async function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function startFakeGithub(behaviour: FakeGithubBehaviour): Promise<FakeGithub> {
  const requests: RecordedRequest[] = []
  let listCalls = 0
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request)
      const url = new URL(request.url ?? '/', 'http://fake')
      const path = decodeURIComponent(url.pathname)
      requests.push({
        method: request.method ?? 'GET',
        path: `${path}${url.search}`,
        authorization: String(request.headers.authorization ?? ''),
        ...(body ? { body } : {}),
      })
      const json = (status: number, value: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(value))
      }
      const login = behaviour.userLogin ?? 'octocat'
      if (request.method === 'GET' && path === '/user') {
        json(200, { login, id: 1, name: login })
        return
      }
      if (request.method === 'POST' && path === '/user/repos') {
        const parsed = JSON.parse(body || '{}') as Record<string, unknown>
        if (behaviour.createRepositoryResponse) {
          const answer = behaviour.createRepositoryResponse(parsed)
          json(answer.status, answer.body)
          return
        }
        const name = String(parsed.name)
        const fullName = `${login}/${name}`
        json(201, {
          full_name: fullName,
          name,
          private: parsed.private !== false,
          html_url: `https://github.com/${fullName}`,
          ssh_url: `git@github.com:${fullName}.git`,
          clone_url: `https://github.com/${fullName}.git`,
          default_branch: behaviour.defaultBranch ?? 'main',
          owner: { login },
        })
        return
      }
      const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(path)
      if (!repoMatch) {
        json(404, { message: 'Not Found' })
        return
      }
      const repo = `${repoMatch[1]}/${repoMatch[2]}`
      const rest = repoMatch[3] ?? ''
      if (request.method === 'GET' && rest === '') {
        json(200, {
          full_name: repo,
          name: repoMatch[2],
          private: true,
          owner: { login: repoMatch[1] },
          default_branch: behaviour.defaultBranch ?? 'main',
          html_url: `https://github.com/${repo}`,
          ssh_url: `git@github.com:${repo}.git`,
          clone_url: `https://github.com/${repo}.git`,
        })
        return
      }
      if (request.method === 'GET' && rest === '/pulls') {
        listCalls += 1
        const pulls = behaviour.listPulls ? behaviour.listPulls(listCalls) : (behaviour.pulls ?? [])
        json(200, pulls.map(pull => pullJson(repo, pull)))
        return
      }
      if (request.method === 'POST' && rest === '/pulls') {
        const parsed = JSON.parse(body || '{}') as Record<string, unknown>
        if (behaviour.createPullResponse) {
          const answer = behaviour.createPullResponse(parsed)
          json(answer.status, answer.body)
          return
        }
        const created = pullJson(repo, {
          number: 12,
          head: String(parsed.head),
          base: String(parsed.base),
          title: String(parsed.title),
          body: typeof parsed.body === 'string' ? parsed.body : undefined,
        })
        json(201, created)
        return
      }
      const pullMatch = /^\/pulls\/(\d+)$/.exec(rest)
      if (request.method === 'GET' && pullMatch) {
        const number = Number(pullMatch[1])
        const pull = (behaviour.pulls ?? []).find(entry => entry.number === number)
        if (!pull) {
          json(404, { message: 'Not Found' })
          return
        }
        json(200, pullJson(repo, pull))
        return
      }
      const commentsMatch = /^\/issues\/(\d+)\/comments$/.exec(rest)
      if (commentsMatch) {
        const number = Number(commentsMatch[1])
        if (request.method === 'GET') {
          json(
            200,
            (behaviour.comments ?? []).map(comment => ({
              id: comment.id,
              body: comment.body,
              user: { login: 'octocat' },
              created_at: new Date().toISOString(),
              html_url: `https://github.com/${repo}/issues/${number}#issuecomment-${comment.id}`,
            })),
          )
          return
        }
        if (request.method === 'POST') {
          const parsed = JSON.parse(body || '{}') as { body?: string }
          const comment = { id: 900, body: parsed.body ?? '' }
          behaviour.comments = [...(behaviour.comments ?? []), comment]
          json(201, {
            id: comment.id,
            body: comment.body,
            user: { login: 'octocat' },
            created_at: new Date().toISOString(),
            html_url: `https://github.com/${repo}/issues/${number}#issuecomment-${comment.id}`,
          })
          return
        }
      }
      if (request.method === 'GET' && /^\/commits\/.+\/check-runs$/.test(rest)) {
        const answer = behaviour.checkRuns ?? { status: 200, body: { total_count: 0, check_runs: [] } }
        json(answer.status, answer.body)
        return
      }
      if (request.method === 'GET' && rest === '/actions/runs') {
        const answer = behaviour.workflowRuns ?? { status: 404, body: { message: 'Not Found' } }
        json(answer.status, answer.body)
        return
      }
      json(404, { message: 'Not Found' })
    })().catch(() => {
      response.writeHead(500)
      response.end('{}')
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests, behaviour }
}

// ---------------------------------------------------------------------------
// Worker + tool harness
// ---------------------------------------------------------------------------

interface WorkerHarness {
  host: ReturnType<typeof createFakeHost>
  harness: ReturnType<typeof makeHarness>
  sessions: Sessions
  deps: ToolDeps
  worker: NonNullable<ReturnType<ReturnType<typeof createFakeHost>['agents']['liveAgent']>>
  ticket: Ticket
  stateDir: string
  workDir: string
}

async function makeWorker(options: {
  github?: ToolDeps['github']
  repository?: string
  secretFile?: string
  cwdStateDir?: boolean
}): Promise<WorkerHarness> {
  const host = createFakeHost()
  const harness = makeHarness()
  const stateDir = tempDir('worker-github')
  const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
  const sessions = new Sessions({
    agents: host.agents as unknown as HostAgentRegistry,
    presets: host.presets as never,
    persistence: host.persistence as never,
    logger,
    kv: harness.store.kv,
    createTimeoutMs: 2_000,
  })

  const trigger: Trigger = makeTrigger({
    text: 'please fix the thing',
    meta: options.repository ? { repository: options.repository } : {},
  })
  harness.engine.sources.receive(trigger)
  harness.engine.evaluateDue()
  const decided = harness.engine.mainSession.decide({
    triggerId: trigger.id,
    outcome: 'accept',
    title: 'Fix the thing',
    reason: [{ code: 'test' }],
  })
  const ticket = harness.store.tickets.get(decided.ticket!.id)!

  const workDir = join(stateDir, 'work', ticket.id)
  mkdirSync(workDir, { recursive: true })
  if (options.secretFile) {
    mkdirSync(join(stateDir, 'secrets'), { recursive: true, mode: 0o700 })
    writeFileSync(join(stateDir, 'secrets', options.secretFile), 'ghp_fromfile012345678901234567890\n', { mode: 0o600 })
  }
  const agent = await sessions.ensureWorker(ticket.id, workDir)
  sessions.bindAssignment(ticket.id, agent.session.id, ticket.assignments[ticket.assignments.length - 1]!.id)
  const deps: ToolDeps = {
    engine: harness.engine,
    store: harness.store,
    sessions,
    logger,
    ...(options.github ? { github: options.github } : {}),
  }
  registerWorkerTools(agent.ctx as unknown as Context, deps)
  const worker = host.agents.liveAgent(`superagent-worker-${ticket.id}`)!
  return { host, harness, sessions, deps, worker, ticket, stateDir, workDir }
}

/** Re-register the tool scope with different GitHub options (fresh closure). */
function setGithub(harness: WorkerHarness, github: ToolDeps['github']): void {
  harness.worker.ctx.tools.definitions.clear()
  registerWorkerTools(harness.worker.ctx as unknown as Context, { ...harness.deps, ...(github ? { github } : {}) })
}

describe('superagent_github tool', () => {
  it('opens a pull request with the ticket marker and returns number/url', async () => {
    const github = await startFakeGithub({ pulls: [] })
    const harness = await makeWorker({
      github: { token: 'ghp_TOKENTOKENTOKEN1234567890', apiBaseUrl: github.baseUrl, timeoutMs: 2_000 },
      repository: 'octo/repo',
    })

    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'pull_request',
      title: 'Fix the thing',
      body: 'Fixes the flaky test.',
    })).value as Record<string, unknown>

    expect(result.ok).toBe(true)
    expect(result.action).toBe('pull_request')
    expect(result.created).toBe(true)
    expect(result.number).toBe(12)
    expect(result.url).toContain('/pull/12')
    expect(result.repo).toBe('octo/repo')
    expect(result.head).toBe(`agent/${harness.ticket.id}`)
    expect(result.base).toBe('main')

    const createRequest = github.requests.find(entry => entry.method === 'POST' && entry.path.endsWith('/pulls'))
    expect(createRequest).toBeDefined()
    const body = JSON.parse(createRequest!.body ?? '{}') as { head?: string; base?: string; body?: string }
    expect(body.head).toBe(`agent/${harness.ticket.id}`)
    expect(body.base).toBe('main')
    expect(body.body).toContain(`<!-- superagent:${harness.ticket.id}:pr -->`)
    expect(body.body).toContain('Fixes the flaky test.')

    // Token used from the injected config, never echoed or logged.
    expect(github.requests.every(entry => entry.authorization === 'Bearer ghp_TOKENTOKENTOKEN1234567890')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('ghp_TOKENTOKENTOKEN1234567890')

    // Cached for the next call.
    const cached = harness.harness.store.kv.get<{ number: number }>(`superagent.github.pr.${harness.ticket.id}`)
    expect(cached?.number).toBe(12)
  })

  it('is idempotent: an existing PR for the branch is returned without creating another', async () => {
    const harness = await makeWorker({ repository: 'octo/repo' })
    const github = await startFakeGithub({
      pulls: [{ number: 7, head: `agent/${harness.ticket.id}`, base: 'main', state: 'open', title: 'Fix the thing' }],
    })
    setGithub(harness, { token: 'ghp_idempotent0000000000000000000000', apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })

    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'pull_request',
    })).value as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(result.created).toBe(false)
    expect(result.number).toBe(7)
    expect(github.requests.filter(entry => entry.method === 'POST')).toHaveLength(0)
  })

  it('recovers the existing PR when GitHub answers 422 duplicate', async () => {
    const harness = await makeWorker({ repository: 'octo/repo' })
    const github = await startFakeGithub({
      listPulls: call =>
        call === 1
          ? []
          : [{ number: 9, head: `agent/${harness.ticket.id}`, base: 'main', state: 'open', title: 'Fix the thing' }],
      createPullResponse: () => ({ status: 422, body: { message: 'A pull request already exists for octo:agent-branch.' } }),
    })
    setGithub(harness, { token: 'ghp_duplicate00000000000000000000000', apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })

    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'pull_request',
    })).value as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(result.created).toBe(false)
    expect(result.number).toBe(9)
    expect(github.requests.filter(entry => entry.method === 'POST')).toHaveLength(1)
  })

  it('comments once with a marker and returns the comment id', async () => {
    const harness = await makeWorker({ repository: 'octo/repo' })
    const github = await startFakeGithub({ pulls: [], comments: [] })
    setGithub(harness, { token: 'ghp_comment000000000000000000000000', apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })

    const first = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'comment',
      number: 7,
      body: 'CI is green.',
    })).value as Record<string, unknown>
    expect(first.ok).toBe(true)
    expect(first.action).toBe('comment')
    expect(first.number).toBe(7)
    expect(first.commentId).toBe(900)
    const posted = github.requests.find(entry => entry.method === 'POST' && entry.path.includes('/issues/7/comments'))
    expect(posted?.body).toContain('<!-- superagent:')

    // Second identical call: the source helper finds the marker and does not post again.
    const second = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'comment',
      number: 7,
      body: 'CI is green.',
    })).value as Record<string, unknown>
    expect(second.ok).toBe(true)
    expect(second.commentId).toBe(900)
    expect(github.requests.filter(entry => entry.method === 'POST' && entry.path.includes('/issues/7/comments'))).toHaveLength(1)
  })

  it('reads checks and tolerates an unavailable Actions API', async () => {
    const harness = await makeWorker({ repository: 'octo/repo' })
    const github = await startFakeGithub({
      pulls: [],
      checkRuns: {
        status: 200,
        body: {
          total_count: 2,
          check_runs: [
            { id: 1, name: 'ci/test', status: 'completed', conclusion: 'success', html_url: 'https://ci/1' },
            { id: 2, name: 'ci/lint', status: 'in_progress', conclusion: null, html_url: 'https://ci/2' },
          ],
        },
      },
      workflowRuns: { status: 404, body: { message: 'Not Found' } },
    })
    setGithub(harness, { token: 'ghp_checks0000000000000000000000000', apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })

    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'checks',
    })).value as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(result.action).toBe('checks')
    expect(result.ref).toBe(`agent/${harness.ticket.id}`)
    expect(result.partial).toBe(true)
    const checks = result.checks as { total: number; runs: Array<{ name: string; conclusion: string | null }> }
    expect(checks.total).toBe(2)
    expect(checks.runs.map(run => run.name)).toEqual(['ci/test', 'ci/lint'])
    expect(checks.runs[0]!.conclusion).toBe('success')
    const workflows = result.workflows as { error?: string }
    expect(workflows.error).toBeDefined()
  })

  it('returns a structured error when no token is configured (without leaking anything)', async () => {
    const harness = await makeWorker({ repository: 'octo/repo' })
    const github = await startFakeGithub({ pulls: [] })
    const previous = process.env.SUPERAGENT_GITHUB_TOKEN
    delete process.env.SUPERAGENT_GITHUB_TOKEN
    try {
      setGithub(harness, { apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })
      const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
        action: 'pull_request',
      })).value as Record<string, unknown>
      expect(result.ok).toBe(false)
      expect(result.error).toBe('github_token_missing')
      expect(github.requests).toHaveLength(0)
    } finally {
      if (previous !== undefined) process.env.SUPERAGENT_GITHUB_TOKEN = previous
    }
  })

  it('resolves the token from the wizard secret file when none is configured', async () => {
    const harness = await makeWorker({ repository: 'octo/repo', secretFile: 'github-token' })
    const github = await startFakeGithub({ pulls: [] })
    const previous = process.env.SUPERAGENT_GITHUB_TOKEN
    delete process.env.SUPERAGENT_GITHUB_TOKEN
    try {
      setGithub(harness, { apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })
      const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
        action: 'pull_request',
      })).value as Record<string, unknown>
      expect(result.ok).toBe(true)
      expect(github.requests[0]?.authorization).toBe('Bearer ghp_fromfile012345678901234567890')
      expect(JSON.stringify(result)).not.toContain('ghp_fromfile012345678901234567890')
    } finally {
      if (previous !== undefined) process.env.SUPERAGENT_GITHUB_TOKEN = previous
    }
  })

  it('resolves the token from the environment when no file is configured', async () => {
    const harness = await makeWorker({ repository: 'octo/repo' })
    const github = await startFakeGithub({ pulls: [] })
    const previous = process.env.SUPERAGENT_GITHUB_TOKEN
    process.env.SUPERAGENT_GITHUB_TOKEN = 'ghp_fromenv0123456789012345678901'
    try {
      setGithub(harness, { apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })
      const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
        action: 'pull_request',
      })).value as Record<string, unknown>
      expect(result.ok).toBe(true)
      expect(github.requests[0]?.authorization).toBe('Bearer ghp_fromenv0123456789012345678901')
    } finally {
      if (previous === undefined) delete process.env.SUPERAGENT_GITHUB_TOKEN
      else process.env.SUPERAGENT_GITHUB_TOKEN = previous
    }
  })

  it('maps API failures to structured, token-free errors', async () => {
    const harness = await makeWorker({ repository: 'octo/repo' })
    const github = await startFakeGithub({
      pulls: [],
      createPullResponse: () => ({ status: 403, body: { message: 'Resource not accessible by integration' } }),
    })
    setGithub(harness, { token: 'ghp_forbidden01234567890123456789', apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })
    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'pull_request',
    })).value as Record<string, unknown>
    expect(result.ok).toBe(false)
    expect(result.error).toBe('github_forbidden_or_missing')
    expect(String(result.detail)).toContain('Resource not accessible')
    expect(JSON.stringify(result)).not.toContain('ghp_forbidden')
  })

  it('requires a repository and a body where the action needs one', async () => {
    const harness = await makeWorker({})
    const github = await startFakeGithub({ pulls: [] })
    setGithub(harness, { token: 'ghp_validation012345678901234567890', apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })
    const noRepo = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'pull_request',
    })).value as Record<string, unknown>
    expect(noRepo).toMatchObject({ ok: false, error: 'repo_required' })

    const noBody = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'comment',
      repo: 'octo/repo',
      number: 3,
      body: '  ',
    })).value as Record<string, unknown>
    expect(noBody).toMatchObject({ ok: false, error: 'body_required' })
    expect(textOf({ content: [{ type: 'text', text: 'x' }] })).toBe('x')
  })
})

describe('superagent_github create_repository', () => {
  it('creates a private repository under the token owner and returns URLs', async () => {
    const github = await startFakeGithub({ pulls: [], defaultBranch: 'main', userLogin: 'octocat' })
    const harness = await makeWorker({})
    setGithub(harness, { token: 'ghp_repo000000000000000000000000000', apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })

    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'create_repository',
      name: 'my-new-project',
      description: '  experiments  ',
    })).value as Record<string, unknown>

    expect(result).toMatchObject({
      ok: true,
      action: 'create_repository',
      repo: 'octocat/my-new-project',
      fullName: 'octocat/my-new-project',
      name: 'my-new-project',
      private: true,
      htmlUrl: 'https://github.com/octocat/my-new-project',
      sshUrl: 'git@github.com:octocat/my-new-project.git',
      defaultBranch: 'main',
      created: true,
    })
    const post = github.requests.find(entry => entry.method === 'POST' && entry.path.endsWith('/user/repos'))
    expect(post).toBeDefined()
    const body = JSON.parse(post!.body ?? '{}') as { name?: string; private?: boolean; description?: string; auto_init?: boolean }
    expect(body.name).toBe('my-new-project')
    expect(body.private).toBe(true)
    expect(body.description).toBe('experiments')
    expect(github.requests.every(entry => entry.authorization === 'Bearer ghp_repo000000000000000000000000000')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('ghp_repo')
  })

  it('is idempotent: an existing repository is returned with created:false', async () => {
    const github = await startFakeGithub({
      pulls: [],
      userLogin: 'octocat',
      createRepositoryResponse: () => ({
        status: 422,
        body: { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] },
      }),
    })
    const harness = await makeWorker({})
    setGithub(harness, { token: 'ghp_existing00000000000000000000000', apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })

    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'create_repository',
      name: 'already-there',
      private: false,
    })).value as Record<string, unknown>

    expect(result.ok).toBe(true)
    expect(result.created).toBe(false)
    expect(result.repo).toBe('octocat/already-there')
    expect(result.private).toBe(true) // reflects the existing repository returned by the helper
    expect(JSON.stringify(result)).not.toContain('ghp_existing')
  })

  it('maps repository creation failures to structured, token-free errors', async () => {
    const github = await startFakeGithub({
      pulls: [],
      createRepositoryResponse: () => ({ status: 403, body: { message: 'Resource not accessible by integration' } }),
    })
    const harness = await makeWorker({})
    setGithub(harness, { token: 'ghp_repofail000000000000000000000000', apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })

    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'create_repository',
      name: 'nope',
    })).value as Record<string, unknown>
    expect(result.ok).toBe(false)
    expect(result.error).toBe('github_forbidden_or_missing')
    expect(JSON.stringify(result)).not.toContain('ghp_repofail')
  })

  it('validates the repository name', async () => {
    const github = await startFakeGithub({ pulls: [] })
    const harness = await makeWorker({})
    setGithub(harness, { token: 'ghp_reponame000000000000000000000000', apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })

    const missing = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'create_repository',
    })).value as Record<string, unknown>
    expect(missing).toMatchObject({ ok: false, error: 'name_required' })
    const invalid = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'create_repository',
      name: 'has spaces',
    })).value as Record<string, unknown>
    expect(invalid).toMatchObject({ ok: false, error: 'invalid_name' })
    expect(github.requests).toHaveLength(0)
  })
})
