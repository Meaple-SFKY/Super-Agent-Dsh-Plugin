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

import { registerWorkerTools, workerToolDefinitions } from '../src/tools/worker.js'
import type { ToolDeps } from '../src/tools/shared.js'
import { Sessions, type HostAgentRegistry } from '../src/app/sessions.js'
import type { Ticket, Trigger } from '../src/core/model.js'
import type { Context } from '@deepseek-ai/cordis'
import { makeHarness, makePolicy, makeTrigger } from './core-fixtures.js'
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
  /** Map a Bearer token to the /user login (multi-account tests). */
  userLogins?: Record<string, string>
  createRepositoryResponse?: (body: Record<string, unknown>) => { status: number; body: unknown }
  /** Pending invitations returned by GET /user/repository_invitations. */
  invitations?: Array<Record<string, unknown>>
  /** Status for PUT /repos/:repo/collaborators/:login (default 204). */
  collaboratorStatus?: number
  /** Status for PATCH /user/repository_invitations/:id (default 204). */
  acceptInvitationStatus?: number
  issues?: Array<Record<string, unknown>>
  issueDetail?: Record<string, unknown>
  createIssueResponse?: (body: Record<string, unknown>) => { status: number; body: unknown }
  updateIssueResponse?: (body: Record<string, unknown>) => { status: number; body: unknown }
  pullFiles?: Array<Record<string, unknown>>
  reviewResponse?: { status: number; body: unknown }
  mergeResponse?: { status: number; body: unknown }
  searchResult?: { status: number; body: unknown }
  inviteResponse?: (username: string, body: Record<string, unknown>) => { status: number; body?: unknown }
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
      if (request.method === 'GET' && path === '/search/issues') {
        const answer = behaviour.searchResult ?? {
          status: 200,
          body: {
            total_count: (behaviour.issues ?? []).length,
            items: behaviour.issues ?? [],
          },
        }
        json(answer.status, answer.body)
        return
      }
      if (request.method === 'GET' && path === '/user') {
        const bearer = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
        const userLogin = behaviour.userLogins?.[bearer] ?? login
        json(200, { login: userLogin, id: 1, name: userLogin })
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
      const invitationMatch = /^\/user\/repository_invitations\/(\d+)$/.exec(path)
      if (request.method === 'PATCH' && invitationMatch) {
        const status = behaviour.acceptInvitationStatus ?? 204
        response.writeHead(status)
        response.end()
        return
      }
      if (request.method === 'GET' && path === '/user/repository_invitations') {
        json(200, behaviour.invitations ?? [])
        return
      }
      const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(path)
      if (!repoMatch) {
        json(404, { message: 'Not Found' })
        return
      }
      const repo = `${repoMatch[1]}/${repoMatch[2]}`
      const rest = repoMatch[3] ?? ''
      const collaboratorMatch = /^\/collaborators\/([^/]+)$/.exec(rest)
      if (request.method === 'PUT' && collaboratorMatch) {
        const username = collaboratorMatch[1]!
        const parsed = JSON.parse(body || '{}') as Record<string, unknown>
        if (behaviour.inviteResponse) {
          const answer = behaviour.inviteResponse(username, parsed)
          if (answer.body === undefined) {
            response.writeHead(answer.status)
            response.end()
            return
          }
          json(answer.status, answer.body)
          return
        }
        json(201, { id: 1, permission: parsed.permission ?? 'admin', invitee: { login: username } })
        return
      }
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
      const issueListMatch = rest === '/issues'
      if (issueListMatch) {
        if (request.method === 'GET') {
          json(200, behaviour.issues ?? [])
          return
        }
        if (request.method === 'POST') {
          const parsed = JSON.parse(body || '{}') as Record<string, unknown>
          if (behaviour.createIssueResponse) {
            const answer = behaviour.createIssueResponse(parsed)
            json(answer.status, answer.body)
            return
          }
          json(201, {
            number: 21,
            title: String(parsed.title),
            body: typeof parsed.body === 'string' ? parsed.body : null,
            state: 'open',
            labels: Array.isArray(parsed.labels) ? parsed.labels : [],
            assignees: [],
            user: { login },
            html_url: `https://github.com/${repo}/issues/21`,
            comments: 0,
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          })
          return
        }
      }
      const issueMatch = /^\/issues\/(\d+)$/.exec(rest)
      if (issueMatch) {
        const number = Number(issueMatch[1])
        if (request.method === 'GET') {
          const found = behaviour.issueDetail ?? {
            number,
            title: 'Existing issue',
            body: 'Issue body',
            state: 'open',
            labels: [],
            user: { login },
            html_url: `https://github.com/${repo}/issues/${number}`,
            comments: 1,
            updated_at: new Date().toISOString(),
          }
          json(200, found)
          return
        }
        if (request.method === 'PATCH') {
          const parsed = JSON.parse(body || '{}') as Record<string, unknown>
          if (behaviour.updateIssueResponse) {
            const answer = behaviour.updateIssueResponse(parsed)
            json(answer.status, answer.body)
            return
          }
          json(200, {
            ...(behaviour.issueDetail ?? {}),
            number,
            title: typeof parsed.title === 'string' ? parsed.title : 'Existing issue',
            state: typeof parsed.state === 'string' ? parsed.state : 'open',
            labels: Array.isArray(parsed.labels) ? parsed.labels : [],
            user: { login },
            html_url: `https://github.com/${repo}/issues/${number}`,
          })
          return
        }
      }
      const filesMatch = /^\/pulls\/(\d+)\/files$/.exec(rest)
      if (request.method === 'GET' && filesMatch) {
        json(200, behaviour.pullFiles ?? [])
        return
      }
      const reviewMatch = /^\/pulls\/(\d+)\/reviews$/.exec(rest)
      if (request.method === 'POST' && reviewMatch) {
        const answer = behaviour.reviewResponse ?? {
          status: 200,
          body: { id: 55, state: 'APPROVED', html_url: `https://github.com/${repo}/pull/${reviewMatch[1]}#pullrequestreview-55` },
        }
        json(answer.status, answer.body)
        return
      }
      const mergeMatch = /^\/pulls\/(\d+)\/merge$/.exec(rest)
      if (request.method === 'PUT' && mergeMatch) {
        const answer = behaviour.mergeResponse ?? {
          status: 200,
          body: { merged: true, sha: 'deadbeef', message: 'Pull Request successfully merged' },
        }
        json(answer.status, answer.body)
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
  /** Override the policy repositories allowlist (defaults to `[repository]`). */
  repositories?: string[]
  secretFile?: string
  cwdStateDir?: boolean
}): Promise<WorkerHarness> {
  const host = createFakeHost()
  const harness = makeHarness()
  const policy = makePolicy()
  const repositories = options.repositories ?? (options.repository ? [options.repository] : undefined)
  if (repositories) {
    const githubPolicy = policy.sources.github ?? { allowed: [] }
    policy.sources.github = { ...githubPolicy, allowed: githubPolicy.allowed ?? [], repositories }
  }
  harness.policy.set(policy)
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
    const harness = await makeWorker({ repositories: ['octo/repo'] })
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
  it('rejects repositories outside the configured allowlist before any API call', async () => {
    const github = await startFakeGithub({ pulls: [] })
    const harness = await makeWorker({ repository: 'octo/repo', repositories: ['owner/repo'] })
    setGithub(harness, { token: 'ghp_allowlist0000000000000000000000', apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })

    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'get_issue',
      repo: 'octo/repo',
      number: 1,
    })).value as Record<string, unknown>

    expect(result).toMatchObject({ ok: false, error: 'repo_not_allowed' })
    expect(github.requests).toHaveLength(0)
  })

  it('allows wildcard repositories only when the owner is the token account or an operator', async () => {
    const github = await startFakeGithub({ pulls: [], userLogin: 'octocat' })
    const allowed = await makeWorker({ repository: 'octocat/repo', repositories: ['*'] })
    setGithub(allowed, { token: 'ghp_wildcard00000000000000000000000', apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })
    const accepted = (await allowed.host.executeTool(allowed.worker, 'superagent_github', {
      action: 'get_issue',
      repo: 'octocat/repo',
      number: 1,
    })).value as Record<string, unknown>
    expect(accepted).toMatchObject({ ok: true, action: 'get_issue', repo: 'octocat/repo' })

    const rejected = await makeWorker({ repository: 'evil/repo', repositories: ['*'] })
    setGithub(rejected, { token: 'ghp_wildcardevil0000000000000000000', apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })
    const denied = (await rejected.host.executeTool(rejected.worker, 'superagent_github', {
      action: 'get_issue',
      repo: 'evil/repo',
      number: 1,
    })).value as Record<string, unknown>
    expect(denied).toMatchObject({ ok: false, error: 'repo_not_allowed' })
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

  it('invites only configured collaborators (ignoring model input) after creating the repository', async () => {
    const github = await startFakeGithub({ pulls: [], defaultBranch: 'main', userLogin: 'octocat' })
    const harness = await makeWorker({})
    const token = 'ghp_invite000000000000000000000000'
    setGithub(harness, {
      token,
      apiBaseUrl: github.baseUrl,
      timeoutMs: 2_000,
      collaborators: ['alice', 'bob'],
    })

    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'create_repository',
      name: 'team-project',
      collaborators: ['mallory'],
    })).value as Record<string, unknown>

    expect(result).toMatchObject({
      ok: true,
      created: true,
      repo: 'octocat/team-project',
      collaborators: [
        { login: 'alice', status: 'invited' },
        { login: 'bob', status: 'invited' },
      ],
    })
    expect(result.warnings).toBeUndefined()
    const puts = github.requests.filter(entry => entry.method === 'PUT' && entry.path.includes('/collaborators/'))
    expect(puts.map(entry => entry.path.split('/collaborators/')[1])).toEqual(['alice', 'bob'])
    for (const put of puts) {
      const body = JSON.parse(put.body ?? '{}') as { permission?: string }
      expect(body.permission).toBe('admin')
      expect(put.authorization).toBe(`Bearer ${token}`)
    }
    expect(JSON.stringify(result)).not.toContain(token)
  })

  it('does not invite collaborators for an existing repository', async () => {
    const github = await startFakeGithub({
      pulls: [],
      userLogin: 'octocat',
      createRepositoryResponse: () => ({
        status: 422,
        body: { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] },
      }),
    })
    const harness = await makeWorker({})
    setGithub(harness, {
      token: 'ghp_existingcollab000000000000000000',
      apiBaseUrl: github.baseUrl,
      timeoutMs: 2_000,
      collaborators: ['alice'],
    })

    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'create_repository',
      name: 'already-there',
    })).value as Record<string, unknown>

    expect(result.ok).toBe(true)
    expect(result.created).toBe(false)
    expect(result.collaborators).toBeUndefined()
    expect(github.requests.filter(entry => entry.method === 'PUT')).toHaveLength(0)
  })

  it('uses the configured collaborators by default and sends no invitation when none are configured', async () => {
    const github = await startFakeGithub({ pulls: [], userLogin: 'octocat' })
    const harness = await makeWorker({})
    const token = 'ghp_default00000000000000000000000'
    setGithub(harness, {
      token,
      apiBaseUrl: github.baseUrl,
      timeoutMs: 2_000,
      collaborators: ['dana'],
    })

    const withDefault = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'create_repository',
      name: 'configured-project',
    })).value as Record<string, unknown>
    expect(withDefault.collaborators).toEqual([{ login: 'dana', status: 'invited' }])

    setGithub(harness, { token, apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })
    const before = github.requests.filter(entry => entry.method === 'PUT').length
    const withoutAny = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'create_repository',
      name: 'solo-project',
    })).value as Record<string, unknown>
    expect(withoutAny.ok).toBe(true)
    expect(withoutAny.collaborators).toBeUndefined()
    expect(github.requests.filter(entry => entry.method === 'PUT')).toHaveLength(before)
  })

  it('keeps the repository when an invitation fails and reports a warning', async () => {
    const github = await startFakeGithub({
      pulls: [],
      userLogin: 'octocat',
      inviteResponse: username =>
        username === 'blocked'
          ? { status: 403, body: { message: 'Resource not accessible by integration' } }
          : { status: 201, body: { id: 1, invitee: { login: username } } },
    })
    const harness = await makeWorker({})
    const token = 'ghp_invitefail00000000000000000000'
    setGithub(harness, {
      token,
      apiBaseUrl: github.baseUrl,
      timeoutMs: 2_000,
      collaborators: ['good', 'blocked'],
    })

    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'create_repository',
      name: 'half-invited',
    })).value as Record<string, unknown>

    expect(result.ok).toBe(true)
    expect(result.created).toBe(true)
    expect(result.collaborators).toEqual([
      { login: 'good', status: 'invited' },
      { login: 'blocked', status: 'failed' },
    ])
    expect(result.warnings).toHaveLength(1)
    expect(String((result.warnings as string[])[0])).toContain('could not invite blocked')
    expect(JSON.stringify(result)).not.toContain(token)
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

