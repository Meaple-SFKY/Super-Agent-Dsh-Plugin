/**
 * Minimal GitHub REST client over the built-in `fetch`.
 *
 * Used by the GitHub Source and reusable by the GitHub tools. Design points:
 * - conditional requests with `ETag`/`If-None-Match` (304 is a normal, cheap
 *   "nothing changed" answer);
 * - `Link: rel="next"` pagination with a hard page cap so one poll stays
 *   token-efficient;
 * - 403 rate limiting (primary and secondary) and 429 honor `Retry-After` /
 *   `X-RateLimit-Reset`, 5xx and network errors use exponential backoff;
 * - 404 is returned as `null` from optional reads instead of throwing, and all
 *   errors are descriptive but never contain the token.
 */

import { readFile } from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Resolve once `ms` elapsed, or reject when `signal` aborts. Timers are unref'd. */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(abortError())
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = (): void => {
      cleanup()
      reject(abortError())
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** An Error whose `name` is `AbortError`, matching fetch/DOM conventions. */
export function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function moment(value: string | null | undefined): number {
  if (!value) return Number.NaN
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

/** Latest of some ISO timestamps, or undefined when none parse. */
export function latestTimestamp(values: Array<string | null | undefined>): string | undefined {
  let newest = Number.NaN
  for (const value of values) {
    const parsed = moment(value)
    if (Number.isFinite(parsed) && (!Number.isFinite(newest) || parsed > newest)) newest = parsed
  }
  return Number.isFinite(newest) ? new Date(newest).toISOString() : undefined
}

// ---------------------------------------------------------------------------
// Errors and token provider
// ---------------------------------------------------------------------------

/** A GitHub REST failure with enough context to decide whether to retry. */
export class GithubApiError extends Error {
  /** HTTP status; `0` means a network/transport failure. */
  readonly status: number
  readonly method: string
  /** Request path (no headers, no credentials). */
  readonly path: string
  readonly details?: string
  /** True when GitHub said (or implied) this is a rate-limit answer. */
  readonly rateLimited: boolean
  /** Suggested wait before retrying, when the response named one. */
  readonly retryAfterMs?: number

  constructor(input: {
    status: number
    method: string
    path: string
    details?: string
    rateLimited?: boolean
    retryAfterMs?: number
  }) {
    const detail = input.details ? `: ${input.details}` : ''
    super(`GitHub ${input.method} ${input.path} failed (HTTP ${input.status})${detail}`)
    this.name = 'GithubApiError'
    this.status = input.status
    this.method = input.method
    this.path = input.path
    if (input.details !== undefined) this.details = input.details
    this.rateLimited = input.rateLimited === true
    if (input.retryAfterMs !== undefined) this.retryAfterMs = input.retryAfterMs
  }
}

/** A token that could not be read. The message never contains the value. */
export class GithubTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GithubTokenError'
  }
}

export interface GithubTokenOptions {
  tokenEnv?: string
  tokenFile?: string
  defaultEnv?: string
}

/**
 * Build a lazy token provider. The token is read once and cached; read errors
 * are thrown as {@link GithubTokenError} with a value-free message. File wins
 * over environment variable.
 */
export function createGithubTokenProvider(options: GithubTokenOptions = {}): () => Promise<string> {
  const defaultEnv = options.defaultEnv ?? 'SUPERAGENT_GITHUB_TOKEN'
  let cached: string | undefined
  return async (): Promise<string> => {
    if (cached) return cached
    if (options.tokenFile) {
      let raw: string
      try {
        raw = await readFile(options.tokenFile, 'utf8')
      } catch (error) {
        throw new GithubTokenError(
          `GitHub token file could not be read (${options.tokenFile}): ${describeError(error)}`,
        )
      }
      const token = raw.trim()
      if (!token) throw new GithubTokenError(`GitHub token file is empty (${options.tokenFile})`)
      cached = token
      return token
    }
    const envName = options.tokenEnv?.trim() || defaultEnv
    const token = process.env[envName]?.trim()
    if (!token) {
      throw new GithubTokenError(
        `GitHub token is not set: configure tokenFile or set the environment variable ${envName}`,
      )
    }
    cached = token
    return token
  }
}

