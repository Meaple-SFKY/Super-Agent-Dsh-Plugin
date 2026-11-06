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
// Agent-output markers
// ---------------------------------------------------------------------------

/**
 * Hidden marker prefix the SuperAgent adds to GitHub output it created itself.
 * The Source uses it to drop its own comments / PR bodies when `allowSelf` is
 * on, so a single-account setup cannot trigger itself in a loop.
 */
export const AGENT_MARKER_PREFIX = '<!-- superagent:'

/** Marker appended to pull request bodies created through {@link GithubApi}. */
export const AGENT_PR_MARKER = `${AGENT_MARKER_PREFIX}pr -->`

/** Marker appended to comments created without an idempotency key. */
export const AGENT_COMMENT_MARKER = `${AGENT_MARKER_PREFIX}comment -->`

/** True when text carries the agent-output marker. */
export function hasAgentMarker(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(AGENT_MARKER_PREFIX)
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
  ssh_url?: string
  clone_url?: string
}

/** A repository invitation as the REST API returns it (pending only). */
export interface GithubInvitation {
  id: number
  repository?: {
    full_name?: string
    private?: boolean
    html_url?: string
    owner?: { login?: string }
  }
  invitee?: { login?: string }
  inviter?: { login?: string }
  permissions?: string
  created_at?: string
  expired?: boolean
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
// Extended REST inputs/results (issues, pulls, reviews, search)
// ---------------------------------------------------------------------------

export interface GithubIssueListOptions {
  state?: 'open' | 'closed' | 'all'
  labels?: string[]
  assignee?: string
  perPage?: number
  maxPages?: number
  signal?: AbortSignal
}

export interface CreateGithubIssueInput {
  title: string
  body?: string
  labels?: string[]
  assignees?: string[]
}

export interface UpdateGithubIssueInput {
  title?: string
  body?: string
  state?: 'open' | 'closed'
  labels?: string[]
  assignees?: string[]
}

export interface GithubPullListOptions {
  state?: 'open' | 'closed' | 'all'
  head?: string
  base?: string
  perPage?: number
  maxPages?: number
  signal?: AbortSignal
}

export interface GithubPullFile {
  filename: string
  status: string
  additions: number
  deletions: number
  changes: number
  patch?: string | null
  blob_url?: string | null
  raw_url?: string | null
}

export interface GithubPullReviewInput {
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  body?: string
  comments?: Array<{
    path: string
    body: string
    line?: number
    side?: 'LEFT' | 'RIGHT'
    start_line?: number
  }>
}

export interface GithubReviewSummary {
  id: number
  state: string
  html_url?: string
}

export interface GithubMergePullInput {
  merge_method?: 'merge' | 'squash' | 'rebase'
  commit_title?: string
  commit_message?: string
  sha?: string
}

export interface GithubMergePullResult {
  merged: boolean
  sha?: string
  message?: string
}

export interface GithubSearchResult {
  total_count: number
  items: GithubIssue[]
}

/** A GitHub notification from `GET /notifications`. */
export interface GithubNotification {
  id: string
  unread?: boolean
  reason?: string
  updated_at?: string
  subject?: { title?: string; url?: string; type?: string }
  repository?: { full_name?: string }
}

/** Primary rate-limit information observed on the most recent response. */
export interface GithubRateLimitSnapshot {
  limit?: number
  remaining?: number
  /** Epoch milliseconds at which the window resets. */
  resetAt?: number
  retryAfterMs?: number
  observedAt?: number
}

/** Request counters for health reporting and quota budgeting. */
export interface GithubApiStats {
  requests: number
  notModified: number
  retries: number
  rateLimitedResponses: number
  rateLimit: GithubRateLimitSnapshot
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Permissions the repository collaborator API accepts. */
export type GithubCollaboratorPermission = 'pull' | 'triage' | 'push' | 'maintain' | 'admin'

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

/** Worker-facing patches are capped: full diffs can be megabytes. */
const PULL_PATCH_LIMIT = 4_000
function truncatePullPatch(patch: string, limit = PULL_PATCH_LIMIT): string {
  if (patch.length <= limit) return patch
  return `${patch.slice(0, limit)}\n… [truncated]`
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
  private readonly counters = { requests: 0, notModified: 0, retries: 0, rateLimitedResponses: 0 }
  private rateLimitState: GithubRateLimitSnapshot = {}

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

  /** Cumulative request counters plus the latest rate-limit snapshot. */
  stats(): GithubApiStats {
    return { ...this.counters, rateLimit: { ...this.rateLimitState } }
  }

  /** Reset only the counters (the rate-limit snapshot is kept). */
  resetStats(): void {
    this.counters.requests = 0
    this.counters.notModified = 0
    this.counters.retries = 0
    this.counters.rateLimitedResponses = 0
  }

  private recordRateLimit(headers: Headers): void {
    const observedAt = Date.now()
    const headerNumber = (name: string): number => {
      const raw = headers.get(name)
      if (raw === null || raw.trim() === '') return Number.NaN
      return Number(raw)
    }
    const limit = headerNumber('x-ratelimit-limit')
    const remaining = headerNumber('x-ratelimit-remaining')
    const reset = headerNumber('x-ratelimit-reset')
    const retryAfterMs = this.retryAfter(headers)
    this.rateLimitState = {
      ...this.rateLimitState,
      observedAt,
      ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      ...(Number.isFinite(remaining) && remaining >= 0 ? { remaining } : {}),
      ...(Number.isFinite(reset) && reset > 0 ? { resetAt: reset * 1000 } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
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
        this.counters.retries += 1
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
    this.counters.requests += 1
    if (notModified) this.counters.notModified += 1
    if (response.status === 429 || response.status === 403) this.counters.rateLimitedResponses += 1
    this.recordRateLimit(response.headers)
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

  /** Issues of one repository (GitHub's issues endpoint also returns PRs). */
  async listIssues(repo: string, options: GithubIssueListOptions = {}): Promise<GithubPage<GithubIssue>> {
    const params: string[] = [`state=${encodeURIComponent(options.state ?? 'open')}`]
    if (options.labels && options.labels.length > 0) {
      params.push(`labels=${encodeURIComponent(options.labels.join(','))}`)
    }
    if (options.assignee) params.push(`assignee=${encodeURIComponent(options.assignee)}`)
    return this.paginate<GithubIssue>(`/repos/${repoPath(repo)}/issues?${params.join('&')}`, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.perPage !== undefined ? { perPage: options.perPage } : {}),
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    })
  }

  /**
   * Create an issue. A 422 (invalid labels/assignees, or a duplicate title in a
   * repository with issue uniqueness enforced by an app) is a `GithubApiError`
   * with GitHub's message; 403 means the token may not write issues.
   */
  async createIssue(
    repo: string,
    input: CreateGithubIssueInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<GithubIssue> {
    return this.must<GithubIssue>(`/repos/${repoPath(repo)}/issues`, {
      method: 'POST',
      body: {
        title: input.title,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.labels !== undefined ? { labels: input.labels } : {}),
        ...(input.assignees !== undefined ? { assignees: input.assignees } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  /** Update title/body/state/labels/assignees of an issue or pull request. */
  async updateIssue(
    repo: string,
    number: number,
    input: UpdateGithubIssueInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<GithubIssue> {
    return this.must<GithubIssue>(`/repos/${repoPath(repo)}/issues/${number}`, {
      method: 'PATCH',
      body: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.labels !== undefined ? { labels: input.labels } : {}),
        ...(input.assignees !== undefined ? { assignees: input.assignees } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  /** Pull requests of one repository; `head` is `owner:branch` per GitHub. */
  async listPulls(repo: string, options: GithubPullListOptions = {}): Promise<GithubPage<GithubPullRequest>> {
    const params: string[] = [`state=${encodeURIComponent(options.state ?? 'open')}`]
    if (options.head) params.push(`head=${encodeURIComponent(options.head)}`)
    if (options.base) params.push(`base=${encodeURIComponent(options.base)}`)
    return this.paginate<GithubPullRequest>(`/repos/${repoPath(repo)}/pulls?${params.join('&')}`, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.perPage !== undefined ? { perPage: options.perPage } : {}),
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    })
  }

  /** Files changed by a pull request (patch text included when available). */
  async listPullFiles(
    repo: string,
    number: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<GithubPullFile[]> {
    const page = await this.paginate<GithubPullFile>(`/repos/${repoPath(repo)}/pulls/${number}/files`, {
      ...(options.signal ? { signal: options.signal } : {}),
      maxPages: 3,
    })
    return page.items.map(file => ({
      filename: file.filename,
      status: file.status,
      additions: typeof file.additions === 'number' ? file.additions : 0,
      deletions: typeof file.deletions === 'number' ? file.deletions : 0,
      changes: typeof file.changes === 'number' ? file.changes : 0,
      patch: typeof file.patch === 'string' ? truncatePullPatch(file.patch) : null,
      blob_url: typeof file.blob_url === 'string' ? file.blob_url : null,
      raw_url: typeof file.raw_url === 'string' ? file.raw_url : null,
    }))
  }

  /** Alias of {@link listPullFiles} used by the worker GitHub tool. */
  async getPullFiles(
    repo: string,
    number: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<GithubPullFile[]> {
    return this.listPullFiles(repo, number, options)
  }

  /**
   * Submit a pull request review. 422 = invalid inline comment (e.g. a line
   * outside the diff); 403 = the token may not review its own PR (GitHub rejects
   * self-approval unless the token belongs to another account).
   */
  async createPullReview(
    repo: string,
    number: number,
    input: GithubPullReviewInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<GithubReviewSummary> {
    return this.must<GithubReviewSummary>(`/repos/${repoPath(repo)}/pulls/${number}/reviews`, {
      method: 'POST',
      body: {
        event: input.event,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.comments !== undefined ? { comments: input.comments } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  /**
   * Merge a pull request. 405 = not mergeable (conflicts/branch protection),
   * 409 = the head moved; both come back as `GithubApiError` with GitHub's
   * message so the caller can report a concrete reason.
   */
  async mergePull(
    repo: string,
    number: number,
    input: GithubMergePullInput = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<GithubMergePullResult> {
    return this.must<GithubMergePullResult>(`/repos/${repoPath(repo)}/pulls/${number}/merge`, {
      method: 'PUT',
      body: {
        ...(input.merge_method !== undefined ? { merge_method: input.merge_method } : {}),
        ...(input.commit_title !== undefined ? { commit_title: input.commit_title } : {}),
        ...(input.commit_message !== undefined ? { commit_message: input.commit_message } : {}),
        ...(input.sha !== undefined ? { sha: input.sha } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  /**
   * Search issues and pull requests (`GET /search/issues`). `total_count` comes
   * from the first page; items are paginated up to `maxPages` (default 1).
   */
  async searchIssues(
    query: string,
    options: { perPage?: number; maxPages?: number; signal?: AbortSignal } = {},
  ): Promise<GithubSearchResult> {
    const maxPages = Math.max(1, options.maxPages ?? 1)
    let next: string | undefined = appendParam(
      `/search/issues?q=${encodeURIComponent(query)}`,
      'per_page',
      String(options.perPage ?? 30),
    )
    const items: GithubIssue[] = []
    let total = 0
    let pages = 0
    while (next && pages < maxPages) {
      const requestPath = next
      pages += 1
      const result = await this.json<{ total_count?: number; items?: GithubIssue[] }>(requestPath, {
        ...(options.signal ? { signal: options.signal } : {}),
      })
      if (result.notModified) break
      const data = result.data
      if (!data || !Array.isArray(data.items)) {
        throw new GithubApiError({
          status: result.status,
          method: 'GET',
          path: requestPath,
          details: 'expected a search answer with items',
        })
      }
      if (typeof data.total_count === 'number') total = data.total_count
      for (const item of data.items) items.push(item)
      next = nextLink(result.headers)
    }
    return { total_count: total, items }
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

  /** Invite a user as a repository collaborator (PUT; 204 = already collaborator). */
  async addCollaborator(
    repo: string,
    username: string,
    permission: GithubCollaboratorPermission = 'admin',
    options: { signal?: AbortSignal } = {},
  ): Promise<{ status: number; alreadyCollaborator: boolean }> {
    const result = await this.json<unknown>(
      `/repos/${repoPath(repo)}/collaborators/${encodeURIComponent(username)}`,
      {
        method: 'PUT',
        body: { permission },
        ...(options.signal ? { signal: options.signal } : {}),
      },
    )
    return { status: result.status, alreadyCollaborator: result.status === 204 }
  }

  /** Pending repository invitations for the authenticated user. */
  async listRepositoryInvitations(
    options: { signal?: AbortSignal; maxPages?: number; perPage?: number } = {},
  ): Promise<GithubPage<GithubInvitation>> {
    return this.paginate<GithubInvitation>('/user/repository_invitations', {
      ...options,
      maxPages: options.maxPages ?? 2,
    })
  }

  /** Accept one repository invitation (PATCH; 204 on success). */
  async acceptRepositoryInvitation(
    invitationId: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ status: number }> {
    const result = await this.json<unknown>(`/user/repository_invitations/${invitationId}`, {
      method: 'PATCH',
      ...(options.signal ? { signal: options.signal } : {}),
    })
    return { status: result.status }
  }

  /**
   * Notifications for the authenticated user (`GET /notifications`), newest
   * first. This is the cheap cross-repository "something happened" stream used
   * to decide which repositories need a full poll.
   */
  async listNotifications(
    options: { since?: string; all?: boolean; etag?: string; perPage?: number; maxPages?: number; signal?: AbortSignal } = {},
  ): Promise<GithubPage<GithubNotification>> {
    const params: string[] = [`all=${options.all === true ? 'true' : 'false'}`]
    if (options.since) params.push(`since=${encodeURIComponent(options.since)}`)
    return this.paginate<GithubNotification>(`/notifications?${params.join('&')}`, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.etag ? { etag: options.etag } : {}),
      ...(options.perPage !== undefined ? { perPage: options.perPage } : {}),
      maxPages: options.maxPages ?? 2,
    })
  }

  /** Create a repository under the authenticated user's account. */
  async createRepository(
    input: { name: string; private?: boolean; description?: string; autoInit?: boolean; signal?: AbortSignal },
  ): Promise<GithubRepo> {
    return this.must<GithubRepo>('/user/repos', {
      method: 'POST',
      body: {
        name: input.name,
        ...(input.private !== undefined ? { private: input.private } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.autoInit !== undefined ? { auto_init: input.autoInit } : {}),
      },
      ...(input.signal ? { signal: input.signal } : {}),
    })
  }

  /** Issues (including pull requests) updated since an ISO timestamp, oldest first. */
  async listIssuesUpdatedSince(
    repo: string,
    since: string,
    options: { signal?: AbortSignal; etag?: string; maxPages?: number } = {},
  ): Promise<GithubPage<GithubIssue>> {
    const query = `state=open&sort=updated&direction=desc&since=${encodeURIComponent(since)}`
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
    options: { signal?: AbortSignal; maxPages?: number; etag?: string } = {},
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
    // Every agent comment carries the hidden marker, so `allowSelf` can filter
    // our own output; an idempotency key additionally makes retries dedupe.
    const marker = options.idempotencyKey
      ? `${AGENT_MARKER_PREFIX}${options.idempotencyKey.replace(/[^A-Za-z0-9:_-]/g, '-')} -->`
      : AGENT_COMMENT_MARKER
    if (options.idempotencyKey) {
      const recent = await this.paginate<GithubComment>(
        `/repos/${repoPath(repo)}/issues/${number}/comments?sort=created&direction=desc`,
        { ...(options.signal ? { signal: options.signal } : {}), maxPages: 1 },
      )
      const existing = recent.items.find(
        comment => typeof comment.body === 'string' && comment.body.includes(marker),
      )
      if (existing) return existing
    }
    const text = hasAgentMarker(body) ? body : `${body}\n\n${marker}`
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
    // Mark every PR the agent opens, so `allowSelf` never turns our own PR into
    // a fresh Trigger (the marker is invisible in rendered Markdown).
    const body = hasAgentMarker(input.body)
      ? input.body
      : `${input.body?.trim() ? `${input.body.trim()}\n\n` : ''}${AGENT_PR_MARKER}`
    return this.must<GithubPullRequest>(`/repos/${repoPath(repo)}/pulls`, {
      method: 'POST',
      body: {
        title: input.title,
        head: input.head,
        base: input.base,
        body,
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

/** Input of {@link createGithubRepository}; `autoInit` maps to `auto_init`. */
export interface CreateGithubRepositoryInput {
  name: string
  private?: boolean
  description?: string
  /** Create the repository with an initial README and a default branch. */
  autoInit?: boolean
}

/** Result of {@link createGithubRepository}; `created` is false when it existed. */
export interface GithubRepositoryCreated {
  ok: true
  created: boolean
  fullName: string
  name: string
  private: boolean
  htmlUrl: string
  sshUrl: string
  cloneUrl: string | null
  defaultBranch: string
}

function mapCreatedRepository(repo: GithubRepo, created: boolean): GithubRepositoryCreated {
  return {
    ok: true,
    created,
    fullName: repo.full_name,
    name: repo.name,
    private: repo.private === true,
    htmlUrl: typeof repo.html_url === 'string' ? repo.html_url : '',
    sshUrl: typeof repo.ssh_url === 'string' ? repo.ssh_url : '',
    cloneUrl: typeof repo.clone_url === 'string' ? repo.clone_url : null,
    defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : '',
  }
}

/**
 * Create a repository under the authenticated user's account, statelessly.
 *
 * A 422 "name already exists" answer is not an error: the helper reads the
 * existing repository and returns it with `created: false`, so retries and
 * "make sure this repo exists" calls are idempotent. Any other failure is
 * thrown as a readable, token-free {@link GithubApiError}.
 */
export async function createGithubRepository(
  token: string,
  input: CreateGithubRepositoryInput,
  options: SetupHelperOptions = {},
): Promise<GithubRepositoryCreated> {
  const name = input.name.trim()
  if (!name) {
    throw new GithubApiError({
      status: 422,
      method: 'POST',
      path: '/user/repos',
      details: 'repository name is empty',
    })
  }
  if (name.length > 100 || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new GithubApiError({
      status: 422,
      method: 'POST',
      path: '/user/repos',
      details: 'repository names must be 1-100 characters of letters, digits, dots, underscores or hyphens',
    })
  }
  const api = setupApi(token, options)
  try {
    const repo = await api.createRepository({
      name,
      ...(input.private !== undefined ? { private: input.private } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.autoInit !== undefined ? { autoInit: input.autoInit } : {}),
    })
    return mapCreatedRepository(repo, true)
  } catch (error) {
    // GitHub signals an existing name with 422; return it instead of failing.
    if (!(error instanceof GithubApiError) || error.status !== 422 || !/already exists/i.test(error.details ?? '')) {
      throw error
    }
    const user = await api.getAuthenticatedUser()
    const existing = await api.getRepo(`${user.login}/${name}`)
    if (!existing) throw error
    return mapCreatedRepository(existing, false)
  }
}

/** Result of {@link addGithubCollaborator}. */
export interface AddGithubCollaboratorResult {
  ok: true
  repo: string
  login: string
  permission: GithubCollaboratorPermission
  /** True when the user already had access (HTTP 204 or 422). */
  alreadyCollaborator: boolean
}

const COLLABORATOR_PERMISSIONS: readonly GithubCollaboratorPermission[] = [
  'pull',
  'triage',
  'push',
  'maintain',
  'admin',
]

/**
 * Invite a GitHub user as a collaborator of `owner/repo`, statelessly.
 *
 * Idempotent: a 204 answer (already a collaborator) and GitHub's 422
 * "already a collaborator / invitation pending" both return success with
 * `alreadyCollaborator: true`. Every other failure is a readable, token-free
 * {@link GithubApiError}.
 */
export async function addGithubCollaborator(
  token: string,
  repo: string,
  username: string,
  permission: GithubCollaboratorPermission = 'admin',
  options: SetupHelperOptions = {},
): Promise<AddGithubCollaboratorResult> {
  const login = username.trim().replace(/^@/, '')
  if (!login || !/^[A-Za-z0-9-]+$/.test(login)) {
    throw new GithubApiError({
      status: 422,
      method: 'PUT',
      path: `/repos/${repo}/collaborators`,
      details: 'invalid GitHub username',
    })
  }
  if (!COLLABORATOR_PERMISSIONS.includes(permission)) {
    throw new GithubApiError({
      status: 422,
      method: 'PUT',
      path: `/repos/${repo}/collaborators/${login}`,
      details: `unsupported collaborator permission: ${permission}`,
    })
  }
  const api = setupApi(token, options)
  try {
    const result = await api.addCollaborator(repo, login, permission)
    return { ok: true, repo, login, permission, alreadyCollaborator: result.alreadyCollaborator }
  } catch (error) {
    // Already a collaborator or a pending invitation is the desired state.
    if (error instanceof GithubApiError && error.status === 422) {
      return { ok: true, repo, login, permission, alreadyCollaborator: true }
    }
    throw error
  }
}

/** One pending repository invitation, flattened for the runtime/wizard. */
export interface GithubRepositoryInvitation {
  id: number
  /** `owner/name` of the repository the invitation points at. */
  repository: string
  private: boolean
  htmlUrl: string
  /** GitHub returns `admin`, `write`, `read`, ... */
  permission: string
  inviter: string | null
  createdAt: string | null
}

/** Result of {@link acceptRepositoryInvitation}; 404/422 are tolerated. */
export interface GithubAcceptedInvitation {
  ok: true
  invitationId: number
  /** `accepted` on 204; `already-accepted-or-gone` on 404/422. */
  status: 'accepted' | 'already-accepted-or-gone'
}

/**
 * List the pending repository invitations of the authenticated user (the bot
 * account). Stateless, token-free errors; at most 200 invitations.
 */
export async function listRepositoryInvitations(
  token: string,
  options: SetupHelperOptions = {},
): Promise<GithubRepositoryInvitation[]> {
  const api = setupApi(token, options)
  const page = await api.listRepositoryInvitations({ maxPages: 2, perPage: 100 })
  return page.items
    .map(invitation => ({
      id: invitation.id,
      repository: invitation.repository?.full_name ?? '',
      private: invitation.repository?.private === true,
      htmlUrl: invitation.repository?.html_url ?? '',
      permission: invitation.permissions ?? 'read',
      inviter: invitation.inviter?.login ?? null,
      createdAt: invitation.created_at ?? null,
    }))
    .filter(invitation => invitation.repository.length > 0)
}

/**
 * Accept one pending repository invitation (e.g. the operator invited the bot
 * account into an existing repository). 404 and 422 are tolerated: the
 * invitation is already accepted, revoked or expired, which is the same
 * end state for automation.
 */
export async function acceptRepositoryInvitation(
  token: string,
  invitationId: number,
  options: SetupHelperOptions = {},
): Promise<GithubAcceptedInvitation> {
  const id = Number(invitationId)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new GithubApiError({
      status: 422,
      method: 'PATCH',
      path: `/user/repository_invitations/${String(invitationId)}`,
      details: 'invalid invitation id',
    })
  }
  const api = setupApi(token, options)
  try {
    const result = await api.acceptRepositoryInvitation(id)
    return { ok: true, invitationId: id, status: result.status === 204 ? 'accepted' : 'already-accepted-or-gone' }
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 422) {
      return { ok: true, invitationId: id, status: 'already-accepted-or-gone' }
    }
    throw error
  }
}

/** Result of {@link acceptInvitationForRepo}. */
export interface AcceptInvitationForRepoResult {
  ok: true
  /** The matched repository (`owner/name`), or the normalized input when none. */
  repo: string
  status: 'accepted' | 'none' | 'already-accepted-or-gone'
  invitationId?: number
}

/**
 * Accept the pending repository invitation for `owner/name`, if the token's
 * account has one (typically the operator invited the bot into a repository).
 *
 * Matching is case-insensitive. Outcomes:
 * - `accepted` — the invitation existed and PATCH succeeded;
 * - `already-accepted-or-gone` — GitHub answered 404/422 on PATCH (already a
 *   collaborator, revoked or expired), the same end state for automation;
 * - `none` — no such invitation is pending; nothing is patched.
 *
 * Stateless, token-free errors; 401/403/429/network and other failures throw
 * {@link GithubApiError}.
 */
export async function acceptInvitationForRepo(
  token: string,
  repo: string,
  options: SetupHelperOptions = {},
): Promise<AcceptInvitationForRepoResult> {
  const normalized = repo.trim()
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(normalized)
  if (!match) {
    throw new GithubApiError({
      status: 422,
      method: 'GET',
      path: '/user/repository_invitations',
      details: 'invalid repository name (expected owner/name)',
    })
  }
  const target = `${match[1]}/${match[2]}`
  const api = setupApi(token, options)
  const page = await api.listRepositoryInvitations({ maxPages: 2, perPage: 100 })
  const invitation = page.items.find(
    item => (item.repository?.full_name ?? '').toLowerCase() === target.toLowerCase(),
  )
  if (!invitation) return { ok: true, repo: target, status: 'none' }
  const matchedRepo = invitation.repository?.full_name ?? target
  try {
    const result = await api.acceptRepositoryInvitation(invitation.id)
    return {
      ok: true,
      repo: matchedRepo,
      status: result.status === 204 ? 'accepted' : 'already-accepted-or-gone',
      invitationId: invitation.id,
    }
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 422) {
      return { ok: true, repo: matchedRepo, status: 'already-accepted-or-gone', invitationId: invitation.id }
    }
    throw error
  }
}