describe('superagent_github issue / pull / review / search actions (task-39)', () => {
  async function setup(behaviour: FakeGithubBehaviour) {
    const github = await startFakeGithub({ pulls: [], ...behaviour })
    const harness = await makeWorker({ repository: 'octo/repo' })
    setGithub(harness, { token: 'ghp_actions000000000000000000000000', apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })
    return { github, harness }
  }

  it('reads an issue and lists issues with filters', async () => {
    const { github, harness } = await setup({
      issueDetail: {
        number: 7,
        title: 'Bug report',
        body: 'Steps to reproduce…',
        state: 'open',
        labels: [{ name: 'bug' }],
        user: { login: 'reporter' },
        html_url: 'https://github.com/octo/repo/issues/7',
        comments: 3,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      issues: [
        { number: 7, title: 'Bug report', state: 'open', html_url: 'https://github.com/octo/repo/issues/7', user: { login: 'reporter' }, updated_at: '2026-01-01T00:00:00.000Z' },
        { number: 8, title: 'Feature', state: 'closed', html_url: 'https://github.com/octo/repo/issues/8', user: { login: 'r2' }, updated_at: '2026-01-02T00:00:00.000Z' },
      ],
    })
    const issue = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'get_issue',
      number: 7,
    })).value as Record<string, unknown>
    expect(issue).toMatchObject({ ok: true, action: 'get_issue', repo: 'octo/repo' })
    expect((issue.issue as Record<string, unknown>).title).toBe('Bug report')
    expect((issue.issue as Record<string, unknown>).labels).toEqual(['bug'])

    const list = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'list_issues',
      state: 'all',
      labels: ['bug'],
    })).value as Record<string, unknown>
    expect(list.ok).toBe(true)
    expect((list.issues as unknown[]).length).toBe(2)
    const request = github.requests.find(entry => entry.method === 'GET' && entry.path.includes('/repos/octo/repo/issues?'))
    expect(request!.path).toContain('state=all')
    expect(request!.path).toContain('labels=bug')
  })

  it('creates and updates an issue with explicit fields and the SuperAgent marker', async () => {
    const { github, harness } = await setup({})
    const created = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'create_issue',
      title: 'Rework the parser',
      body: 'Please rework it.',
      labels: ['task'],
      assignees: ['octocat'],
    })).value as Record<string, unknown>
    expect(created).toMatchObject({ ok: true, action: 'create_issue', repo: 'octo/repo' })
    expect((created.issue as Record<string, unknown>).number).toBe(21)
    const post = github.requests.find(entry => entry.method === 'POST' && entry.path.endsWith('/repos/octo/repo/issues'))
    const body = JSON.parse(post!.body ?? '{}') as Record<string, unknown>
    expect(body).toMatchObject({ title: 'Rework the parser', labels: ['task'], assignees: ['octocat'] })
    expect(String(body.body)).toContain(`<!-- superagent:${harness.ticket.id}:issue -->`)
    expect(JSON.stringify(created)).not.toContain('ghp_actions')

    const updated = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'update_issue',
      number: 8,
      state: 'closed',
      labels: ['done'],
    })).value as Record<string, unknown>
    expect(updated.ok).toBe(true)
    const patch = github.requests.find(entry => entry.method === 'PATCH' && entry.path.includes('/issues/8'))
    expect(JSON.parse(patch!.body ?? '{}')).toEqual({ state: 'closed', labels: ['done'] })

    const nothing = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'update_issue',
      number: 8,
    })).value as Record<string, unknown>
    expect(nothing).toMatchObject({ ok: false, error: 'nothing_to_update' })
  })

  it('reads pulls and pull files with a bounded diff summary', async () => {
    const { github, harness } = await setup({
      pulls: [
        { number: 4, head: 'agent/t_x', base: 'main', state: 'open', title: 'PR four' },
        { number: 5, head: 'feature', base: 'main', state: 'closed', title: 'PR five' },
      ],
      pullFiles: [
        { filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, changes: 4, patch: 'x'.repeat(5000) },
        { filename: 'src/b.ts', status: 'added', additions: 10, deletions: 0, changes: 10, patch: null },
      ],
    })
    const pull = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'get_pull',
      number: 4,
    })).value as Record<string, unknown>
    expect((pull.pull as Record<string, unknown>).title).toBe('PR four')

    const list = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'list_pulls',
      state: 'all',
    })).value as Record<string, unknown>
    expect((list.pulls as unknown[]).length).toBe(2)

    const files = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'get_pull_files',
      number: 4,
    })).value as Record<string, unknown>
    expect(files.ok).toBe(true)
    const listFiles = files.files as Array<Record<string, unknown>>
    expect(listFiles.map(file => file.filename)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(String(listFiles[0]!.patch).length).toBeLessThanOrEqual(801)
    expect(String(listFiles[0]!.patch).endsWith('…')).toBe(true)
    expect(github.requests.some(entry => entry.path.includes('/pulls/4/files'))).toBe(true)
  })

  it('submits a review (approve / request changes) with optional inline comments', async () => {
    const { github, harness } = await setup({
      pulls: [{ number: 4, head: 'agent/t_x', base: 'main', state: 'open', title: 'PR four' }],
      reviewResponse: { status: 200, body: { id: 77, state: 'APPROVED', html_url: 'https://github.com/octo/repo/pull/4#review-77' } },
    })
    const approved = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'review',
      number: 4,
      event: 'APPROVE',
      body: 'Looks good',
    })).value as Record<string, unknown>
    expect(approved).toMatchObject({ ok: true, action: 'review', number: 4, reviewId: 77, state: 'APPROVED' })
    const post = github.requests.find(entry => entry.method === 'POST' && entry.path.includes('/pulls/4/reviews'))
    const body = JSON.parse(post!.body ?? '{}') as Record<string, unknown>
    expect(body.event).toBe('APPROVE')
    expect(String(body.body)).toContain(`<!-- superagent:${harness.ticket.id}:review -->`)

    await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'review',
      number: 4,
      event: 'REQUEST_CHANGES',
      body: 'Please fix',
      comments: [{ path: 'src/a.ts', body: 'nit', line: 3, side: 'RIGHT' }],
    })
    const second = github.requests.filter(entry => entry.method === 'POST' && entry.path.includes('/pulls/4/reviews')).pop()
    const secondBody = JSON.parse(second!.body ?? '{}') as Record<string, unknown>
    expect(secondBody.event).toBe('REQUEST_CHANGES')
    expect(secondBody.comments).toEqual([{ path: 'src/a.ts', body: 'nit', line: 3, side: 'RIGHT' }])

    const noBody = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'review',
      number: 4,
      event: 'REQUEST_CHANGES',
    })).value as Record<string, unknown>
    expect(noBody).toMatchObject({ ok: false, error: 'body_required' })
  })

  it('merges only with explicit confirm and reports the commit', async () => {
    const { github, harness } = await setup({
      pulls: [{ number: 4, head: 'agent/t_x', base: 'main', state: 'open', title: 'PR four' }],
      mergeResponse: { status: 200, body: { merged: true, sha: 'deadbeef', message: 'merged' } },
    })
    const refused = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'merge_pull',
      number: 4,
    })).value as Record<string, unknown>
    expect(refused).toMatchObject({ ok: false, error: 'confirm_required' })
    expect(github.requests.some(entry => entry.method === 'PUT')).toBe(false)

    const merged = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'merge_pull',
      number: 4,
      confirm: true,
      mergeMethod: 'squash',
    })).value as Record<string, unknown>
    expect(merged).toMatchObject({ ok: true, action: 'merge_pull', merged: true, commit: 'deadbeef', mergeMethod: 'squash' })
    const put = github.requests.find(entry => entry.method === 'PUT' && entry.path.includes('/pulls/4/merge'))
    expect(JSON.parse(put!.body ?? '{}')).toEqual({ merge_method: 'squash' })

    // A closed/ended ticket cannot merge.
    harness.ticket.state = 'ended'
    harness.harness.store.tickets.save(harness.ticket)
    const blocked = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'merge_pull',
      number: 4,
      confirm: true,
    })).value as Record<string, unknown>
    expect(blocked).toMatchObject({ ok: false, error: 'ticket_not_open' })
  })

  it('reports merge failures as structured GitHub errors', async () => {
    const { harness } = await setup({
      pulls: [{ number: 4, head: 'agent/t_x', base: 'main', state: 'open', title: 'PR four' }],
      mergeResponse: { status: 405, body: { message: 'Pull Request is not mergeable' } },
    })
    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'merge_pull',
      number: 4,
      confirm: true,
    })).value as Record<string, unknown>
    expect(result.ok).toBe(false)
    expect(result.error).toBe('github_api_error')
    expect(String(result.detail)).toContain('not mergeable')
  })

  it('searches issues/PRs and lists checks via the alias action', async () => {
    const { github, harness } = await setup({
      searchResult: {
        status: 200,
        body: {
          total_count: 2,
          items: [
            { number: 1, title: 'Issue hit', state: 'open', html_url: 'https://github.com/octo/repo/issues/1', user: { login: 'u' }, updated_at: '2026-01-01T00:00:00.000Z' },
            { number: 2, title: 'PR hit', state: 'open', html_url: 'https://github.com/octo/repo/pull/2', pull_request: { url: 'x' }, user: { login: 'u' }, updated_at: '2026-01-01T00:00:00.000Z' },
          ],
        },
      },
      checkRuns: {
        status: 200,
        body: {
          total_count: 1,
          check_runs: [{ id: 1, name: 'ci/test', status: 'completed', conclusion: 'success', html_url: 'https://ci/1' }],
        },
      },
    })
    const search = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'search',
      query: 'repo:octo/repo is:open',
    })).value as Record<string, unknown>
    expect(search).toMatchObject({ ok: true, action: 'search', total: 2 })
    const items = search.items as Array<Record<string, unknown>>
    expect(items.map(item => item.isPull)).toEqual([false, true])
    expect(github.requests.some(entry => entry.path.startsWith('/search/issues?'))).toBe(true)

    const checks = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'list_checks',
    })).value as Record<string, unknown>
    expect(checks).toMatchObject({ ok: true, action: 'list_checks' })
    expect((checks.checks as { total: number }).total).toBe(1)
  })

  it('never leaks the token in any action result', async () => {
    const { harness } = await setup({
      issues: [{ number: 7, title: 'x', state: 'open', html_url: 'u', user: { login: 'u' }, updated_at: 't' }],
      searchResult: { status: 200, body: { total_count: 0, items: [] } },
    })
    const results = await Promise.all([
      harness.host.executeTool(harness.worker, 'superagent_github', { action: 'get_issue', number: 7 }),
      harness.host.executeTool(harness.worker, 'superagent_github', { action: 'list_issues' }),
      harness.host.executeTool(harness.worker, 'superagent_github', { action: 'search', query: 'x' }),
    ])
    for (const result of results) expect(JSON.stringify(result.value)).not.toContain('ghp_actions')
  })
})