// ---------------------------------------------------------------------------
// REST types (only the fields this plugin reads)
// ---------------------------------------------------------------------------

export interface GithubUser {
  login: string
  id: number
  type?: string
  html_url?: string
}

export interface GithubRepo {
  full_name: string
  name: string
  owner: { login: string }
  default_branch: string
  private?: boolean
  html_url?: string
  archived?: boolean
  fork?: boolean
  pushed_at?: string | null
}

export interface GithubIssue {
  number: number
  title: string
  body?: string | null
  state: string
  created_at: string
  updated_at: string
  user: GithubUser
  html_url?: string
  labels?: Array<{ name?: string }>
  pull_request?: { url?: string; html_url?: string }
  [key: string]: unknown
}

export interface GithubComment {
  id: number
  body?: string | null
  user: GithubUser
  created_at: string
  updated_at?: string
  html_url?: string
  issue_url?: string
  pull_request_url?: string
  path?: string
  line?: number
  [key: string]: unknown
}

export interface GithubReview {
  id: number
  user: GithubUser
  state: string
  body?: string | null
  submitted_at?: string
  html_url?: string
  [key: string]: unknown
}

export interface GithubPullRequest {
  number: number
  title: string
  body?: string | null
  state: 'open' | 'closed'
  merged?: boolean
  merged_at?: string | null
  created_at: string
  updated_at: string
  user: GithubUser
  html_url?: string
  head: { ref: string; sha: string }
  base: { ref: string; sha: string }
  draft?: boolean
  [key: string]: unknown
}

export interface GithubCheckRun {
  id: number
  name: string
  status: string
  conclusion?: string | null
  head_sha?: string
  details_url?: string | null
  html_url?: string | null
  started_at?: string | null
  completed_at?: string | null
}

export interface GithubCheckRunsResponse {
  total_count: number
  check_runs: GithubCheckRun[]
}

export interface GithubWorkflowRun {
  id: number
  name?: string | null
  display_title?: string | null
  status: string
  conclusion?: string | null
  head_sha?: string
  html_url?: string | null
  created_at?: string
  updated_at?: string
}

export interface GithubWorkflowRunsResponse {
  total_count: number
  workflow_runs: GithubWorkflowRun[]
}

/** One list answer, with the metadata needed for conditional re-polling. */
export interface GithubPage<T> {
  items: T[]
  /** ETag of a single-page answer; only usable when the result fit one page. */
  etag?: string
  /** GitHub answered 304 to `If-None-Match`: nothing changed. */
  notModified: boolean
  /** A `Link: rel="next"` was present but the page cap stopped us. */
  truncated: boolean
}

