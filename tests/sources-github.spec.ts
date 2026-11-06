/**
 * Adapter tests for the GitHub Source and REST client: a real `node:http` fake
 * API, an in-memory SourceContext, and a fake token.
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import type { Trigger } from '../src/core/model.js'
import type { SourceContext, SourceHealth, SourceLogger } from '../src/sources/kind.js'
import {
  createSource,
  parseCommentTarget,
  type GithubCallbacks,
  type GithubConfig,
  type GithubPullInfo,
  type GithubSource,
} from '../src/sources/github.js'
import {
  GithubApi,
  GithubApiError,
  GithubTokenValidationError,
  createGithubTokenProvider,
  listGithubRepositories,
  validateGithubToken,
  type GithubCheckRun,
  type GithubComment,
  type GithubIssue,
  type GithubPullRequest,
  type GithubReview,
  type GithubWorkflowRun,
} from '../src/sources/github-api.js'

// Fake token: the fake server never verifies it, and no real credential may
// ever appear in this repository.
const TEST_TOKEN_ENV = 'SUPERAGENT_GITHUB_TOKEN'
process.env[TEST_TOKEN_ENV] = 'test-token-not-a-secret'
afterAll(() => {
  delete process.env[TEST_TOKEN_ENV]
})

// ---------------------------------------------------------------------------
// Fake GitHub API
// ---------------------------------------------------------------------------

interface GithubRequest {
  method: string
  path: string
  url: URL
  query: URLSearchParams
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
  callIndex: number
}

interface GithubAnswer {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  /** Do not answer at all (used to test request timeouts). */
  pending?: boolean
}

type GithubHandler = (request: GithubRequest) => GithubAnswer | undefined

interface FakeGithub {
  url: string
  requests: GithubRequest[]
  requestsTo(path: string): GithubRequest[]
  close(): Promise<void>
}

const openServers: FakeGithub[] = []

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => server.close()))
})

async function startGithub(handler: GithubHandler): Promise<FakeGithub> {
  const requests: GithubRequest[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      let body: Record<string, unknown> = {}
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        } catch {
          body = {}
        }
      }
      const request: GithubRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        url,
        query: url.searchParams,
        headers: req.headers,
        body,
        callIndex: requests.length + 1,
      }
      requests.push(request)
      const answer = handler(request)
      if (!answer) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'Not Found' }))
        return
      }
      if (answer.pending) return
      res.writeHead(answer.status ?? 200, {
        'content-type': 'application/json',
        ...(answer.headers ?? {}),
      })
      res.end(answer.body === undefined ? '' : JSON.stringify(answer.body))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const fake: FakeGithub = {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    requestsTo: (path: string) => requests.filter(request => request.path === path),
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
  openServers.push(fake)
  return fake
}

// ---------------------------------------------------------------------------
// In-memory SourceContext
// ---------------------------------------------------------------------------

type Disposition = 'stored' | 'duplicate' | 'filtered' | 'failed'

interface TestContext {
  ctx: SourceContext
  triggers: Trigger[]
  health: SourceHealth[]
  kv: Map<string, unknown>
}

interface TestContextOptions {
  /** Override the Engine answer; `undefined` falls back to normal dedupe. */
  receive?: (trigger: Trigger) => Disposition | undefined
}

function makeContext(id = 'github', options: TestContextOptions = {}): TestContext {
  const kv = new Map<string, unknown>()
  const triggers: Trigger[] = []
  const health: SourceHealth[] = []
  const seen = new Set<string>()
  let counter = 0
  const logger: SourceLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }
  const receive = (trigger: Trigger): Disposition => {
    const forced = options.receive?.(trigger)
    if (forced && forced !== 'stored') return forced
    if (seen.has(trigger.id)) return 'duplicate'
    seen.add(trigger.id)
    triggers.push(trigger)
    return 'stored'
  }
  const ctx = {
    id,
    stateDir: '/tmp/superagent-sources-test',
    now: () => new Date().toISOString(),
    newId: (prefix: string) => `${prefix}-${(counter += 1)}`,
    receive,
    logger,
    health: (entry: SourceHealth) => {
      health.push(entry)
    },
    kv: {
      get: <T,>(key: string) => kv.get(key) as T | undefined,
      set: <T,>(key: string, value: T) => {
        kv.set(key, value)
      },
      delete: (key: string) => {
        kv.delete(key)
      },
      keys: (prefix = '') => [...kv.keys()].filter(key => key.startsWith(prefix)),
    },
  } as SourceContext
  return { ctx, triggers, health, kv }
}

const signal = (): AbortSignal => new AbortController().signal

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

function makeIssue(number: number, overrides: Partial<GithubIssue> = {}): GithubIssue {
  const at = iso()
  return {
    number,
    title: `Issue ${number}`,
    body: 'please fix this',
    state: 'open',
    created_at: at,
    updated_at: at,
    user: { login: 'alice', id: 1, type: 'User' },
    html_url: `https://github.com/o/r/issues/${number}`,
    ...overrides,
  }
}

function makeComment(id: number, overrides: Partial<GithubComment> = {}): GithubComment {
  const at = iso()
  return {
    id,
    body: 'a comment',
    user: { login: 'alice', id: 1, type: 'User' },
    created_at: at,
    updated_at: at,
    issue_url: 'https://api.github.com/repos/o/r/issues/12',
    html_url: 'https://github.com/o/r/issues/12#issuecomment-1',
    ...overrides,
  }
}