describe('superagent_report files (task-39)', () => {
  it('carries local files into the report (Engine maps them to message attachments)', async () => {
    const harness = await makeWorker({})
    const image = join(harness.workDir, 'screenshot.png')
    const log = join(harness.workDir, 'build.log')
    writeFileSync(image, 'PNG')
    writeFileSync(log, 'log output')
    const result = (await harness.host.executeTool(harness.worker, 'superagent_report', {
      kind: 'ready',
      summary: 'Done, screenshots attached',
      files: [{ path: 'screenshot.png', caption: 'UI after fix' }, { path: log, name: 'build.log' }],
    })).value as Record<string, unknown>
    expect(result).toMatchObject({ ok: true, files: 2 })
    const report = harness.harness.store.tickets.get(harness.ticket.id)!.latestReport!
    expect(report.files).toEqual([
      { path: image, name: undefined, caption: 'UI after fix', kind: 'photo' },
      { path: log, name: 'build.log', kind: 'document' },
    ].map(file => Object.fromEntries(Object.entries(file).filter(([, value]) => value !== undefined))))
  })

  it('rejects missing paths and caps the file count', async () => {
    const harness = await makeWorker({})
    const invalid = (await harness.host.executeTool(harness.worker, 'superagent_report', {
      kind: 'progress',
      summary: 'x',
      files: [{ path: '/definitely/missing/file.png' }],
    })).value as Record<string, unknown>
    expect(invalid).toMatchObject({ ok: false, error: 'invalid_file_path' })

    const many = Array.from({ length: 12 }, (_, index) => {
      const path = join(harness.workDir, `artifact-${index}.txt`)
      writeFileSync(path, 'x')
      return { path }
    })
    await harness.host.executeTool(harness.worker, 'superagent_report', {
      kind: 'progress',
      summary: 'many files',
      files: many,
    })
    const report = harness.harness.store.tickets.get(harness.ticket.id)!.latestReport!
    expect(report.files).toHaveLength(10)
  })
})