export interface GithubResult<T> {
  data: T | null
  status: number
  notModified: boolean
  etag?: string
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface GithubApiOptions {
  /** Literal token or an async provider such as {@link createGithubTokenProvider}. */
  token: string | (() => Promise<string>)
  /** Defaults to `https://api.github.com`; tests point this at a fake server. */
  baseUrl?: string
  userAgent?: string
  apiVersion?: string
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

interface RequestOptions {
  method?: string
  body?: unknown
  etag?: string
  signal?: AbortSignal
  headers?: Record<string, string>
  timeoutMs?: number
  attempts?: number
  allow404?: boolean
}

interface RawResponse {
  status: number
  headers: Headers
  text: string
  etag?: string
  notModified: boolean
}

interface JsonResult<T> {
  data: T | null
  status: number
  headers: Headers
  etag?: string
  notModified: boolean
}

function appendParam(path: string, name: string, value: string): string {
  if (new RegExp(`[?&]${name}=`).test(path)) return path
  return `${path}${path.includes('?') ? '&' : '?'}${name}=${encodeURIComponent(value)}`
}

function nextLink(headers: Headers): string | undefined {
  const link = headers.get('link')
  if (!link) return undefined
  const match = /<([^>]+)>\s*;\s*rel="next"/.exec(link)
  return match?.[1]
}

function repoPath(repo: string): string {
  return repo
    .split('/')
    .filter(Boolean)
    .map(part => encodeURIComponent(part))
    .join('/')
}

export class GithubApi {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly userAgent: string
  private readonly apiVersion: string
  private readonly maxAttempts: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly timeoutMs: number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly tokenProvider: () => Promise<string>

  constructor(options: GithubApiOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.userAgent = options.userAgent ?? 'dsh-superagent-personal/0.1.0'
    this.apiVersion = options.apiVersion ?? '2022-11-28'
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3)
    this.baseDelayMs = Math.max(10, options.baseDelayMs ?? 1000)
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? 60_000)
    this.timeoutMs = Math.max(1000, options.timeoutMs ?? 20_000)
    this.sleep = options.sleep ?? sleepWithSignal
    if (typeof options.token === 'string') {
      const literal = options.token
      this.tokenProvider = async () => literal
    } else {
      this.tokenProvider = options.token
    }
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private urlFor(path: string): string {
    if (/^https?:\/\//i.test(path)) return path
    return `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`
  }

  private backoff(attempt: number): number {
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt)
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential / 4)))
    return exponential + jitter
  }

  private retryAfter(headers: Headers): number | undefined {
    const retryAfter = headers.get('retry-after')
    if (retryAfter) {
      const seconds = Number(retryAfter)
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(this.maxDelayMs, seconds * 1000)
      const date = Date.parse(retryAfter)
      if (Number.isFinite(date)) return Math.min(this.maxDelayMs, Math.max(0, date - Date.now()))
    }
    if (headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(headers.get('x-ratelimit-reset'))
      if (Number.isFinite(reset) && reset > 0) {
        return Math.min(this.maxDelayMs, Math.max(0, reset * 1000 - Date.now()))
      }
    }
    return undefined
  }

  /** Send with retries for retryable failures; returns the raw response otherwise. */
  private async send(path: string, options: RequestOptions): Promise<RawResponse> {
    const attempts = Math.max(1, options.attempts ?? this.maxAttempts)
    let attempt = 0
    let lastError: unknown
    while (attempt < attempts) {
      attempt += 1
      try {
        const response = await this.attempt(path, options)
        if (response.status >= 400 && response.status !== 304) {
          if (options.allow404 && response.status === 404) return response
          const details = describeResponseBody(response.text)
          const rateLimited =
            response.status === 429 ||
            (response.status === 403 &&
              (response.headers.get('x-ratelimit-remaining') === '0' ||
                /rate limit|abuse detection|secondary rate/i.test(details)))
          const retryAfterMs = this.retryAfter(response.headers)
          throw new GithubApiError({
            status: response.status,
            method: options.method ?? 'GET',
            path,
            ...(details ? { details } : {}),
            rateLimited,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          })
        }
        return response
      } catch (error) {
        lastError = error
        if (options.signal?.aborted) throw abortError()
        if (!(error instanceof GithubApiError)) throw error
        const retryable =
          error.status === 0 ||
          error.status === 429 ||
          error.status >= 500 ||
          (error.status === 403 && error.rateLimited)
        if (!retryable || attempt >= attempts) throw error
        const delay = Math.min(this.maxDelayMs, error.retryAfterMs ?? this.backoff(attempt))
        await this.sleep(delay, options.signal)
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new GithubApiError({ status: 0, method: 'GET', path, details: 'request failed' })
  }

  private async attempt(path: string, options: RequestOptions): Promise<RawResponse> {
    const token = await this.tokenProvider()
    const url = this.urlFor(path)
    const method = options.method ?? (options.body !== undefined ? 'POST' : 'GET')
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': this.apiVersion,
      'user-agent': this.userAgent,
      authorization: `Bearer ${token}`,
      ...(options.etag ? { 'if-none-match': options.etag } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw abortError()
      if (isAbortError(error)) {
        throw new GithubApiError({ status: 0, method, path, details: 'network timeout' })
      }
      throw new GithubApiError({ status: 0, method, path, details: `network error: ${describeError(error)}` })
    }
    let text: string
    try {
      text = await response.text()
    } catch (error) {
      throw new GithubApiError({
        status: 0,
        method,
        path,
        details: `network error while reading the answer: ${describeError(error)}`,
      })
    }
    const notModified = response.status === 304
    const etag = response.headers.get('etag') ?? undefined
    return {
      status: response.status,
      headers: response.headers,
      text: notModified ? '' : text,
      notModified,
      ...(etag ? { etag } : {}),
    }
  }

  private async json<T>(path: string, options: RequestOptions = {}): Promise<JsonResult<T>> {
    const response = await this.send(path, { allow404: true, ...options })
    if (response.notModified) {
      return { data: null, status: 304, headers: response.headers, notModified: true }
    }
    if (response.status === 404) {
      return { data: null, status: 404, headers: response.headers, notModified: false }
    }
    let data: T | null = null
    if (response.text.trim()) {
      try {
        data = JSON.parse(response.text) as T
      } catch {
        throw new GithubApiError({
          status: response.status,
          method: options.method ?? 'GET',
          path,
          details: 'invalid JSON answer',
        })
      }
    }
    return {
      data,
      status: response.status,
      headers: response.headers,
      notModified: false,
      ...(response.etag ? { etag: response.etag } : {}),
    }
  }

  /** Read a JSON resource that must exist; a 404 becomes a descriptive error. */
  private async must<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const result = await this.json<T>(path, options)
    if (result.data === null) {
      throw new GithubApiError({
        status: result.status,
        method: options.method ?? 'GET',
        path,
        details: result.notModified ? 'not modified with no cached body' : 'not found',
      })
    }
    return result.data
  }

  /**
   * Paginate a list endpoint, following `Link: rel="next"` up to `maxPages`.
   * The ETag is only returned for a single-page answer: replaying page 1 with
   * `If-None-Match` would wrongly skip later pages when new items are appended.
   */
  private async paginate<T>(
    path: string,
    options: { signal?: AbortSignal; etag?: string; maxPages?: number; perPage?: number } = {},
  ): Promise<GithubPage<T>> {
    const maxPages = Math.max(1, options.maxPages ?? 3)
    let next: string | undefined = appendParam(path, 'per_page', String(options.perPage ?? 100))
    const items: T[] = []
    let notModified = false
    let etag: string | undefined
    let pages = 0
    let truncated = false
    while (next) {
      if (pages >= maxPages) {
        truncated = true
        break
      }
      const requestPath = next
      pages += 1
      const result = await this.json<unknown>(requestPath, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(pages === 1 && options.etag ? { etag: options.etag } : {}),
      })
      if (result.notModified) {
        notModified = true
        break
      }
      if (!Array.isArray(result.data)) {
        throw new GithubApiError({
          status: result.status,
          method: 'GET',
          path: requestPath,
          details: 'expected a JSON array',
        })
      }
      for (const item of result.data) items.push(item as T)
      if (pages === 1 && result.etag) etag = result.etag
      next = nextLink(result.headers)
    }
    const single = pages === 1 && !truncated
    return {
      items,
      notModified,
      truncated,
      ...(single && etag ? { etag } : {}),
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getAuthenticatedUser(options: { signal?: AbortSignal } = {}): Promise<GithubUser> {
    return this.must<GithubUser>('/user', { signal: options.signal })
  }

  async getRepo(repo: string, options: { signal?: AbortSignal } = {}): Promise<GithubRepo | null> {
    const result = await this.json<GithubRepo>(`/repos/${repoPath(repo)}`, { signal: options.signal })
    return result.data
  }

  async getDefaultBranch(repo: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    const info = await this.getRepo(repo, options)
    if (!info) {
      throw new GithubApiError({
        status: 404,
        method: 'GET',
        path: `/repos/${repoPath(repo)}`,
        details: 'repository not found',
      })
    }
    return info.default_branch
  }

  async getBranchHead(
    repo: string,
    branch: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ sha: string; ref: string }> {
    return this.must<{ sha: string; ref: string }>(
      `/repos/${repoPath(repo)}/commits/${encodeURIComponent(branch)}`,
      { signal: options.signal },
    )
  }

  async getIssue(repo: string, number: number, options: { signal?: AbortSignal } = {}): Promise<GithubIssue> {
    return this.must<GithubIssue>(`/repos/${repoPath(repo)}/issues/${number}`, { signal: options.signal })
  }

  async getPull(repo: string, number: number, options: { signal?: AbortSignal } = {}): Promise<GithubPullRequest> {
    return this.must<GithubPullRequest>(`/repos/${repoPath(repo)}/pulls/${number}`, { signal: options.signal })
  }

  /**
   * Repositories the authenticated user can access (owner, collaborator or
   * organization member), newest push first. Paginated; callers cap the pages.
   */
  async listUserRepositories(
    options: { signal?: AbortSignal; maxPages?: number; perPage?: number } = {},
  ): Promise<GithubPage<GithubRepo>> {
    return this.paginate<GithubRepo>(
      '/user/repos?sort=pushed&direction=desc&affiliation=owner,collaborator,organization_member',
      { ...options, maxPages: options.maxPages ?? 2 },
    )
  }

  /** Issues (including pull requests) updated since an ISO timestamp, oldest first. */
  async listIssuesUpdatedSince(
    repo: string,
    since: string,
    options: { signal?: AbortSignal; etag?: string; maxPages?: number } = {},
  ): Promise<GithubPage<GithubIssue>> {
    const query = `state=open&sort=updated&direction=asc&since=${encodeURIComponent(since)}`
    return this.paginate<GithubIssue>(`/repos/${repoPath(repo)}/issues?${query}`, options)
  }

  /**
   * Pull requests updated since an ISO timestamp, newest first. The pulls
   * endpoint has no `since` parameter, so this walks pages until an entry older
   * than the cursor is seen.
   */
  async listPullsUpdatedSince(
    repo: string,
    since: string,
    options: { signal?: AbortSignal; etag?: string; maxPages?: number } = {},
  ): Promise<GithubPage<GithubPullRequest>> {
    const maxPages = Math.max(1, options.maxPages ?? 3)
    let next: string | undefined = appendParam(
      `/repos/${repoPath(repo)}/pulls?state=all&sort=updated&direction=desc`,
      'per_page',
      '100',
    )
    const items: GithubPullRequest[] = []
    let pages = 0
    let notModified = false
    let etag: string | undefined
    let sawOlder = false
    const sinceMs = moment(since)
    while (next) {
      if (pages >= maxPages) break
      const requestUrl = next
      pages += 1
      const result = await this.json<unknown>(requestUrl, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(pages === 1 && options.etag ? { etag: options.etag } : {}),
      })
      if (result.notModified) {
        notModified = true
        break
      }
      if (!Array.isArray(result.data)) {
        throw new GithubApiError({
          status: result.status,
          method: 'GET',
          path: requestUrl,
          details: 'expected a JSON array',
        })
      }
      if (pages === 1 && result.etag) etag = result.etag
      for (const pull of result.data as GithubPullRequest[]) {
        const updated = moment(pull.updated_at)
        if (!Number.isFinite(updated) || !Number.isFinite(sinceMs) || updated < sinceMs) {
          sawOlder = true
          continue
        }
        items.push(pull)
      }
      if (sawOlder) break
      next = nextLink(result.headers)
    }
    const single = pages === 1
    return {
      items,
      notModified,
      truncated: !sawOlder && pages >= maxPages && Boolean(next),
      ...(single && etag ? { etag } : {}),
    }
  }

  /** Conversation comments across a repository, oldest updated first. */
  async listIssueCommentsSince(
    repo: string,
    since: string,
    options: { signal?: AbortSignal; etag?: string; maxPages?: number } = {},
  ): Promise<GithubPage<GithubComment>> {
    const query = `sort=updated&direction=asc&since=${encodeURIComponent(since)}`
    return this.paginate<GithubComment>(`/repos/${repoPath(repo)}/issues/comments?${query}`, options)
  }

  /** Inline review comments across a repository, oldest updated first. */
  async listPullReviewCommentsSince(
    repo: string,
    since: string,
    options: { signal?: AbortSignal; etag?: string; maxPages?: number } = {},
  ): Promise<GithubPage<GithubComment>> {
    const query = `sort=updated&direction=asc&since=${encodeURIComponent(since)}`
    return this.paginate<GithubComment>(`/repos/${repoPath(repo)}/pulls/comments?${query}`, options)
  }

  /** Reviews of one pull request (the endpoint is per-PR and has no `since`). */
  async listPullReviews(
    repo: string,
    number: number,
    options: { signal?: AbortSignal; maxPages?: number } = {},
  ): Promise<GithubPage<GithubReview>> {
    return this.paginate<GithubReview>(`/repos/${repoPath(repo)}/pulls/${number}/reviews`, {
      ...options,
      maxPages: options.maxPages ?? 1,
    })
  }

  /** Check runs for a commit SHA or branch ref (latest run per check). */
  async getCheckRunsForRef(
    repo: string,
    ref: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<GithubCheckRunsResponse> {
    return this.must<GithubCheckRunsResponse>(
      `/repos/${repoPath(repo)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100&filter=latest`,
      { signal: options.signal },
    )
  }

  /** Workflow runs for a ref: by default `head_sha`, or `branch` for a branch name. */
  async listWorkflowRunsForRef(
    repo: string,
    ref: string,
    options: { by?: 'sha' | 'branch'; signal?: AbortSignal } = {},
  ): Promise<GithubWorkflowRunsResponse> {
    const param = options.by === 'branch' ? 'branch' : 'head_sha'
    return this.must<GithubWorkflowRunsResponse>(
      `/repos/${repoPath(repo)}/actions/runs?${param}=${encodeURIComponent(ref)}&per_page=20`,
      { signal: options.signal },
    )
  }

  // -------------------------------------------------------------------------
  // Writes (reused by the GitHub tools)
  // -------------------------------------------------------------------------

  /**
   * Post a comment on an issue or pull request. When `idempotencyKey` is given
   * the body carries a hidden marker and an existing comment with that marker
   * is returned instead of posting a second one.
   */
  async createIssueComment(
    repo: string,
    number: number,
    body: string,
    options: { signal?: AbortSignal; idempotencyKey?: string } = {},
  ): Promise<GithubComment> {
    const marker = options.idempotencyKey
      ? `<!-- superagent:${options.idempotencyKey.replace(/[^A-Za-z0-9:_-]/g, '-')} -->`
      : undefined
    if (marker) {
      const recent = await this.paginate<GithubComment>(
        `/repos/${repoPath(repo)}/issues/${number}/comments?sort=created&direction=desc`,
        { ...(options.signal ? { signal: options.signal } : {}), maxPages: 1 },
      )
      const existing = recent.items.find(
        comment => typeof comment.body === 'string' && comment.body.includes(marker),
      )
      if (existing) return existing
    }
    const text = marker ? `${body}\n\n${marker}` : body
    return this.must<GithubComment>(`/repos/${repoPath(repo)}/issues/${number}/comments`, {
      method: 'POST',
      body: { body: text },
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  async createPullRequest(
    repo: string,
    input: { title: string; head: string; base: string; body?: string; draft?: boolean; signal?: AbortSignal },
  ): Promise<GithubPullRequest> {
    return this.must<GithubPullRequest>(`/repos/${repoPath(repo)}/pulls`, {
      method: 'POST',
      body: {
        title: input.title,
        head: input.head,
        base: input.base,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.draft !== undefined ? { draft: input.draft } : {}),
      },
      ...(input.signal ? { signal: input.signal } : {}),
    })
  }
}

function describeResponseBody(text: string): string {
  if (!text.trim()) return ''
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed) && typeof parsed.message === 'string') {
      const extra = Array.isArray(parsed.errors)
        ? parsed.errors
            .slice(0, 3)
            .map(item => (isRecord(item) && typeof item.message === 'string' ? item.message : ''))
            .filter(Boolean)
            .join('; ')
        : ''
      return `${parsed.message}${extra ? ` (${extra})` : ''}`.slice(0, 400)
    }
    if (isRecord(parsed) && typeof parsed.documentation_url === 'string') return parsed.documentation_url
  } catch {
    // Not JSON; fall back to a short slice of the raw body.
  }
  return text.replace(/\s+/g, ' ').slice(0, 200)
}