function makePull(number: number, overrides: Partial<GithubPullRequest> = {}): GithubPullRequest {
  const at = iso()
  return {
    number,
    title: `PR ${number}`,
    body: 'please review',
    state: 'open',
    created_at: at,
    updated_at: at,
    user: { login: 'alice', id: 1, type: 'User' },
    html_url: `https://github.com/o/r/pull/${number}`,
    head: { ref: `feature-${number}`, sha: 'headsha' },
    base: { ref: 'main', sha: 'basesha' },
    ...overrides,
  }
}

function makeReview(id: number, overrides: Partial<GithubReview> = {}): GithubReview {
  return {
    id,
    user: { login: 'alice', id: 1, type: 'User' },
    state: 'COMMENTED',
    body: 'nit',
    submitted_at: iso(),
    ...overrides,
  }
}

function repoFixture(index: number): Record<string, unknown> {
  return {
    id: index,
    full_name: `owner/repo-${index}`,
    name: `repo-${index}`,
    owner: { login: 'owner' },
    default_branch: 'main',
    private: index % 2 === 0,
    archived: index % 50 === 0,
    fork: index % 3 === 0,
    pushed_at: iso(-index * 1000),
    html_url: `https://github.com/owner/repo-${index}`,
  }
}

function repoRange(from: number, to: number): Array<Record<string, unknown>> {
  return Array.from({ length: to - from + 1 }, (_, offset) => repoFixture(from + offset))
}

function checkRun(name: string, conclusion: string | null, status = 'completed'): GithubCheckRun {
  return { id: Math.floor(Math.random() * 1e6), name, status, conclusion, head_sha: 'deadbeef' }
}

function workflowRun(name: string, conclusion: string | null): GithubWorkflowRun {
  return { id: Math.floor(Math.random() * 1e6), name, status: 'completed', conclusion, head_sha: 'deadbeef' }
}

/** Handler for every stream the Source polls, returning empty lists by default. */
function emptyStreams(request: GithubRequest, repo = 'o/r'): GithubAnswer | undefined {
  if (request.path === '/user') return { body: { login: 'agent', id: 9 } }
  if (request.method === 'GET' && request.path === `/repos/${repo}`) {
    return { body: { full_name: repo, name: 'r', owner: { login: 'o' }, default_branch: 'main' } }
  }
  if (request.method === 'GET' && request.path === `/repos/${repo}/issues`) return { body: [] }
  if (request.method === 'GET' && request.path === `/repos/${repo}/pulls`) return { body: [] }
  if (request.method === 'GET' && request.path === `/repos/${repo}/issues/comments`) return { body: [] }
  if (request.method === 'GET' && request.path === `/repos/${repo}/pulls/comments`) return { body: [] }
  if (request.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/.test(request.path)) {
    return { body: [] }
  }
  if (request.method === 'GET' && /\/commits\/[^/]+\/check-runs$/.test(request.path)) {
    return { body: { total_count: 0, check_runs: [] } }
  }
  if (request.method === 'GET' && /\/actions\/runs$/.test(request.path)) {
    return { body: { total_count: 0, workflow_runs: [] } }
  }
  return undefined
}

function baseConfig(url: string, overrides: Partial<GithubConfig> = {}): GithubConfig {
  return { apiBaseUrl: url, repositories: ['o/r'], login: 'agent', pollSeconds: 10, ...overrides }
}

// ---------------------------------------------------------------------------
// Cursors, idempotency, ETag, pagination
// ---------------------------------------------------------------------------