describe('create_repository operator auto-accept (task-52)', () => {
  it('invites the operator and accepts the repository invitation with the operator PAT', async () => {
    const operatorTokenFile = join(tempDir('operator-pat'), 'github-operator-token')
    writeFileSync(operatorTokenFile, 'ghp_operator_secret', { mode: 0o600 })
    const github = await startFakeGithub({
      pulls: [],
      userLogin: 'bot-user',
      invitations: [
        {
          id: 77,
          repository: { full_name: 'bot-user/cine-project', private: true, html_url: 'https://github.com/bot-user/cine-project' },
          permissions: 'push',
          inviter: { login: 'operator-user' },
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      inviteResponse: () => ({ status: 201 }),
      acceptInvitationStatus: 204,
    })
    const harness = await makeWorker({})
    setGithub(harness, {
      token: 'ghp_bot_token',
      collaborators: ['operator-user'],
      login: 'bot-user',
      operatorTokenFile,
      apiBaseUrl: github.baseUrl,
      timeoutMs: 2_000,
    })

    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'create_repository',
      name: 'cine-project',
    })).value as Record<string, unknown>

    expect(result).toMatchObject({
      ok: true,
      action: 'create_repository',
      repo: 'bot-user/cine-project',
      created: true,
      collaborators: [{ login: 'operator-user', status: 'invited' }],
      operator: { status: 'accepted', invitationId: 77 },
    })
    const invite = github.requests.find(entry => entry.method === 'PUT' && entry.path.includes('/collaborators/operator-user'))
    expect(invite?.authorization).toBe('Bearer ghp_bot_token')
    const listInvites = github.requests.find(entry => entry.method === 'GET' && entry.path.startsWith('/user/repository_invitations'))
    expect(listInvites?.authorization).toBe('Bearer ghp_operator_secret')
    const accept = github.requests.find(entry => entry.method === 'PATCH' && entry.path.includes('/user/repository_invitations/77'))
    expect(accept?.authorization).toBe('Bearer ghp_operator_secret')
    expect(JSON.stringify(result)).not.toContain('ghp_operator_secret')
    expect(JSON.stringify(result)).not.toContain('ghp_bot_token')
  })

  it('warns when the operator has no pending invitation but still succeeds', async () => {
    const operatorTokenFile = join(tempDir('operator-pat-none'), 'github-operator-token')
    writeFileSync(operatorTokenFile, 'ghp_operator_secret', { mode: 0o600 })
    const github = await startFakeGithub({ pulls: [], userLogin: 'bot-user', invitations: [] })
    const harness = await makeWorker({})
    setGithub(harness, {
      token: 'ghp_bot_token',
      collaborators: ['operator-user'],
      login: 'bot-user',
      operatorTokenFile,
      apiBaseUrl: github.baseUrl,
      timeoutMs: 2_000,
    })
    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'create_repository',
      name: 'cine-project',
    })).value as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(result.operator).toEqual({ status: 'none' })
    const warnings = result.warnings as string[]
    expect(warnings.some(line => line.includes('no pending invitation'))).toBe(true)
    expect(github.requests.some(entry => entry.method === 'PATCH')).toBe(false)
  })
})