// ---------------------------------------------------------------------------
// Stateless setup helpers (no ctx, no logging; safe for dynamic import)
// ---------------------------------------------------------------------------

/** A token check failed. The message never contains the token. */
export class GithubTokenValidationError extends Error {
  /** HTTP status when GitHub answered; `0` for transport errors. */
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GithubTokenValidationError'
    if (status !== undefined) this.status = status
  }
}

export interface SetupHelperOptions {
  /** GitHub API base URL; only changed in tests. */
  apiBaseUrl?: string
  /** Per-request timeout in milliseconds (default 10s). */
  timeoutMs?: number
}

/** One repository as the setup wizard shows it. */
export interface GithubRepositorySummary {
  fullName: string
  private: boolean
  pushedAt: string | null
  archived: boolean
  fork: boolean
}

function setupApi(token: string, options: SetupHelperOptions): GithubApi {
  const trimmed = token.trim()
  if (!trimmed) throw new GithubTokenValidationError('GitHub token is empty')
  return new GithubApi({
    token: trimmed,
    ...(options.apiBaseUrl ? { baseUrl: options.apiBaseUrl } : {}),
    maxAttempts: 2,
    baseDelayMs: 250,
    // A setup check must stay fast: never wait minutes for a 429 retry_after.
    maxDelayMs: 2_000,
    timeoutMs: Math.max(1_000, options.timeoutMs ?? 10_000),
  })
}