describe('github source: cursors and translation', () => {
  it('polls a deterministic window, persists the cursor and stays idempotent on replay', async () => {
    const issues: GithubIssue[] = []
    const fake = await startGithub(request => {
      if (request.path === '/repos/o/r/issues') {
        const since = request.query.get('since') ?? '1970-01-01T00:00:00.000Z'
        return { body: issues.filter(issue => Date.parse(issue.updated_at) >= Date.parse(since)) }
      }
      return emptyStreams(request)
    })
    const { ctx, triggers, kv } = makeContext()
    const source = createSource(baseConfig(fake.url, { observeIssues: true }), ctx) as GithubSource

    const first = await source.pollOnce(signal())
    expect(first).toMatchObject({ repos: 1, emitted: 0, errors: [] })
    expect(triggers).toHaveLength(0)
    const stored = kv.get('github:cursors:o/r') as { issues: { since: string } } | undefined
    expect(stored).toBeDefined()
    expect(Number.isFinite(Date.parse(stored!.issues.since))).toBe(true)

    issues.push(makeIssue(12, { body: 'please fix the build' }))
    const second = await source.pollOnce(signal())
    expect(second.emitted).toBe(1)
    expect(triggers).toHaveLength(1)
    const trigger = triggers[0]!
    expect(trigger.kind).toBe('issue')
    expect(trigger.thread.key).toBe('github:o/r#12')
    expect(trigger.addressed).toBe('none')
    expect(trigger.channel).toMatchObject({
      source: 'github',
      thread: 'github:o/r#12',
      to: 'o/r#12',
    })
    expect(trigger.actor).toMatchObject({ id: 'alice', bot: false })

    // The next window has moved past the creation time: no new Trigger.
    const third = await source.pollOnce(signal())
    expect(third.emitted).toBe(0)
    expect(triggers).toHaveLength(1)

    // Replaying the same window after a crash is deduplicated by Trigger id.
    kv.set('github:cursors:o/r', {
      ...stored!,
      issues: { since: '2020-01-01T00:00:00.000Z' },
    })
    const replay = await source.pollOnce(signal())
    expect(replay.emitted).toBe(0)
    expect(triggers).toHaveLength(1)
  })

  it('follows Link: rel="next" pagination', async () => {
    const fake = await startGithub(request => {
      if (request.path === '/repos/o/r/issues') {
        if (request.query.get('page') === '2') return { body: [makeIssue(2)] }
        return {
          body: [makeIssue(1)],
          headers: {
            link: `<${fake.url}/repos/o/r/issues?per_page=100&page=2>; rel="next"`,
          },
        }
      }
      return emptyStreams(request)
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(baseConfig(fake.url, { observeIssues: true }), ctx) as GithubSource
    await source.pollOnce(signal())
    expect(triggers.map(trigger => trigger.thread.key)).toEqual(['github:o/r#1', 'github:o/r#2'])
  })

  it('keeps the cursor and retries the event when Engine.receive reports failed', async () => {
    const issues = [makeIssue(50, { body: 'must survive' })]
    const fake = await startGithub(request => {
      if (request.path === '/repos/o/r/issues') {
        const since = request.query.get('since') ?? '1970-01-01T00:00:00.000Z'
        return { body: issues.filter(issue => Date.parse(issue.updated_at) >= Date.parse(since)) }
      }
      return emptyStreams(request)
    })
    const forced: Array<'failed' | 'stored'> = ['failed', 'stored']
    const { ctx, triggers, kv } = makeContext('github', { receive: () => forced.shift() ?? 'stored' })
    const source = createSource(baseConfig(fake.url, { observeIssues: true }), ctx) as GithubSource

    const first = await source.pollOnce(signal())
    expect(first.errors).toHaveLength(1)
    expect(first.errors[0]).toContain('was not stored')
    expect(triggers).toHaveLength(0)
    const afterFailure = kv.get('github:cursors:o/r') as {
      startedAt: string
      issues: { since: string }
    }
    // The failed stream did not run `advance`: the cursor is still the initial one.
    expect(afterFailure.issues.since).toBe(afterFailure.startedAt)

    const second = await source.pollOnce(signal())
    expect(second.errors).toEqual([])
    expect(second.emitted).toBe(1)
    expect(triggers).toHaveLength(1)
    expect(triggers[0]!.id).toBe('github:issue:o/r#50')
    const afterRetry = kv.get('github:cursors:o/r') as { startedAt: string; issues: { since: string } }
    expect(Date.parse(afterRetry.issues.since)).toBeGreaterThanOrEqual(Date.parse(afterRetry.startedAt))
  })

  it('keeps the CI baseline when Engine.receive reports failed', async () => {
    let checks = [checkRun('build', 'failure')]
    const fake = await startGithub(request => {
      if (/\/commits\/main\/check-runs$/.test(request.path)) {
        return { body: { total_count: checks.length, check_runs: checks } }
      }
      return emptyStreams(request)
    })
    const forced: Array<'failed' | 'stored'> = ['failed', 'stored']
    const { ctx, triggers, kv } = makeContext('github', { receive: () => forced.shift() ?? 'stored' })
    const source = createSource(baseConfig(fake.url, { observeCi: true }), ctx) as GithubSource

    // First observation only establishes the baseline (no receive call).
    await source.pollOnce(signal())
    const baseline = kv.get('github:ci:o/r')

    checks = [checkRun('build', 'failure'), checkRun('test', 'failure')]
    const failed = await source.pollOnce(signal())
    expect(failed.errors).toHaveLength(1)
    expect(kv.get('github:ci:o/r')).toEqual(baseline)
    expect(triggers).toHaveLength(0)

    const retried = await source.pollOnce(signal())
    expect(retried.errors).toEqual([])
    expect(triggers).toHaveLength(1)
    expect(triggers[0]!.kind).toBe('ci')
  })

  it('uses ETag/If-None-Match and treats 304 as "nothing changed"', async () => {
    const fake = await startGithub(request => {
      if (request.path === '/repos/o/r/issues') {
        if (request.headers['if-none-match'] === '"etag-1"') return { status: 304 }
        return { body: [], headers: { etag: '"etag-1"' } }
      }
      return emptyStreams(request)
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(baseConfig(fake.url), ctx) as GithubSource

    await source.pollOnce(signal())
    const second = await source.pollOnce(signal())

    expect(second.errors).toEqual([])
    expect(triggers).toHaveLength(0)
    const conditional = fake
      .requestsTo('/repos/o/r/issues')
      .filter(request => request.headers['if-none-match'] === '"etag-1"')
    expect(conditional.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Filtering and mention detection
// ---------------------------------------------------------------------------

describe('github source: filters', () => {
  it('filters self, unknown bots and disallowed logins, and marks @mentions', async () => {
    const comments: GithubComment[] = []
    const fake = await startGithub(request => {
      if (request.path === '/repos/o/r/issues/comments') {
        const since = request.query.get('since') ?? '1970-01-01T00:00:00.000Z'
        return { body: comments.filter(comment => Date.parse(comment.updated_at ?? '') >= Date.parse(since)) }
      }
      return emptyStreams(request)
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(
      baseConfig(fake.url, {
        allowedLogins: ['alice'],
        botLogins: ['dependabot[bot]'],
        observeComments: true,
      }),
      ctx,
    ) as GithubSource
    await source.pollOnce(signal())

    comments.push(
      makeComment(1, { body: 'unaddressed from an allowed person' }),
      makeComment(2, { body: 'unaddressed from a stranger', user: { login: 'bob', id: 2, type: 'User' } }),
      makeComment(3, { body: 'the agent being noisy', user: { login: 'agent', id: 9, type: 'User' } }),
      makeComment(4, {
        body: 'bump @agent please',
        user: { login: 'dependabot[bot]', id: 5, type: 'Bot' },
        issue_url: 'https://api.github.com/repos/o/r/issues/13',
        html_url: 'https://github.com/o/r/issues/13#issuecomment-4',
      }),
      makeComment(5, {
        body: '@agent help',
        user: { login: 'evil[bot]', id: 6, type: 'Bot' },
      }),
    )
    const result = await source.pollOnce(signal())

    expect(result.errors).toEqual([])
    expect(triggers).toHaveLength(2)
    expect(triggers.map(trigger => trigger.actor.id)).toEqual(['alice', 'dependabot[bot]'])
    expect(triggers.map(trigger => trigger.addressed)).toEqual(['none', 'mention'])
    expect(triggers[1]!.thread.key).toBe('github:o/r#13')
    expect(triggers[1]!.kind).toBe('comment')
    expect(result.filtered).toBe(3)
  })

  it('filters the login account by default (allowSelf=false), even for mentions', async () => {
    const comments: GithubComment[] = [
      makeComment(70, { body: '@agent please fix this', user: { login: 'agent', id: 9, type: 'User' } }),
    ]
    const fake = await startGithub(request => {
      if (request.path === '/repos/o/r/issues/comments') {
        const since = request.query.get('since') ?? '1970-01-01T00:00:00.000Z'
        return { body: comments.filter(comment => Date.parse(comment.updated_at ?? '') >= Date.parse(since)) }
      }
      return emptyStreams(request)
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(baseConfig(fake.url, { observeComments: true }), ctx) as GithubSource

    await source.pollOnce(signal())
    comments.push(makeComment(71, {
      body: '@agent please fix the build',
      user: { login: 'agent', id: 9, type: 'User' },
    }))
    const result = await source.pollOnce(signal())

    expect(result.errors).toEqual([])
    expect(triggers).toHaveLength(0)
    expect(result.filtered).toBeGreaterThanOrEqual(1)
  })

  it('admits the login account own comments when allowSelf is on, but drops marked agent output', async () => {
    const comments: GithubComment[] = []
    const fake = await startGithub(request => {
      if (request.path === '/repos/o/r/issues/comments') {
        const since = request.query.get('since') ?? '1970-01-01T00:00:00.000Z'
        return { body: comments.filter(comment => Date.parse(comment.updated_at ?? '') >= Date.parse(since)) }
      }
      return emptyStreams(request)
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(
      baseConfig(fake.url, { allowSelf: true, allowedLogins: ['alice'], observeComments: false }),
      ctx,
    ) as GithubSource
    await source.pollOnce(signal())

    comments.push(
      // The user writing through their own account: a plain @mention is work.
      makeComment(80, { body: '@agent please run the tests', user: { login: 'agent', id: 9, type: 'User' } }),
      // The agent's own reply: carries the hidden marker and must never loop.
      makeComment(81, {
        body: 'done <!-- superagent:msg_42 --> @agent',
        user: { login: 'agent', id: 9, type: 'User' },
      }),
      // Someone else quoting the marker is not the agent's output.
      makeComment(82, { body: 'quoted <!-- superagent:msg_43 --> hi @agent', user: { login: 'alice', id: 1, type: 'User' } }),
    )
    const result = await source.pollOnce(signal())

    expect(result.errors).toEqual([])
    expect(triggers.map(trigger => trigger.id)).toEqual([
      'github:comment:o/r:80:' + (comments[0]!.updated_at ?? ''),
      'github:comment:o/r:82:' + (comments[2]!.updated_at ?? ''),
    ])
    expect(triggers.map(trigger => trigger.actor.id)).toEqual(['agent', 'alice'])
    expect(triggers.every(trigger => trigger.addressed === 'mention')).toBe(true)
  })

  it('admits an Issue only when addressed unless observeIssues is on', async () => {
    const issues: GithubIssue[] = []
    const fake = await startGithub(request => {
      if (request.path === '/repos/o/r/issues') {
        const since = request.query.get('since') ?? '1970-01-01T00:00:00.000Z'
        return { body: issues.filter(issue => Date.parse(issue.updated_at) >= Date.parse(since)) }
      }
      return emptyStreams(request)
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(baseConfig(fake.url), ctx) as GithubSource
    await source.pollOnce(signal())
    issues.push(
      makeIssue(20, { body: 'no mention here' }),
      makeIssue(21, { body: 'hi @agent please look' }),
    )
    await source.pollOnce(signal())
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatchObject({ kind: 'issue', addressed: 'mention' })
    expect(triggers[0]!.thread.key).toBe('github:o/r#21')
  })
})

// ---------------------------------------------------------------------------
// Pull request lifecycle
// ---------------------------------------------------------------------------

describe('github source: pull request lifecycle', () => {
  it('notifies pullOpened and threadClosed once per PR', async () => {
    let pulls: GithubPullRequest[] = []
    const opened: GithubPullInfo[] = []
    const closed: Array<{ thread: string; outcome: string }> = []
    const callbacks: GithubCallbacks = {
      pullOpened: pull => {
        opened.push(pull)
      },
      threadClosed: (thread, outcome) => {
        closed.push({ thread, outcome })
      },
    }
    const fake = await startGithub(request => {
      if (request.path === '/repos/o/r/pulls') return { body: pulls }
      return emptyStreams(request)
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(baseConfig(fake.url, { observePulls: true, callbacks }), ctx) as GithubSource
    await source.pollOnce(signal())

    pulls = [makePull(30)]
    await source.pollOnce(signal())
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ repo: 'o/r', number: 30, head: 'feature-30' })
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatchObject({ kind: 'pull', thread: { key: 'github:o/r#30' } })

    pulls = [makePull(30, { state: 'closed', merged: true, merged_at: iso() })]
    const third = await source.pollOnce(signal())
    expect(closed).toEqual([{ thread: 'github:o/r#30', outcome: 'merged' }])
    expect(triggers).toHaveLength(1)
    expect(third.emitted).toBe(0)

    // A PR the agent opened itself notifies the runtime (for binding) but never
    // becomes a Trigger.
    pulls = [makePull(31, { user: { login: 'agent', id: 9, type: 'User' } })]
    await source.pollOnce(signal())
    expect(opened.map(pull => pull.number)).toEqual([30, 31])
    expect(triggers).toHaveLength(1)
    expect(closed).toHaveLength(1)
  })

  it('does not repeat pullOpened when the pull Trigger failed to store and is retried', async () => {
    let pulls: GithubPullRequest[] = []
    const opened: GithubPullInfo[] = []
    const fake = await startGithub(request => {
      if (request.path === '/repos/o/r/pulls') return { body: pulls }
      return emptyStreams(request)
    })
    const forced: Array<'failed' | 'stored'> = ['failed', 'stored']
    const { ctx, triggers, kv } = makeContext('github', { receive: () => forced.shift() ?? 'stored' })
    const source = createSource(
      baseConfig(fake.url, { observePulls: true, callbacks: { pullOpened: pull => opened.push(pull) } }),
      ctx,
    ) as GithubSource
    await source.pollOnce(signal())

    pulls = [makePull(60)]
    const failed = await source.pollOnce(signal())
    expect(failed.errors).toHaveLength(1)
    expect(opened).toHaveLength(1)
    expect(triggers).toHaveLength(0)
    // The lifecycle decision is persisted even though the Trigger was not.
    expect(kv.get('github:pulls:o/r')).toMatchObject({ 60: { state: 'open' } })

    const retried = await source.pollOnce(signal())
    expect(retried.errors).toEqual([])
    expect(retried.emitted).toBe(1)
    expect(opened).toHaveLength(1)
    expect(triggers).toHaveLength(1)
    expect(triggers[0]!.id).toBe('github:pull:o/r#60')
  })

  it('admits the login account own PRs when allowSelf is on, but drops marked agent PRs', async () => {
    let pulls: GithubPullRequest[] = []
    const opened: GithubPullInfo[] = []
    const fake = await startGithub(request => {
      if (request.path === '/repos/o/r/pulls') return { body: pulls }
      return emptyStreams(request)
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(
      baseConfig(fake.url, { allowSelf: true, callbacks: { pullOpened: pull => opened.push(pull) } }),
      ctx,
    ) as GithubSource
    await source.pollOnce(signal())

    pulls = [
      makePull(90, {
        body: '@agent please review this',
        user: { login: 'agent', id: 9, type: 'User' },
      }),
      makePull(91, {
        body: 'automated change <!-- superagent:pr -->',
        user: { login: 'agent', id: 9, type: 'User' },
      }),
    ]
    const second = await source.pollOnce(signal())

    expect(second.errors).toEqual([])
    // Both PRs are lifecycle-notified (binding may still be needed), but only
    // the unmarked user PR becomes a Trigger.
    expect(opened.map(pull => pull.number)).toEqual([90, 91])
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatchObject({ kind: 'pull', thread: { key: 'github:o/r#90' }, addressed: 'mention' })

    const third = await source.pollOnce(signal())
    expect(third.emitted).toBe(0)
    expect(opened).toHaveLength(2)
    expect(triggers).toHaveLength(1)
  })

  it('needs the observeComments switch for unaddressed reviews', async () => {
    let reviews: GithubReview[] = []
    const fake = await startGithub(request => {
      if (request.path === '/repos/o/r/pulls') return { body: [makePull(40)] }
      if (request.path === '/repos/o/r/pulls/40/reviews') return { body: reviews }
      return emptyStreams(request)
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(baseConfig(fake.url, { observeComments: false }), ctx) as GithubSource
    await source.pollOnce(signal())
    reviews = [makeReview(100, { body: 'looks fine' }), makeReview(101, { body: '@agent please change', state: 'CHANGES_REQUESTED' })]
    await source.pollOnce(signal())
    expect(triggers.map(trigger => [trigger.kind, trigger.addressed])).toEqual([['review', 'mention']])

    const other = makeContext()
    const observing = createSource(baseConfig(fake.url, { observeComments: true }), other.ctx) as GithubSource
    await observing.pollOnce(signal())
    const reviewTriggers = other.triggers.filter(trigger => trigger.kind === 'review')
    expect(reviewTriggers.map(trigger => trigger.addressed)).toEqual(['none', 'mention'])
  })
})

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

describe('github source: CI', () => {
  it('falls back to Actions workflow runs when check-runs are denied (403)', async () => {
    let workflowRuns: GithubWorkflowRun[] = [workflowRun('ci-build', 'failure')]
    const fake = await startGithub(request => {
      if (/\/commits\/main\/check-runs$/.test(request.path)) {
        return { status: 403, body: { message: 'Resource not accessible by integration' } }
      }
      if (/\/actions\/runs$/.test(request.path)) {
        return { body: { total_count: workflowRuns.length, workflow_runs: workflowRuns } }
      }
      return emptyStreams(request)
    })
    const { ctx, triggers, kv } = makeContext()
    const source = createSource(baseConfig(fake.url, { observeCi: true }), ctx) as GithubSource

    const first = await source.pollOnce(signal())
    expect(first.errors).toEqual([])
    // Actions runs populated the baseline even though check-runs was denied.
    expect(kv.get('github:ci:o/r')).toMatchObject({ failing: ['ci-build'] })
    expect(triggers).toHaveLength(0)

    workflowRuns = [workflowRun('ci-build', 'failure'), workflowRun('ci-test', 'failure')]
    const second = await source.pollOnce(signal())
    expect(second.errors).toEqual([])
    expect(second.emitted).toBe(1)
    expect(triggers[0]!.kind).toBe('ci')
    expect(triggers[0]!.text).toContain('ci-test')
  })

  it('falls back to Actions workflow runs when check-runs do not exist (404)', async () => {
    const fake = await startGithub(request => {
      if (/\/commits\/main\/check-runs$/.test(request.path)) {
        return { status: 404, body: { message: 'Not Found' } }
      }
      if (/\/actions\/runs$/.test(request.path)) {
        return { body: { total_count: 1, workflow_runs: [workflowRun('ci-deploy', 'failure')] } }
      }
      return emptyStreams(request)
    })
    const { ctx, triggers, kv } = makeContext()
    const source = createSource(baseConfig(fake.url, { observeCi: true }), ctx) as GithubSource

    const first = await source.pollOnce(signal())
    expect(first.errors).toEqual([])
    expect(kv.get('github:ci:o/r')).toMatchObject({ failing: ['ci-deploy'] })
    expect(triggers).toHaveLength(0)
  })

  it('falls back to check-runs when Actions workflow runs are denied (403)', async () => {
    let checks: GithubCheckRun[] = [checkRun('unit-tests', 'failure')]
    const fake = await startGithub(request => {
      if (/\/commits\/main\/check-runs$/.test(request.path)) {
        return { body: { total_count: checks.length, check_runs: checks } }
      }
      if (/\/actions\/runs$/.test(request.path)) {
        return { status: 403, body: { message: 'Resource not accessible by integration' } }
      }
      return emptyStreams(request)
    })
    const { ctx, triggers, kv } = makeContext()
    const source = createSource(baseConfig(fake.url, { observeCi: true }), ctx) as GithubSource

    const first = await source.pollOnce(signal())
    expect(first.errors).toEqual([])
    expect(kv.get('github:ci:o/r')).toMatchObject({ failing: ['unit-tests'] })
    expect(triggers).toHaveLength(0)

    checks = [checkRun('unit-tests', 'failure'), checkRun('lint', 'failure')]
    const second = await source.pollOnce(signal())
    expect(second.errors).toEqual([])
    expect(second.emitted).toBe(1)
    expect(triggers[0]!.text).toContain('lint')
  })

  it('reports one actionable permission error when both CI sources are denied', async () => {
    const fake = await startGithub(request => {
      if (/\/commits\/main\/check-runs$/.test(request.path)) {
        return { status: 403, body: { message: 'Resource not accessible by integration' } }
      }
      if (/\/actions\/runs$/.test(request.path)) {
        return { status: 403, body: { message: 'Resource not accessible by integration' } }
      }
      return emptyStreams(request)
    })
    const { ctx, triggers, kv } = makeContext()
    const source = createSource(baseConfig(fake.url, { observeCi: true }), ctx) as GithubSource

    const first = await source.pollOnce(signal())
    expect(first.errors).toHaveLength(1)
    expect(first.errors[0]).toMatch(/CI needs Actions: Read \(or Checks: Read\)/)
    expect(first.errors[0]).toContain('o/r')
    expect(first.errors[0]).not.toContain('test-token-not-a-secret')
    expect(kv.get('github:ci:o/r')).toBeUndefined()
    expect(triggers).toHaveLength(0)

    // Repeated polls keep reporting exactly one concise error per repository.
    const second = await source.pollOnce(signal())
    expect(second.errors).toHaveLength(1)
    expect(second.errors[0]).toMatch(/CI needs Actions: Read \(or Checks: Read\)/)
  })

  it('emits a ci Trigger when the default-branch failure set changes, then on recovery', async () => {
    let checks: GithubCheckRun[] = [checkRun('build', 'failure')]
    const fake = await startGithub(request => {
      if (/\/commits\/main\/check-runs$/.test(request.path)) {
        return { body: { total_count: checks.length, check_runs: checks } }
      }
      return emptyStreams(request)
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(baseConfig(fake.url, { observeCi: true }), ctx) as GithubSource

    // The first observation only establishes a baseline.
    await source.pollOnce(signal())
    expect(triggers).toHaveLength(0)

    checks = [checkRun('build', 'failure'), checkRun('test', 'failure')]
    const second = await source.pollOnce(signal())
    expect(second.emitted).toBe(1)
    const trigger = triggers[0]!
    expect(trigger.kind).toBe('ci')
    expect(trigger.addressed).toBe('ci')
    expect(trigger.thread.key).toBe('github:o/r#ci:main')
    expect(trigger.text).toContain('test')
    expect(trigger.channel.to).toBe('o/r#ci')
    expect(trigger.actor).toMatchObject({ bot: true })

    // Unchanged CI produces nothing.
    const third = await source.pollOnce(signal())
    expect(third.emitted).toBe(0)
    expect(triggers).toHaveLength(1)

    checks = [checkRun('build', 'success'), checkRun('test', 'success')]
    await source.pollOnce(signal())
    expect(triggers).toHaveLength(2)
    expect(triggers[1]!.text).toContain('recovered')
  })
})

// ---------------------------------------------------------------------------
// Sending and allowlists
// ---------------------------------------------------------------------------

describe('github source: sending', () => {
  it('posts issue comments idempotently and checks repository/channel allowlists', async () => {
    const posted: GithubComment[] = []
    let posts = 0
    const fake = await startGithub(request => {
      if (request.path === '/repos/o/r/issues/12/comments') {
        if (request.method === 'POST') {
          posts += 1
          const comment: GithubComment = {
            id: posted.length + 1,
            body: String(request.body.body ?? ''),
            user: { login: 'agent', id: 9, type: 'User' },
            created_at: iso(),
          }
          posted.push(comment)
          return { status: 201, body: comment }
        }
        return { body: posted }
      }
      return emptyStreams(request)
    })
    const { ctx } = makeContext()
    const source = createSource(baseConfig(fake.url), ctx) as GithubSource
    const message = {
      id: 'message-1',
      purpose: 'answer' as const,
      channel: { source: 'github', thread: 'github:o/r#12', to: 'o/r#12' },
      text: 'here is the update',
      at: iso(),
    }

    expect(await source.send(message)).toBe('sent')
    expect(posts).toBe(1)
    expect(posted[0]!.body).toContain('here is the update')
    expect(posted[0]!.body).toContain('superagent:message-1')

    // A retry after a crash finds the hidden marker and does not post twice.
    expect(await source.send(message)).toBe('sent')
    expect(posts).toBe(1)

    expect(source.channelAllowed({ source: 'github', thread: 'github:o/r#12', to: 'o/r#12' })).toBe(true)
    expect(source.channelAllowed({ source: 'github', thread: 'github:x/y#1', to: 'x/y#1' })).toBe(false)
    expect(source.channelAllowed({ source: 'github', thread: 'github:o/r#ci:main', to: 'o/r#ci' })).toBe(false)
    expect(source.channelAllowed({ source: 'telegram', thread: 'telegram:dm:1', to: '1' })).toBe(false)
    expect(parseCommentTarget('o/r#12')).toEqual({ repo: 'o/r', number: 12 })
    expect(parseCommentTarget('o/r#ci:main')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Client behaviour and loop resilience
// ---------------------------------------------------------------------------

describe('github api client', () => {
  it('marks pull request bodies it creates exactly once', async () => {
    const fake = await startGithub(request => {
      if (request.method === 'POST' && request.path === '/repos/o/r/pulls') {
        return { status: 201, body: makePull(99, { body: String(request.body.body ?? '') }) }
      }
      return undefined
    })
    const api = new GithubApi({ token: 'token', baseUrl: fake.url })

    await api.createPullRequest('o/r', { title: 'fix', head: 'agent/t_1', base: 'main', body: 'fix the build' })
    const first = fake.requestsTo('/repos/o/r/pulls').at(-1)!
    expect(String(first.body.body)).toBe('fix the build\n\n<!-- superagent:pr -->')

    // A body that already carries a marker is not marked twice.
    await api.createPullRequest('o/r', {
      title: 'fix 2',
      head: 'agent/t_2',
      base: 'main',
      body: 'change <!-- superagent:custom -->',
    })
    const second = fake.requestsTo('/repos/o/r/pulls').at(-1)!
    expect(String(second.body.body)).toBe('change <!-- superagent:custom -->')
  })

  it('never leaks the token in errors', async () => {
    const fake = await startGithub(request => {
      if (request.path === '/repos/o/secret') {
        return { status: 401, body: { message: 'Bad credentials' } }
      }
      return undefined
    })
    const api = new GithubApi({ token: 'super-secret-token', baseUrl: fake.url, maxAttempts: 1 })
    await expect(api.getRepo('o/secret')).rejects.toThrow(/401/)
    try {
      await api.getRepo('o/secret')
      expect.unreachable()
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-token')
    }
    // A missing repo is `null`, not an error.
    await expect(api.getRepo('o/missing')).resolves.toBeNull()
  })

  it('retries a rate-limited 403 honoring the reset header', async () => {
    let calls = 0
    const fake = await startGithub(request => {
      if (request.path === '/repos/o/r/issues') {
        calls += 1
        if (calls === 1) {
          return {
            status: 403,
            headers: {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(Math.floor(Date.now() / 1000)),
            },
            body: { message: 'API rate limit exceeded' },
          }
        }
        return { body: [makeIssue(1)] }
      }
      return undefined
    })
    const api = new GithubApi({ token: 'token', baseUrl: fake.url, maxAttempts: 3, baseDelayMs: 10 })
    const page = await api.listIssuesUpdatedSince('o/r', iso(-60_000))
    expect(calls).toBe(2)
    expect(page.items).toHaveLength(1)
  })

  it('reads a token from a file or an environment variable without logging it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'superagent-github-token-'))
    const file = join(dir, 'token')
    try {
      await writeFile(file, '  file-token-value \n', 'utf8')
      const fromFile = createGithubTokenProvider({ tokenFile: file })
      expect(await fromFile()).toBe('file-token-value')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }

    process.env.SUPERAGENT_TEST_GH_TOKEN = ' env-token-value '
    try {
      const fromEnv = createGithubTokenProvider({ tokenEnv: 'SUPERAGENT_TEST_GH_TOKEN' })
      expect(await fromEnv()).toBe('env-token-value')
    } finally {
      delete process.env.SUPERAGENT_TEST_GH_TOKEN
    }

    const missing = createGithubTokenProvider({ tokenEnv: 'SUPERAGENT_TEST_GH_MISSING' })
    await expect(missing()).rejects.toThrow(/SUPERAGENT_TEST_GH_MISSING/)
    try {
      await missing()
      expect.unreachable()
    } catch (error) {
      expect(String(error)).not.toContain('test-token-not-a-secret')
    }
  })

  it('reports a repository read failure as an error without throwing out of pollOnce', async () => {
    const fake = await startGithub(request => {
      if (request.path === '/repos/o/r/issues') {
        return { status: 403, body: { message: 'Resource not accessible by integration' } }
      }
      return emptyStreams(request)
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(baseConfig(fake.url), ctx) as GithubSource
    const result = await source.pollOnce(signal())
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('o/r')
    expect(triggers).toHaveLength(0)
    expect(source.healthState()).toBe('off')
  })
})

describe('github source: loop resilience', () => {
  it('turns a missing token into health instead of an unhandled rejection', async () => {
    const { ctx, health } = makeContext()
    const source = createSource(
      {
        tokenEnv: 'SUPERAGENT_TEST_MISSING_GH_TOKEN_XYZ',
        repositories: ['o/r'],
        login: 'agent',
        pollSeconds: 10,
      },
      ctx,
    ) as GithubSource
    await source.start()
    await waitFor(() =>
      health.some(entry => (entry.detail ?? '').includes('SUPERAGENT_TEST_MISSING_GH_TOKEN_XYZ')),
    )
    await source.stop()
    expect(source.healthState()).toBe('off')
  })

  it('starts and stops cleanly against a healthy fake server', async () => {
    const fake = await startGithub(request => emptyStreams(request))
    const { ctx, health } = makeContext()
    const source = createSource(baseConfig(fake.url), ctx) as GithubSource
    await source.start()
    await waitFor(() => health.some(entry => entry.state === 'ready'))
    await source.stop()
    expect(source.healthState()).toBe('off')
  })
})

describe('github setup helpers (stateless token validation and repository discovery)', () => {
  const TOKEN = 'ghp_fake_setup_token_not_a_secret'

  it('validates a working token and returns login/id', async () => {
    const fake = await startGithub(request => {
      if (request.path === '/user') return { body: { login: 'setup-agent', id: 9 } }
      return undefined
    })
    await expect(validateGithubToken(TOKEN, { apiBaseUrl: fake.url, timeoutMs: 1_000 })).resolves.toEqual({
      ok: true,
      login: 'setup-agent',
      id: 9,
    })
  })

  it('reports a 401 without leaking the token', async () => {
    const fake = await startGithub(request => {
      if (request.path === '/user') return { status: 401, body: { message: 'Bad credentials' } }
      return undefined
    })
    let error: unknown
    try {
      await validateGithubToken(TOKEN, { apiBaseUrl: fake.url, timeoutMs: 1_000 })
      expect.unreachable()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(GithubTokenValidationError)
    expect(String(error)).toContain('HTTP 401')
    expect(String(error)).toContain('Bad credentials')
    expect(String(error)).not.toContain(TOKEN)
  })

  it('reports a rate-limited 403 readably without leaking the token', async () => {
    const fake = await startGithub(request => {
      if (request.path === '/user') {
        return {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000)),
          },
          body: { message: 'API rate limit exceeded' },
        }
      }
      return undefined
    })
    let error: unknown
    try {
      await validateGithubToken(TOKEN, { apiBaseUrl: fake.url, timeoutMs: 1_000 })
      expect.unreachable()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(GithubTokenValidationError)
    expect(String(error)).toContain('HTTP 403')
    expect(String(error)).toContain('rate limit')
    expect(String(error)).not.toContain(TOKEN)
  })

  it('reports a timeout without leaking the token', async () => {
    const fake = await startGithub(request => {
      if (request.path === '/user') return { pending: true }
      return undefined
    })
    const started = Date.now()
    let error: unknown
    try {
      await validateGithubToken(TOKEN, { apiBaseUrl: fake.url, timeoutMs: 1_000 })
      expect.unreachable()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(GithubTokenValidationError)
    expect(String(error)).toMatch(/timeout/i)
    expect(String(error)).not.toContain(TOKEN)
    expect(Date.now() - started).toBeLessThan(6_000)
  })

  it('pages through repositories, caps at 200 and maps the summary fields', async () => {
    const fake = await startGithub(request => {
      if (request.path !== '/user/repos') return undefined
      const page = Number(request.query.get('page') ?? '1')
      if (page === 1) {
        return {
          body: repoRange(1, 100),
          headers: { link: `<${fake.url}/user/repos?per_page=100&page=2>; rel="next"` },
        }
      }
      if (page === 2) {
        return {
          body: repoRange(101, 200),
          headers: { link: `<${fake.url}/user/repos?per_page=100&page=3>; rel="next"` },
        }
      }
      return { body: repoRange(201, 300) }
    })

    const repositories = await listGithubRepositories(TOKEN, { apiBaseUrl: fake.url, timeoutMs: 1_000 })

    expect(repositories).toHaveLength(200)
    expect(repositories[0]).toEqual({
      fullName: 'owner/repo-1',
      private: false,
      pushedAt: expect.any(String),
      archived: false,
      fork: false,
    })
    expect(repositories[199]).toMatchObject({ fullName: 'owner/repo-200', private: true, archived: true })
    // The third page exists but must not be requested: the cap is 200.
    const thirdPage = fake
      .requestsTo('/user/repos')
      .filter(request => request.query.get('page') === '3')
    expect(thirdPage).toHaveLength(0)
  })

  it('reports a 403 while listing repositories readably without leaking the token', async () => {
    const fake = await startGithub(request => {
      if (request.path === '/user/repos') {
        return {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000)),
          },
          body: { message: 'API rate limit exceeded' },
        }
      }
      return undefined
    })
    let error: unknown
    try {
      await listGithubRepositories(TOKEN, { apiBaseUrl: fake.url, timeoutMs: 1_000 })
      expect.unreachable()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(GithubApiError)
    expect(String(error)).toContain('403')
    expect(String(error)).toContain('rate limit')
    expect(String(error)).not.toContain(TOKEN)
  })
})