describe('create_repository operator derivation (task-52)', () => {
  it('derives the operator login from the personal PAT when collaborators are not configured', async () => {
    const operatorTokenFile = join(tempDir('operator-pat-derive'), 'github-operator-token')
    writeFileSync(operatorTokenFile, 'ghp_operator_secret', { mode: 0o600 })
    const github = await startFakeGithub({
      pulls: [],
      userLogin: 'bot-user',
      invitations: [
        {
          id: 88,
          repository: { full_name: 'bot-user/derived-project', private: true, html_url: 'https://github.com/bot-user/derived-project' },
          permissions: 'push',
          inviter: { login: 'operator-user' },
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      inviteResponse: () => ({ status: 201 }),
      acceptInvitationStatus: 204,
      userLogins: { ghp_operator_secret: 'operator-user' },
    })
    const harness = await makeWorker({})
    setGithub(harness, {
      token: 'ghp_bot_token',
      login: 'bot-user',
      operatorTokenFile,
      apiBaseUrl: github.baseUrl,
      timeoutMs: 2_000,
    })
    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'create_repository',
      name: 'derived-project',
    })).value as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(result.collaborators).toEqual([{ login: 'operator-user', status: 'invited' }])
    expect(result.operator).toEqual({ status: 'accepted', invitationId: 88 })
    // The login derivation validates the personal token once against /user.
    const userCall = github.requests.find(entry => entry.method === 'GET' && entry.path === '/user')
    expect(userCall?.authorization).toBe('Bearer ghp_operator_secret')
  })
})