/**
 * Call `/user` once to prove a GitHub token works. Stateless: no Source
 * instance, configuration or state is touched, so the setup API can call it
 * through a dynamic `import()`.
 *
 * Throws {@link GithubTokenValidationError} with a readable description (the
 * token is never included). A 403 rate-limit answer surfaces as HTTP 403 with
 * GitHub's message.
 */
export async function validateGithubToken(
  token: string,
  options: SetupHelperOptions = {},
): Promise<{ ok: true; login: string; id: number }> {
  const api = setupApi(token, options)
  try {
    const user = await api.getAuthenticatedUser()
    if (!user || typeof user.login !== 'string' || !user.login) {
      throw new GithubTokenValidationError('GitHub returned an unexpected /user answer')
    }
    return { ok: true, login: user.login, id: typeof user.id === 'number' ? user.id : 0 }
  } catch (error) {
    if (error instanceof GithubTokenValidationError) throw error
    if (error instanceof GithubApiError) {
      const description = error.status === 0 ? (error.details ?? 'network error') : error.details
      throw new GithubTokenValidationError(
        `GitHub token check failed: HTTP ${error.status}${description ? `: ${description}` : ''}`,
        error.status,
      )
    }
    throw new GithubTokenValidationError(`GitHub token check failed: ${describeError(error)}`)
  }
}

/**
 * List the repositories the token can access, at most 200, newest push first.
 * Pages through `Link: rel="next"` (100 per page) and stops at the cap.
 *
 * Throws {@link GithubApiError} with a readable status/message for 401, 403
 * (including rate limits), 404 and transport errors; the token never appears.
 */
export async function listGithubRepositories(
  token: string,
  options: SetupHelperOptions = {},
): Promise<GithubRepositorySummary[]> {
  const api = setupApi(token, options)
  const page = await api.listUserRepositories({ maxPages: 2, perPage: 100 })
  return page.items.slice(0, 200).map(repo => ({
    fullName: repo.full_name,
    private: repo.private === true,
    pushedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : null,
    archived: repo.archived === true,
    fork: repo.fork === true,
  }))
}