describe('large-output and schema caching (task-56)', () => {
  it('truncates pull files structurally instead of cutting the JSON text', async () => {
    const pullFiles = Array.from({ length: 12 }, (_, index) => ({
      filename: `src/file-${index}.ts`,
      status: 'modified',
      additions: 10,
      deletions: 2,
      changes: 12,
      patch: 'y'.repeat(1500),
    }))
    const github = await startFakeGithub({
      pulls: [{ number: 7, head: 'agent/t_x', base: 'main' }],
      pullFiles,
    })
    const harness = await makeWorker({ repository: 'octo/repo' })
    setGithub(harness, { token: 'ghp_actions000000000000000000000000', apiBaseUrl: github.baseUrl, timeoutMs: 2_000 })
    const result = (await harness.host.executeTool(harness.worker, 'superagent_github', {
      action: 'get_pull_files',
      number: 7,
      limit: 30,
    })).value as Record<string, unknown>
    expect(result.ok).toBe(true)
    const files = result.files as Array<Record<string, unknown>>
    expect(files.length).toBeLessThan(12)
    expect(result.truncated).toBe(true)
    expect(result.fileCount).toBe(files.length)
    for (const file of files) expect(String(file.patch).length).toBeLessThanOrEqual(801)
    // The returned payload is still valid JSON.
    expect(() => JSON.parse(JSON.stringify(result))).not.toThrow()
  })

  it('compiles tool definitions once per ToolDeps object', async () => {
    const harness = await makeWorker({ repository: 'octo/repo' })
    const first = workerToolDefinitions(harness.deps)
    const second = workerToolDefinitions(harness.deps)
    expect(second).toBe(first)
    // Registration closes over the same definitions for every worker session.
    expect(workerToolDefinitions({ ...harness.deps }).length).toBe(first.length)
  })
})
