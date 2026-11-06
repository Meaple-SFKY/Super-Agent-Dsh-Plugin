/**
 * GitHub Source.
 *
 * Polls the configured repositories through {@link GithubApi} and translates
 * what changed into Triggers. Reads are windowed by persisted cursors in
 * `ctx.kv` and all Trigger ids are deterministic, so a replayed window is
 * idempotent (the Engine answers `duplicate`).
 *
 * Identity mapping:
 * - one Thread per Issue/PR: `github:<owner>/<repo>#<number>`;
 * - the default branch's CI is its own Thread: `github:<owner>/<repo>#ci:<branch>`;
 * - Channel `to` is `owner/repo#number` (the Source posts issue/PR comments).
 *
 * Authorization filtering is Source-level: the agent's own account, unknown
 * bots, actors outside `allowedLogins` and (when a switch is off) unaddressed
 * events are dropped before they become Triggers. A mention of the agent's
 * login is always admitted, whatever the switches say.
 *
 * PR lifecycle: a new PR calls `callbacks.pullOpened` (the runtime binds it to
 * the Ticket owning the branch) and a closed/merged PR calls
 * `callbacks.threadClosed`. A failing default-branch CI change is a `ci`
 * Trigger; the first observation only establishes a baseline.
 */

import type {
  ChannelAddress,
  IsoTime,
  OutboundMessage,
  ReceiveDisposition,
  SendOutcome,
  ThreadKey,
  Trigger,
} from '../core/model.js'
import type { Source, SourceContext, SourceHealthState, SourceKind } from './kind.js'
import { makeTrigger } from './kind.js'
import {
  GithubApi,
  GithubApiError,
  GithubTokenError,
  abortError,
  createGithubTokenProvider,
  hasAgentMarker,
  isAbortError,
  sleepWithSignal,
  type GithubCheckRun,
  type GithubComment,
  type GithubInvitation,
  type GithubIssue,
  type GithubPage,
  type GithubPullRequest,
  type GithubReview,
  type GithubWorkflowRun,
} from './github-api.js'

/** Stable Source id; also the prefix of Thread keys and the Channel source. */
export const GITHUB_SOURCE = 'github'
const DEFAULT_ENV = 'SUPERAGENT_GITHUB_TOKEN'
/** Windows overlap a little so a slightly late remote write is not missed. */
const CURSOR_LAG_MS = 5000
/** Cap review reads per poll so one noisy repository cannot exhaust the rate limit. */
const MAX_REVIEW_PULLS = 10
/** Automatic repository discovery (`repositories: ['*']`) refresh cadence. */
const AUTO_REPOSITORIES_REFRESH_MS = 10 * 60_000
/** First retry delay after a failed discovery; doubles up to the refresh cadence. */
const AUTO_REPOSITORIES_RETRY_MS = 30_000
/** Discovery is capped so one very large account cannot blow the poll budget. */
const AUTO_REPOSITORIES_LIMIT = 200
/** Adaptive polling: a quiet repository backs off to 5–15 minutes. */
const QUIET_INTERVAL_MIN_MS = 5 * 60_000
const QUIET_INTERVAL_MAX_MS = 15 * 60_000
/** Above this wildcard size, quiet repositories are pinned to the slow cadence. */
const WILDCARD_SOFT_CAP = 10
/** `notifications: 'auto'` switches to the cheap notification stream from here. */
const NOTIFICATIONS_AUTO_THRESHOLD = 8
/** A notification keeps its repository "active" (fast polling) this long. */
const NOTIFICATIONS_ACTIVE_MS = 5 * 60_000
/** Reserve quota before entering a global cooldown. */
const RATE_LIMIT_MIN_REMAINING = 100
const COOLDOWN_MAX_MS = 15 * 60_000
const FAILED_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'action_required',
  'startup_failure',
  'cancelled',
])

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** A pull request that just appeared; the runtime binds it to a Ticket. */
export interface GithubPullInfo {
  repo: string
  number: number
  /** The PR Thread key, e.g. `github:owner/repo#12`; pass it to `bindThread`. */
  thread: ThreadKey
  url: string
  title: string
  head: string
  base: string
  author: string
  draft: boolean
  at: IsoTime
}

/**
 * Callbacks the runtime wires to the Engine (the Source has no access to
 * Tickets or the Engine itself):
 * - `pullOpened` -> look the branch up and call `EngineForSources.bindThread`;
 * - `threadClosed` -> `EngineForSources.threadClosed`.
 */
export interface GithubCallbacks {
  pullOpened?(pull: GithubPullInfo): void
  threadClosed?(thread: ThreadKey, outcome: 'merged' | 'closed', at: IsoTime): void
}

/**
 * Configuration of one GitHub Source. `repositories` is the allowlist; the
 * observe switches only widen what is admitted beyond `@mention`s.
 */
export interface GithubConfig {
  enabled?: boolean
  /** Environment variable holding the token. */
  tokenEnv?: string
  /** File containing the token; wins over `tokenEnv`. */
  tokenFile?: string
  /**
   * Repositories to watch, `owner/name`. `"*"` discovers every repository the
   * token can access (owner/collaborator/organization member, at most 200),
   * refreshed about every 10 minutes and after a failed refresh; explicit
   * entries are always kept and may be combined with `"*"`.
   */
  repositories?: string[]
  /** The agent's own login; fetched from `/user` when unset. */
  login?: string
  /**
   * Admit events authored by `login` itself. Default false, which is the safe
   * choice for a dedicated agent account. Set true when the user's own personal
   * PAT (same account) is used to drive the agent from GitHub; the Source still
   * drops its own marked output (comments / PR bodies containing
   * `<!-- superagent:`) so it cannot trigger itself in a loop.
   */
  allowSelf?: boolean
  /** Humans whose events are admitted. Empty means every human except `login`. */
  allowedLogins?: string[]
  /** Bots whose events are admitted (as inferred candidates). */
  botLogins?: string[]
  /**
   * Which repository invitations the bot may accept automatically:
   * `off`, `allowlist` (default; inviter/owner must be in allowedLogins or
   * collaborators) or `all`.
   */
  acceptInvitations?: 'off' | 'allowlist' | 'all'
  /** Logins invited as repository collaborators (also trusted inviters). */
  collaborators?: string[]
  /** Admit unaddressed new Issues (mentions are always admitted). */
  observeIssues?: boolean
  /** Admit unaddressed new Pull Requests (mentions are always admitted). */
  observePulls?: boolean
  /** Admit unaddressed comments/reviews (mentions are always admitted). */
  observeComments?: boolean
  /** Poll the default branch's CI. Default false. */
  observeCi?: boolean
  /** Poll interval in seconds (10..3600, default 60). */
  pollSeconds?: number
  /**
   * Cheap cross-repository notification stream:
   * `auto` (default; enabled for large wildcard sets), `on` or `off`.
   * When GitHub rejects it, repository polling is used as before.
   */
  notifications?: 'auto' | 'off' | 'on'
  /** Maximum characters of GitHub text copied into a Trigger (default 16000). */
  maxTextChars?: number
  /** Per-repository adaptive cadence (default true; disable for tests/debug). */
  adaptivePolling?: boolean
  /** GitHub API base URL; only changed in tests. */
  apiBaseUrl?: string
  /** Lifecycle callbacks injected by the runtime. */
  callbacks?: GithubCallbacks
}

interface NormalizedGithubConfig {
  tokenEnv?: string
  tokenFile?: string
  repositories: string[]
  login?: string
  allowSelf: boolean
  allowedLogins: string[]
  botLogins: string[]
  acceptInvitations: 'off' | 'allowlist' | 'all'
  collaborators: string[]
  observeIssues: boolean
  observePulls: boolean
  observeComments: boolean
  observeCi: boolean
  pollSeconds: number
  notifications: 'auto' | 'off' | 'on'
  maxTextChars: number
  adaptivePolling: boolean
  apiBaseUrl?: string
  callbacks?: GithubCallbacks
}

function stringList(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  for (const value of values) {
    const item = String(value).trim()
    if (item) seen.add(item)
  }
  return [...seen]
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** Apply defaults; unknown/blank repository entries are dropped. */
export function normalizeGithubConfig(config: GithubConfig = {}): NormalizedGithubConfig {
  const repositories: string[] = []
  let wildcard = false
  for (const value of stringList(config.repositories)) {
    if (value === '*') {
      wildcard = true
      continue
    }
    const parts = value.split('/')
    if (parts.length === 2 && parts[0] && parts[1]) repositories.push(`${parts[0]}/${parts[1]}`)
  }
  const normalizedRepositories = [...new Set(repositories)]
  if (wildcard) normalizedRepositories.unshift('*')
  return {
    ...(config.tokenEnv?.trim() ? { tokenEnv: config.tokenEnv.trim() } : {}),
    ...(config.tokenFile?.trim() ? { tokenFile: config.tokenFile.trim() } : {}),
    repositories: normalizedRepositories,
    ...(config.login?.trim() ? { login: config.login.trim() } : {}),
    allowSelf: config.allowSelf === true,
    allowedLogins: stringList(config.allowedLogins),
    botLogins: stringList(config.botLogins),
    acceptInvitations:
      config.acceptInvitations === 'off' || config.acceptInvitations === 'all'
        ? config.acceptInvitations
        : 'allowlist',
    collaborators: stringList(config.collaborators),
    observeIssues: config.observeIssues === true,
    observePulls: config.observePulls === true,
    observeComments: config.observeComments === true,
    observeCi: config.observeCi === true,
    pollSeconds: clampNumber(config.pollSeconds ?? 60, 10, 3600),
    notifications:
      config.notifications === 'off' || config.notifications === 'on' ? config.notifications : 'auto',
    maxTextChars: clampNumber(config.maxTextChars ?? 16_000, 1_000, 64_000),
    adaptivePolling: config.adaptivePolling !== false,
    ...(config.apiBaseUrl?.trim() ? { apiBaseUrl: config.apiBaseUrl.trim().replace(/\/+$/, '') } : {}),
    ...(config.callbacks ? { callbacks: config.callbacks } : {}),
  }
}

/**
 * Late-wiring fallback for the lifecycle callbacks, for embedders that create
 * the Source before they can build the Engine. `config.callbacks` wins.
 */
let fallbackCallbacks: GithubCallbacks | undefined

export function setGithubCallbacks(callbacks: GithubCallbacks | undefined): void {
  fallbackCallbacks = callbacks
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

interface StreamCursor {
  /** ISO timestamp; the next read starts here. */
  since: string
  etag?: string
}

interface RepoCursors {
  version: 1
  startedAt: string
  issues: StreamCursor
  pulls: StreamCursor
  issueComments: StreamCursor
  reviewComments: StreamCursor
  reviews: StreamCursor
}

interface TrackedPull {
  state: 'open' | 'closed'
  merged: boolean
  title: string
  url: string
  head: string
  base: string
  author: string
  updatedAt: string
}

type TrackedPulls = Record<string, TrackedPull>

interface CiState {
  branch: string
  fingerprint: string
  revision: number
  failing: string[]
  headSha?: string
}

const KV = {
  cursors: (repo: string): string => `github:cursors:${repo}`,
  pulls: (repo: string): string => `github:pulls:${repo}`,
  ci: (repo: string): string => `github:ci:${repo}`,
  reviews: (repo: string): string => `github:reviews:${repo}`,
}

interface CiSnapshot {
  failing: string[]
  running: number
  passing: number
  total: number
  headSha?: string
}

function summarizeCi(checks: GithubCheckRun[], runs: GithubWorkflowRun[]): CiSnapshot {
  const failing = new Set<string>()
  let running = 0
  let passing = 0
  let headSha: string | undefined
  for (const check of checks) {
    if (check.head_sha) headSha = check.head_sha
    if (check.status !== 'completed') {
      running += 1
      continue
    }
    const conclusion = (check.conclusion ?? '').toLowerCase()
    if (FAILED_CONCLUSIONS.has(conclusion)) failing.add(check.name)
    else if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') passing += 1
  }
  for (const run of runs) {
    if (!headSha && run.head_sha) headSha = run.head_sha
    if (run.status !== 'completed') {
      running += 1
      continue
    }
    const conclusion = (run.conclusion ?? '').toLowerCase()
    const name = run.name || run.display_title || `run ${run.id}`
    if (FAILED_CONCLUSIONS.has(conclusion)) failing.add(name)
    else if (conclusion === 'success') passing += 1
  }
  return {
    failing: [...failing].sort(),
    running,
    passing,
    total: checks.length + runs.length,
    ...(headSha ? { headSha } : {}),
  }
}

/**
 * Both CI read APIs were denied. This is an actionable configuration problem,
 * so the Source reports one short message instead of one 403 per repository
 * poll: either grant Actions: Read (sufficient) or Checks: Read.
 */
export class CiPermissionError extends Error {
  readonly repo: string

  constructor(repo: string, detail?: string) {
    super(`CI needs Actions: Read (or Checks: Read) permission for ${repo}${detail ? ` (${detail})` : ''}`)
    this.name = 'CiPermissionError'
    this.repo = repo
  }
}

/** 403/404 mean "this token may not or cannot read this API"; either side may degrade. */
function isCiPermissionDenied(error: unknown): boolean {
  return error instanceof GithubApiError && (error.status === 403 || error.status === 404)
}

function describeCiReadError(error: unknown): string {
  if (error instanceof GithubApiError) {
    return error.status === 0 ? 'network error' : `HTTP ${error.status}${error.details ? `: ${error.details}` : ''}`
  }
  return error instanceof Error ? error.message : String(error)
}

/** Extract `owner/repo` from a notification subject API URL. */
function repoFromNotification(item: { subject?: { url?: string } }): string | undefined {
  const url = item.subject?.url
  if (!url) return undefined
  const match = /\/repos\/([^/]+\/[^/]+)\/(?:issues|pulls|commits)\//.exec(url)
  return match?.[1]
}

function sameName(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left) && Boolean(right) && left!.toLowerCase() === right!.toLowerCase()
}

function threadKeyFor(repo: string, number: number): ThreadKey {
  return `${GITHUB_SOURCE}:${repo}#${number}`
}

function ciThreadKey(repo: string, branch: string): ThreadKey {
  return `${GITHUB_SOURCE}:${repo}#ci:${branch}`
}

/** Parse `owner/repo#123` from a Channel `to` value; CI destinations fail. */
export function parseCommentTarget(value: string): { repo: string; number: number } | undefined {
  const match = /^([^\s#]+\/[^\s#]+)#(\d+)$/.exec(value.trim())
  if (!match) return undefined
  const number = Number(match[2])
  if (!Number.isFinite(number) || number <= 0) return undefined
  return { repo: match[1]!, number }
}

function numberFromUrl(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = /\/(?:issues|pulls?)\/(\d+)(?:\/|$|#)/.exec(value)
  if (!match) return undefined
  const number = Number(match[1])
  return Number.isFinite(number) && number > 0 ? number : undefined
}

// ---------------------------------------------------------------------------
// Source implementation
// ---------------------------------------------------------------------------

/**
 * The Engine could not store a Trigger. Thrown out of the current stream so its
 * cursor/`advance` never runs; the next poll re-reads the same window and the
 * Engine deduplicates the events that were already stored.
 */
export class ReceiveFailedError extends Error {
  readonly triggerId: string
  constructor(triggerId: string, detail?: string) {
    super(`github: Trigger ${triggerId} was not stored by the Engine${detail ? `: ${detail}` : ''}`)
    this.name = 'ReceiveFailedError'
    this.triggerId = triggerId
  }
}

/**
 * A repository answered 404/410 on a repository-level read: it was deleted,
 * renamed, or the token lost access. `pollOnce` turns this into "remove it from
 * the wildcard set" instead of repeating the same failure every minute.
 */
export class RepositoryGoneError extends Error {
  readonly repo: string
  readonly status: number

  constructor(repo: string, status: number) {
    super(`repository ${repo} is not accessible (HTTP ${status})`)
    this.name = 'RepositoryGoneError'
    this.repo = repo
    this.status = status
  }
}

function repositoryGoneStatus(error: unknown): number | undefined {
  if (error instanceof GithubApiError && (error.status === 404 || error.status === 410)) {
    return error.status
  }
  return undefined
}

/**
 * Collapse a health detail to one short line for the panel: no newlines, no
 * URLs, no query strings, at most `maxLength` characters.
 */
export function sanitizeHealthDetail(text: string, maxLength = 160): string {
  const singleLine = text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/git@\S+/gi, '')
    .replace(/\/repos\/\S*/gi, '')
    .replace(/\?\S*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (singleLine.length <= maxLength) return singleLine
  return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`
}

const FAILED_REPO_STATUS = /HTTP (\d{3})/

function firstFailedStatus(errors: string[]): string | undefined {
  for (const error of errors) {
    const match = FAILED_REPO_STATUS.exec(error)
    if (match) return `HTTP ${match[1]}`
  }
  return undefined
}

/** A few-word category for a failure without an HTTP status (token, timeout...). */
function failureTag(errors: string[]): string | undefined {
  const status = firstFailedStatus(errors)
  if (status) return status
  const text = errors.join(' ')
  if (/token/i.test(text)) return 'token'
  if (/timeout/i.test(text)) return 'timeout'
  if (/network|fetch failed|ECONN/i.test(text)) return 'network'
  if (/discovery/i.test(text)) return 'discovery'
  return undefined
}

export interface GithubPollResult {
  /** Repositories actually polled this round (quiet ones are skipped). */
  repos: number
  emitted: number
  filtered: number
  errors: string[]
  /** Non-fatal problems (e.g. stale automatic repository discovery). */
  warnings: string[]
  /** Repositories dropped from the wildcard set because they returned 404/410. */
  removed: string[]
  /** HTTP requests made this round (including 304s). */
  requests: number
  /** Conditional requests answered 304 (free on the primary rate limit). */
  notModified: number
  /** Latest primary rate-limit snapshot. */
  rateLimitRemaining?: number
  rateLimitResetAt?: number
  /** When the Source is cooling down after rate limiting, the wake-up time. */
  cooldownUntil?: number
  /** Which polling path handled the round. */
  notifications: 'on' | 'off' | 'fallback'
}

interface RepoPollResult {
  emitted: number
  filtered: number
}

type HealthState = SourceHealthState

export class GithubSource implements Source {
  readonly id: string = GITHUB_SOURCE
  readonly kind: string = GITHUB_SOURCE

  private readonly ctx: SourceContext
  private readonly config: NormalizedGithubConfig
  private api: GithubApi | undefined
  private login: string | undefined
  private controller: AbortController | undefined
  private loopPromise: Promise<void> | undefined
  private lastHealth: HealthState = 'off'
  private readonly branchCache = new Map<string, string>()
  /** Resolved repositories when `repositories` contains `"*"`. */
  private autoRepositories: { repositories: string[]; resolvedAt: number } | undefined
  private autoRepositoryFailures = 0
  private autoRepositoryLastAttempt = 0
  private autoRepositoryLastError: string | undefined
  /** Explicit-list repositories already warned about a 404, so we warn once. */
  private readonly warnedGoneRepositories = new Set<string>()
  /** Per-repository adaptive cadence (quiet repositories back off). */
  private readonly repoPollState = new Map<string, { nextPollAt: number; quiet: number }>()
  private readonly notificationsActiveUntil = new Map<string, number>()
  private notificationsFallback = false
  private cooldownUntil = 0
  private rateLimitFailures = 0
  /** Last cumulative API counters, for per-round deltas. */
  private lastStats = { requests: 0, notModified: 0 }
  /** Invitations already accepted (or tolerated as gone), to avoid re-PATCHing. */
  private readonly acceptedInvitations = new Set<number>()
  /** Untrusted invitations already logged, to avoid log spam. */
  private readonly warnedInvitations = new Set<number>()
  /** Whether the start-up scan of pending invitations has run. */
  private invitationsChecked = false

  constructor(config: GithubConfig, ctx: SourceContext) {
    this.ctx = ctx
    this.config = normalizeGithubConfig(config)
    if (this.config.login) this.login = this.config.login
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.controller) return
    this.controller = new AbortController()
    this.report('starting', 'starting GitHub polling')
    const signal = this.controller.signal
    this.loopPromise = this.runLoop(signal).catch((error: unknown) => {
      if (!signal.aborted) this.report('error', `polling loop stopped: ${describeError(error)}`)
    })
  }

  async stop(): Promise<void> {
    this.controller?.abort()
    try {
      await this.loopPromise
    } catch {
      // The loop reports its own failures.
    }
    this.controller = undefined
    this.loopPromise = undefined
    this.report('off', 'stopped')
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let failures = 0
    let delay = 1000
    while (!signal.aborted) {
      try {
        const result = await this.pollOnce(signal)
        failures = result.errors.length > 0 ? failures + 1 : 0
        if (signal.aborted) break
        this.report(failures >= 3 ? 'error' : 'ready', this.healthDetail(result))
        const now = Date.parse(this.ctx.now())
        const sleepMs = this.nextSleepMs(result, Number.isFinite(now) ? now : Date.now())
        await this.sleep(sleepMs, signal)
      } catch (error) {
        if (signal.aborted) break
        failures += 1
        const detail = describeError(error)
        if (failures >= 3) this.report('error', `poll failed ${failures} times: ${detail}`)
        else this.report('starting', `poll retrying (${failures}): ${detail}`)
        await this.sleep(delay, signal).catch(() => undefined)
        delay = Math.min(delay * 2, 60_000)
      }
    }
    if (signal.aborted) this.report('off', 'stopped')
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return sleepWithSignal(ms, signal)
  }

  private report(state: HealthState, detail: string): void {
    this.lastHealth = state
    try {
      // The panel shows this verbatim: keep it one short line, no URLs.
      this.ctx.health({ name: GITHUB_SOURCE, state, detail: sanitizeHealthDetail(detail), at: this.ctx.now() })
    } catch {
      // Never let health reporting take the loop down.
    }
  }

  /** Last reported health state, for tests and diagnostics. */
  healthState(): HealthState {
    return this.lastHealth
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  private getApi(): GithubApi {
    if (!this.api) {
      this.api = new GithubApi({
        token: createGithubTokenProvider({
          ...(this.config.tokenEnv ? { tokenEnv: this.config.tokenEnv } : {}),
          ...(this.config.tokenFile ? { tokenFile: this.config.tokenFile } : {}),
          defaultEnv: DEFAULT_ENV,
        }),
        ...(this.config.apiBaseUrl ? { baseUrl: this.config.apiBaseUrl } : {}),
      })
    }
    return this.api
  }

  /**
   * One polling round over every configured repository. Per-repository and
   * per-stream failures are collected, never thrown out of the loop.
   */
  async pollOnce(signal: AbortSignal): Promise<GithubPollResult> {
    const api = this.getApi()
    const roundAt = this.ctx.now()
    const now = Date.parse(roundAt)
    const clock = Number.isFinite(now) ? now : Date.now()
    const statsBefore = api.stats()
    if (this.cooldownUntil > clock) {
      // Global rate-limit cooldown: make no requests at all this round.
      return {
        repos: 0,
        emitted: 0,
        filtered: 0,
        errors: [],
        warnings: [],
        removed: [],
        requests: 0,
        notModified: 0,
        ...(statsBefore.rateLimit.remaining !== undefined
          ? { rateLimitRemaining: statsBefore.rateLimit.remaining }
          : {}),
        ...(statsBefore.rateLimit.resetAt !== undefined ? { rateLimitResetAt: statsBefore.rateLimit.resetAt } : {}),
        cooldownUntil: this.cooldownUntil,
        notifications: this.notificationsFallback ? 'fallback' : 'off',
      }
    }
    if (!this.login) {
      const user = await api.getAuthenticatedUser({ signal })
      this.login = user.login
    }
    const errors: string[] = []
    // Start-up scan: accept pending invitations addressed to the bot account so
    // an operator-invited repository can be discovered in the same round.
    const accepted = await this.acceptPendingInvitations(api, signal)
    if (accepted > 0) this.requestDiscoveryRefresh()
    // Resolve `repositories: ['*']` before the round; a failure with no cached
    // list is reported as a read error and retried on the next poll.
    try {
      await this.refreshAutoRepositories(api, signal)
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error
      errors.push(`repository discovery: ${describeError(error)}`)
    }
    const warnings: string[] = []
    if (this.autoRepositoryLastError && this.autoRepositories) {
      warnings.push(`repository discovery: ${this.autoRepositoryLastError}`)
    } else if (this.autoRepositoryLastError && !this.autoRepositories) {
      // Nothing to poll yet: keep the failure visible in health until the
      // backoff elapses and discovery is retried.
      warnings.push(`repository discovery: retrying after error: ${this.autoRepositoryLastError}`)
    }
    const repositories = this.effectiveRepositories()
    // Cheap cross-repository activity hint before the per-repository fan-out.
    const notificationMode: 'on' | 'off' | 'fallback' = this.notificationsEnabled(repositories.length)
      ? await this.pollNotifications(api, signal, clock)
      : 'off'
    const result: GithubPollResult = {
      repos: 0,
      emitted: 0,
      filtered: 0,
      errors,
      warnings,
      removed: [],
      requests: 0,
      notModified: 0,
      notifications: notificationMode,
    }
    for (const repo of repositories) {
      if (signal.aborted) throw abortError()
      if (!this.repoDue(repo, clock)) continue
      let repoResult: RepoPollResult | undefined
      try {
        repoResult = await this.pollRepo(api, repo, signal)
        result.emitted += repoResult.emitted
        result.filtered += repoResult.filtered
        this.noteRepositoryPolled(repo, clock, repoResult.emitted, false)
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error
        if (error instanceof RepositoryGoneError) {
          const outcome = this.handleRepositoryGone(repo)
          if (outcome === 'auto') {
            result.removed.push(repo)
            this.ctx.logger.info('github: discovered repository disappeared; refreshing discovery', { repo })
          }
          this.repoPollState.delete(repo)
          continue
        }
        this.ctx.logger.warn('github: repository poll failed', { repo, error: describeError(error) })
        result.errors.push(`${repo}: ${describeError(error)}`)
        this.noteRepositoryPolled(repo, clock, 0, true)
      }
      void repoResult
    }
    if (result.removed.length > 0) {
      // The deleted repository is already out of the cached set; refresh now so
      // a rename/replacement is picked up without waiting for the 10-minute tick.
      try {
        await this.refreshAutoRepositories(api, signal)
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error
        result.warnings.push(`repository discovery: ${describeError(error)}`)
      }
    }
    result.repos = this.effectiveRepositories().length
    const statsAfter = api.stats()
    result.requests = statsAfter.requests - statsBefore.requests
    result.notModified = statsAfter.notModified - statsBefore.notModified
    const rate = statsAfter.rateLimit
    if (rate.remaining !== undefined) result.rateLimitRemaining = rate.remaining
    if (rate.resetAt !== undefined) result.rateLimitResetAt = rate.resetAt
    this.applyRateLimitSignals(result, rate, clock)
    return result
  }

  /** Global cooldown logic: reserve quota, then exponential backoff on 403/429. */
  private applyRateLimitSignals(
    result: GithubPollResult,
    rate: { remaining?: number; resetAt?: number },
    now: number,
  ): void {
    const rateLimited = result.errors.some(
      error => /\b(403|429)\b/.test(error) && /rate limit|secondary rate|abuse/i.test(error),
    )
    if (rate.remaining !== undefined && rate.remaining <= RATE_LIMIT_MIN_REMAINING) {
      const until = rate.resetAt ?? now + 60_000
      this.cooldownUntil = Math.max(this.cooldownUntil, Math.min(until, now + COOLDOWN_MAX_MS))
      this.rateLimitFailures = Math.max(1, this.rateLimitFailures + 1)
      this.ctx.logger.warn('github: primary rate limit is nearly exhausted; cooling down', {
        remaining: rate.remaining,
        resetAt: new Date(until).toISOString(),
      })
    } else if (rateLimited) {
      this.rateLimitFailures += 1
      const backoff = Math.min(COOLDOWN_MAX_MS, 60_000 * 2 ** Math.min(this.rateLimitFailures - 1, 4))
      this.cooldownUntil = Math.max(this.cooldownUntil, now + backoff)
      this.ctx.logger.warn('github: rate limited; backing off globally', {
        backoffMs: backoff,
        failures: this.rateLimitFailures,
      })
    } else if (result.requests > 0) {
      this.rateLimitFailures = 0
    }
    if (this.cooldownUntil > now) result.cooldownUntil = this.cooldownUntil
  }

  private baseIntervalMs(): number {
    const configured = clampNumber(this.config.pollSeconds * 1000, 10_000, 3_600_000)
    // Wildcard soft cap: above 10 repositories even an active repository is
    // polled at most every 2 minutes, so 16+ repositories cannot exhaust the
    // hourly quota by all being busy at once.
    if (this.wantsAutoRepositories() && this.effectiveRepositories().length > WILDCARD_SOFT_CAP) {
      return Math.max(configured, 120_000)
    }
    return configured
  }

  private repoDue(repo: string, now: number): boolean {
    if (!this.config.adaptivePolling) return true
    const activeUntil = this.notificationsActiveUntil.get(repo)
    if (activeUntil !== undefined && activeUntil > now) return true
    const state = this.repoPollState.get(repo)
    return state === undefined || now >= state.nextPollAt
  }

  /**
   * Quiet repositories back off to 5–15 minutes; anything that produced an
   * event returns to the configured fast interval. Above the wildcard soft cap,
   * quiet repositories are pinned to the slowest cadence.
   */
  private noteRepositoryPolled(repo: string, now: number, emitted: number, failed: boolean): void {
    if (!this.config.adaptivePolling) return
    const state = this.repoPollState.get(repo) ?? { nextPollAt: 0, quiet: 0 }
    const base = this.baseIntervalMs()
    let interval: number
    if (emitted > 0) {
      state.quiet = 0
      interval = base
    } else {
      state.quiet = Math.min(state.quiet + 1, 6)
      interval = Math.min(QUIET_INTERVAL_MAX_MS, Math.max(QUIET_INTERVAL_MIN_MS, base * 2 ** state.quiet))
      if (failed) interval = Math.min(interval, QUIET_INTERVAL_MIN_MS)
      if (this.wantsAutoRepositories() && this.effectiveRepositories().length > WILDCARD_SOFT_CAP) {
        interval = Math.min(QUIET_INTERVAL_MAX_MS, Math.max(interval, QUIET_INTERVAL_MAX_MS))
      }
    }
    this.repoPollState.set(repo, { nextPollAt: now + interval, quiet: state.quiet })
  }

  private notificationsEnabled(repoCount: number): boolean {
    if (this.config.notifications === 'off' || this.notificationsFallback) return false
    if (this.config.notifications === 'on') return true
    return this.wantsAutoRepositories() && repoCount >= NOTIFICATIONS_AUTO_THRESHOLD
  }

  /**
   * Poll `GET /notifications` once and mark its repositories active, so only
   * repositories with real activity are polled on the fast cadence. A 403/404
   * means the endpoint is unavailable for this token: fall back permanently to
   * repository polling for this process.
   */
  private async pollNotifications(api: GithubApi, signal: AbortSignal, now: number): Promise<'on' | 'fallback'> {
    const stored = this.ctx.kv.get<{ since?: string; etag?: string }>('github:notifications') ?? {}
    try {
      const page = await api.listNotifications({
        ...(stored.since ? { since: stored.since } : {}),
        ...(stored.etag ? { etag: stored.etag } : {}),
        signal,
      })
      if (!page.notModified) {
        const activeUntil = now + NOTIFICATIONS_ACTIVE_MS
        for (const item of page.items) {
          const repo = repoFromNotification(item)
          if (repo) this.notificationsActiveUntil.set(repo, activeUntil)
        }
        this.ctx.kv.set('github:notifications', {
          since: new Date(now - CURSOR_LAG_MS).toISOString(),
          ...(page.etag ? { etag: page.etag } : {}),
        })
      }
      return 'on'
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error
      if (error instanceof GithubApiError && (error.status === 403 || error.status === 404)) {
        this.notificationsFallback = true
        this.ctx.logger.warn('github: notifications are unavailable for this token; using repository polling', {
          status: error.status,
        })
        return 'fallback'
      }
      this.ctx.logger.warn('github: notifications poll failed; using repository polling this round', {
        error: describeError(error),
      })
      return 'on'
    }
  }

  private nextSleepMs(result: GithubPollResult, now: number): number {
    if (result.cooldownUntil !== undefined && result.cooldownUntil > now) {
      return Math.min(COOLDOWN_MAX_MS, result.cooldownUntil - now)
    }
    let next = now + this.config.pollSeconds * 1000
    for (const state of this.repoPollState.values()) next = Math.min(next, state.nextPollAt)
    if (this.notificationsEnabled(this.effectiveRepositories().length)) {
      next = Math.min(next, now + this.config.pollSeconds * 1000)
    }
    return Math.max(1_000, next - now)
  }

  /** One short line for the panel; several repositories are summarised. */  /** One short line for the panel; several repositories are summarised. */
  private healthDetail(result: GithubPollResult): string {
    const auto = this.wantsAutoRepositories() ? ' (auto)' : ''
    const repositories = this.effectiveRepositories()
    const parts = [
      `${result.emitted} trigger(s), ${result.filtered} filtered`,
      `${result.repos} repo(s)${auto}${repositories[0] ? `: ${repositories[0]}` : ''}`,
    ]
    if (result.removed.length > 0) {
      parts.push(`${result.removed.length} repo removed (deleted or no access): ${result.removed[0]}`)
    }
    if (result.errors.length > 0) {
      const tag = failureTag(result.errors)
      const firstFailedRepo = result.errors[0]?.split(':')[0]
      parts.push(`${result.errors.length} repo failed${tag ? ` (${tag})` : ''}${firstFailedRepo ? `: ${firstFailedRepo}` : ''}`)
    }
    if (result.warnings.length > 0) parts.push(`${result.warnings.length} warning(s)`)
    parts.push(`req=${result.requests}(304=${result.notModified})`)
    if (result.rateLimitRemaining !== undefined) {
      const reset = result.rateLimitResetAt !== undefined
        ? `@${new Date(result.rateLimitResetAt).toISOString().slice(11, 16)}`
        : ''
      parts.push(`quota=${result.rateLimitRemaining}${reset}`)
    }
    if (result.cooldownUntil !== undefined) parts.push('cooldown')
    return sanitizeHealthDetail(parts.join('; '))
  }

  // -------------------------------------------------------------------------
  // Automatic repository discovery (`repositories: ['*']`)
  // -------------------------------------------------------------------------

  private wantsAutoRepositories(): boolean {
    return this.config.repositories.includes('*')
  }

  private explicitRepositories(): string[] {
    return this.config.repositories.filter(repo => repo !== '*')
  }

  /** Explicit entries first, then discovered repositories (case-insensitively deduped). */
  private effectiveRepositories(): string[] {
    const repositories = [...this.explicitRepositories()]
    const seen = new Set(repositories.map(repo => repo.toLowerCase()))
    for (const repo of this.autoRepositories?.repositories ?? []) {
      const key = repo.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      repositories.push(repo)
    }
    return repositories
  }

  private autoRepositoriesDue(now: number): boolean {
    if (!this.wantsAutoRepositories()) return false
    if (!this.autoRepositories) {
      if (this.autoRepositoryFailures === 0) return true
      return this.autoRetryDue(now)
    }
    if (this.autoRepositoryFailures > 0) return this.autoRetryDue(now)
    if (!Number.isFinite(now)) return true
    return now - this.autoRepositories.resolvedAt >= AUTO_REPOSITORIES_REFRESH_MS
  }

  private autoRetryDue(now: number): boolean {
    if (!Number.isFinite(now)) return true
    const delay = Math.min(
      AUTO_REPOSITORIES_REFRESH_MS,
      AUTO_REPOSITORIES_RETRY_MS * 2 ** Math.max(0, this.autoRepositoryFailures - 1),
    )
    return now - this.autoRepositoryLastAttempt >= delay
  }

  /**
   * Refresh the discovered repository set on startup, about every 10 minutes,
   * and after a failure (with backoff). A failed refresh keeps using the cached
   * list so a transient API error does not stop polling.
   */
  private async refreshAutoRepositories(api: GithubApi, signal: AbortSignal): Promise<void> {
    if (!this.wantsAutoRepositories()) return
    const now = Date.parse(this.ctx.now())
    if (!this.autoRepositoriesDue(now)) return
    this.autoRepositoryLastAttempt = now
    try {
      const page = await api.listUserRepositories({ signal, maxPages: 2, perPage: 100 })
      const repositories = page.items
        .map(item => (typeof item.full_name === 'string' ? item.full_name : ''))
        .filter(name => name.length > 0)
        .slice(0, AUTO_REPOSITORIES_LIMIT)
      this.autoRepositories = { repositories, resolvedAt: now }
      this.autoRepositoryFailures = 0
      this.autoRepositoryLastError = undefined
      this.ctx.logger.debug('github: automatic repository discovery refreshed', {
        repositories: repositories.length,
        truncated: page.truncated,
      })
      // After every discovery refresh, drain invitations and refresh once more
      // so a repository the bot was just invited into enters the poll set now.
      const accepted = await this.acceptPendingInvitations(api, signal, { force: true })
      if (accepted > 0 && this.autoRepositories) {
        this.requestDiscoveryRefresh()
        await this.refreshAutoRepositories(api, signal)
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error
      this.autoRepositoryFailures += 1
      this.autoRepositoryLastError = describeError(error)
      if (this.autoRepositories) {
        // Keep polling what we already know; retry sooner than the full cadence.
        this.ctx.logger.warn('github: repository discovery failed; using the cached list', {
          error: this.autoRepositoryLastError,
        })
        return
      }
      throw error
    }
  }

  /** Make the next discovery pass run immediately (e.g. after joining a repo). */
  private requestDiscoveryRefresh(): void {
    if (this.autoRepositories) {
      this.autoRepositories = { repositories: this.autoRepositories.repositories, resolvedAt: 0 }
    }
  }

  /**
   * Accept the pending repository invitations of the bot account. Stateless
   * per call; failures are logged (warn) and never block polling. Returns the
   * number of invitations this call moved to the accepted state.
   *
   * Runs once at start-up and after every successful discovery refresh (these
   * are the moments an operator's invite should become a watched repository).
   */
  private async acceptPendingInvitations(
    api: GithubApi,
    signal: AbortSignal,
    options: { force?: boolean } = {},
  ): Promise<number> {
    // `off` never even lists invitations (saves quota and cannot be abused).
    if (this.config.acceptInvitations === 'off') return 0
    if (this.invitationsChecked && !options.force) return 0
    this.invitationsChecked = true
    let accepted = 0
    let page: GithubPage<GithubInvitation>
    try {
      page = await api.listRepositoryInvitations({ signal, maxPages: 2, perPage: 100 })
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error
      // 404 = this token/API does not expose invitations; not worth a warning
      // on every poll.
      if (error instanceof GithubApiError && error.status === 404) {
        this.ctx.logger.debug('github: repository invitations are not available for this token')
        return 0
      }
      this.ctx.logger.warn('github: could not list repository invitations', { error: describeError(error) })
      return 0
    }
    for (const invitation of page.items) {
      if (signal.aborted) throw abortError()
      if (!invitation || typeof invitation.id !== 'number' || this.acceptedInvitations.has(invitation.id)) continue
      if (this.config.acceptInvitations === 'allowlist' && !this.invitationTrusted(invitation)) {
        if (!this.warnedInvitations.has(invitation.id)) {
          this.warnedInvitations.add(invitation.id)
          this.ctx.logger.info('github: skipped repository invitation from an untrusted inviter', {
            invitationId: invitation.id,
            ...(invitation.repository?.full_name ? { repo: invitation.repository.full_name } : {}),
            ...(invitation.inviter?.login ? { inviter: invitation.inviter.login } : {}),
          })
        }
        continue
      }
      const repository = invitation.repository?.full_name
      try {
        const result = await api.acceptRepositoryInvitation(invitation.id, { signal })
        this.acceptedInvitations.add(invitation.id)
        accepted += 1
        if (result.status === 204) {
          this.ctx.logger.info('github: accepted repository invitation', {
            invitationId: invitation.id,
            ...(repository ? { repo: repository } : {}),
          })
        } else {
          this.ctx.logger.debug('github: repository invitation already accepted or gone', {
            invitationId: invitation.id,
            ...(repository ? { repo: repository } : {}),
          })
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error
        // 422 = already a collaborator / invitation consumed; same end state.
        if (error instanceof GithubApiError && error.status === 422) {
          this.acceptedInvitations.add(invitation.id)
          accepted += 1
          this.ctx.logger.debug('github: repository invitation already accepted or gone', {
            invitationId: invitation.id,
            ...(repository ? { repo: repository } : {}),
          })
          continue
        }
        this.ctx.logger.warn('github: could not accept repository invitation', {
          invitationId: invitation.id,
          ...(repository ? { repo: repository } : {}),
          error: describeError(error),
        })
      }
    }
    return accepted
  }

  /**
   * `allowlist` mode: only invitations from a trusted login (token account,
   * allowedLogins or configured collaborators) or into a trusted owner's
   * repository are accepted; anything else is skipped and logged.
   */
  private invitationTrusted(invitation: {
    repository?: { owner?: { login?: string } }
    inviter?: { login?: string }
  }): boolean {
    const trusted = new Set<string>()
    if (this.login) trusted.add(this.login.toLowerCase())
    for (const login of this.config.allowedLogins) trusted.add(login.toLowerCase())
    for (const login of this.config.collaborators) trusted.add(login.toLowerCase())
    const inviter = invitation.inviter?.login?.toLowerCase()
    const owner = invitation.repository?.owner?.login?.toLowerCase()
    return Boolean((inviter && trusted.has(inviter)) || (owner && trusted.has(owner)))
  }

  /**
   * A repository read answered 404/410. Wildcard-discovered repositories are
   * dropped from the resolved set (the next refresh decides whether it was
   * renamed); explicit entries stay configured and only warn once.
   */
  private handleRepositoryGone(repo: string): 'auto' | 'explicit' {
    const auto = this.autoRepositories
    if (auto && auto.repositories.some(candidate => sameName(candidate, repo))) {
      this.autoRepositories = {
        repositories: auto.repositories.filter(candidate => !sameName(candidate, repo)),
        resolvedAt: 0, // force a discovery refresh on the next opportunity
      }
      this.forgetRepository(repo)
      return 'auto'
    }
    const key = repo.toLowerCase()
    if (!this.warnedGoneRepositories.has(key)) {
      this.warnedGoneRepositories.add(key)
      this.ctx.logger.warn(
        'github: repository is not accessible (404); keeping the explicit entry in repositories',
        { repo },
      )
    }
    return 'explicit'
  }

  /** Drop per-repository poll state once a repository is gone for good. */
  private forgetRepository(repo: string): void {
    try {
      this.branchCache.delete(repo)
      this.ctx.kv.delete(KV.cursors(repo))
      this.ctx.kv.delete(KV.pulls(repo))
      this.ctx.kv.delete(KV.ci(repo))
      this.ctx.kv.delete(KV.reviews(repo))
    } catch {
      // State cleanup is best effort; polling must continue.
    }
  }

  private async pollRepo(api: GithubApi, repo: string, signal: AbortSignal): Promise<RepoPollResult> {
    const cursors = this.loadCursors(repo)
    const trackedPulls = this.loadTrackedPulls(repo)
    // Cursors advance by the round's start time (minus a safety lag), not by the
    // newest item: item times can stay inside the window forever and re-read the
    // same page. The lag absorbs slightly late remote writes; deterministic ids
    // make the overlap harmless.
    const roundStartedAt = this.ctx.now()
    const result: RepoPollResult = { emitted: 0, filtered: 0 }
    const errors: string[] = []
    const receive = (trigger: Trigger | undefined): void => {
      if (!trigger) {
        result.filtered += 1
        return
      }
      let outcome: ReceiveDisposition
      try {
        outcome = this.ctx.receive(trigger)
      } catch (error) {
        throw new ReceiveFailedError(trigger.id, describeError(error))
      }
      if (outcome === 'failed') throw new ReceiveFailedError(trigger.id, 'Engine reported failed')
      if (outcome === 'stored') result.emitted += 1
    }
    const attempt = async (label: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run()
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error
        // A 404/410 on a repository-level read means the repository itself is
        // gone; `pollOnce` decides whether to drop it or warn once.
        const gone = repositoryGoneStatus(error)
        if (gone !== undefined) throw new RepositoryGoneError(repo, gone)
        errors.push(`${label}: ${describeError(error)}`)
      }
    }

    // New/updated Issues (the endpoint also lists PRs; the pulls stream owns those).
    await attempt('issues', async () => {
      const page = await api.listIssuesUpdatedSince(repo, cursors.issues.since, {
        signal,
        ...(cursors.issues.etag ? { etag: cursors.issues.etag } : {}),
      })
      if (page.notModified) return
      const issuesSince = cursors.issues.since
      for (const issue of page.items) {
        // The `since` window is by `updated_at`; only a newly created Issue is
        // an `issue` event. Later activity arrives as comments.
        if (issue.pull_request || !this.isNewItem(issue.created_at, issuesSince)) continue
        receive(this.issueTrigger(repo, issue))
      }
      if (page.truncated && page.items.length > 0) {
        // desc order returns the newest items first; when the page cap stopped
        // us, move the cursor to the oldest item we saw so the next round reads
        // the older remainder instead of re-reading the same newest page.
        const oldest = page.items.reduce((min, item) => {
          const at = Date.parse(item.updated_at)
          return Number.isFinite(at) && at < min ? at : min
        }, Number.POSITIVE_INFINITY)
        if (Number.isFinite(oldest)) cursors.issues.since = new Date(oldest).toISOString()
        delete cursors.issues.etag
      } else {
        this.advance(cursors.issues, roundStartedAt, page, page.items.length)
      }
      this.saveCursors(repo, cursors)
    })

    // New PRs and lifecycle changes (closed / merged), plus per-PR reviews.
    await attempt('pulls', async () => {
      const page = await api.listPullsUpdatedSince(repo, cursors.pulls.since, {
        signal,
        ...(cursors.pulls.etag ? { etag: cursors.pulls.etag } : {}),
      })
      if (page.notModified) return
      const reviewSince = cursors.reviews.since
      const reviewCandidates: GithubPullRequest[] = []
      for (const pull of page.items) {
        const key = String(pull.number)
        const previous = trackedPulls[key]
        const closed = pull.state !== 'open' || pull.merged === true || Boolean(pull.merged_at)
        const closedNow = Boolean(previous && previous.state === 'open' && closed)
        if (closedNow) delete trackedPulls[key]
        else {
          trackedPulls[key] = {
            state: closed ? 'closed' : 'open',
            merged: pull.merged === true || Boolean(pull.merged_at),
            title: pull.title,
            url: pull.html_url ?? '',
            head: pull.head.ref ?? '',
            base: pull.base.ref ?? '',
            author: pull.user.login,
            updatedAt: pull.updated_at,
          }
        }
        // Persist the lifecycle decision before firing callbacks. If a later
        // `receive` in this window fails and the cursor stays put, the next
        // round must not repeat pullOpened/threadClosed for this PR.
        this.saveTrackedPulls(repo, trackedPulls)
        if (closedNow) this.notifyThreadClosed(repo, pull)
        const newInWindow = this.isNewItem(pull.created_at, cursors.pulls.since)
        // Notify the runtime once, on the first observation of this PR: a close
        // later in the same window must not re-announce it as opened.
        if (!previous && newInWindow) this.notifyPullOpened(repo, pull)
        // Offer the Trigger whenever the PR is still inside the window, even if
        // we already tracked it: a failed store keeps the window open, and the
        // deterministic id deduplicates a successful retry.
        if (newInWindow) receive(this.pullTrigger(repo, pull))
        // Reviews must be read even when unaddressed comments are switched off:
        // an `@mention` inside a review is always admitted. With `allowSelf`,
        // the user's own PRs are reviewed too (single-account setups).
        if (this.config.allowSelf || !this.isSelf(pull.user.login)) reviewCandidates.push(pull)
      }
      const reviewCursors = this.loadReviewCursors(repo)
      for (const pull of reviewCandidates.slice(0, MAX_REVIEW_PULLS)) {
        const key = String(pull.number)
        const stored = reviewCursors[key]
        let reviews: GithubPage<GithubReview>
        try {
          reviews = await api.listPullReviews(repo, pull.number, {
            signal,
            ...(stored?.etag ? { etag: stored.etag } : {}),
          })
        } catch (error) {
          if (signal.aborted || isAbortError(error)) throw error
          // A deleted PR 404s this endpoint; the repository itself is fine.
          if (repositoryGoneStatus(error) !== undefined) continue
          throw error
        }
        if (reviews.notModified) continue
        // Per-PR cursor: only reviews newer than the last one seen for this PR
        // are fetched/translated, and the ETag makes unchanged PRs free.
        const since = stored?.since ?? reviewSince
        let newest = since
        for (const review of reviews.items) {
          const at = review.submitted_at ?? pull.updated_at
          if (!this.isNewItem(at, since)) continue
          receive(this.reviewTrigger(repo, pull, review))
          if (Date.parse(at) > Date.parse(newest)) newest = at
        }
        reviewCursors[key] = {
          since: newest,
          ...(reviews.etag ? { etag: reviews.etag } : {}),
        }
      }
      this.saveReviewCursors(repo, reviewCursors)
      this.advance(cursors.pulls, roundStartedAt, page, page.items.length)
      this.saveCursors(repo, cursors)
      this.saveTrackedPulls(repo, trackedPulls)
    })

    // Conversation comments across the repository, including PR conversation comments.
    await attempt('issue-comments', async () => {
      const page = await api.listIssueCommentsSince(repo, cursors.issueComments.since, {
        signal,
        ...(cursors.issueComments.etag ? { etag: cursors.issueComments.etag } : {}),
      })
      if (page.notModified) return
      for (const comment of page.items) receive(this.commentTrigger(repo, comment, false))
      this.advance(cursors.issueComments, roundStartedAt, page, page.items.length)
      this.saveCursors(repo, cursors)
    })

    // Inline review comments across the repository.
    await attempt('review-comments', async () => {
      const page = await api.listPullReviewCommentsSince(repo, cursors.reviewComments.since, {
        signal,
        ...(cursors.reviewComments.etag ? { etag: cursors.reviewComments.etag } : {}),
      })
      if (page.notModified) return
      for (const comment of page.items) receive(this.commentTrigger(repo, comment, true))
      this.advance(cursors.reviewComments, roundStartedAt, page, page.items.length)
      this.saveCursors(repo, cursors)
    })

    // Default-branch CI, only when switched on.
    if (this.config.observeCi) {
      await attempt('ci', async () => {
        await this.pollCi(api, repo, signal, receive)
      })
    }

    if (errors.length > 0) throw new Error(errors.join('; '))
    return result
  }

  private async pollCi(
    api: GithubApi,
    repo: string,
    signal: AbortSignal,
    receive: (trigger: Trigger | undefined) => void,
  ): Promise<void> {
    let branch = this.branchCache.get(repo)
    if (!branch) {
      branch = await api.getDefaultBranch(repo, { signal })
      this.branchCache.set(repo, branch)
    }
    // Check runs and Actions runs are independent capabilities: a fine-grained
    // PAT often has Actions but no Checks permission. Read both, keep whichever
    // succeeded, and report one actionable message when both are denied.
    const [checksResult, runsResult] = await Promise.allSettled([
      api.getCheckRunsForRef(repo, branch, { signal }),
      api.listWorkflowRunsForRef(repo, branch, { by: 'branch', signal }),
    ])
    const checksError = checksResult.status === 'rejected' ? checksResult.reason : undefined
    const runsError = runsResult.status === 'rejected' ? runsResult.reason : undefined
    const checksDenied = isCiPermissionDenied(checksError)
    const runsDenied = isCiPermissionDenied(runsError)
    // A non-permission failure (5xx, network) is transient: surface it so the
    // loop retries instead of silently observing half of the CI picture.
    if (checksError && !checksDenied) throw checksError
    if (runsError && !runsDenied) throw runsError
    if (checksDenied && runsDenied) {
      throw new CiPermissionError(
        repo,
        `check runs ${describeCiReadError(checksError)}; workflow runs ${describeCiReadError(runsError)}`,
      )
    }
    if (checksDenied) this.ctx.logger.debug('github: check-runs denied; using Actions workflow runs', { repo })
    if (runsDenied) this.ctx.logger.debug('github: workflow runs denied; using check-runs', { repo })
    const snapshot = summarizeCi(
      checksResult.status === 'fulfilled' ? checksResult.value.check_runs : [],
      runsResult.status === 'fulfilled' ? runsResult.value.workflow_runs : [],
    )
    const fingerprint = JSON.stringify([branch, snapshot.failing])
    const previous = this.loadCi(repo)
    if (!previous || previous.branch !== branch) {
      // First observation (or a renamed default branch) only establishes the baseline.
      this.saveCi(repo, {
        branch,
        fingerprint,
        revision: previous?.revision ?? 0,
        failing: snapshot.failing,
        ...(snapshot.headSha ? { headSha: snapshot.headSha } : {}),
      })
      return
    }
    if (previous.fingerprint === fingerprint) return
    const revision = previous.revision + 1
    // A failed store throws here, before saveCi runs: the old baseline stays,
    // so the next poll sees the same change and retries the Trigger.
    receive(this.ciTrigger(repo, branch, snapshot, revision))
    this.saveCi(repo, {
      branch,
      fingerprint,
      revision,
      failing: snapshot.failing,
      ...(snapshot.headSha ? { headSha: snapshot.headSha } : {}),
    })
  }

  // -------------------------------------------------------------------------
  // Trigger translation
  // -------------------------------------------------------------------------

  private issueTrigger(repo: string, issue: GithubIssue): Trigger | undefined {
    if (!this.actorAllowed(issue.user.login, issue.user.type)) return undefined
    if (this.isOwnOutput(issue.user.login, issue.body)) return undefined
    const mention = this.mentionsSelf(issue.body)
    if (!mention && !this.config.observeIssues) return undefined
    const thread = threadKeyFor(repo, issue.number)
    const budget = this.budgetText(issue.body?.trim() ? `${issue.title}\n\n${issue.body}` : issue.title)
    return makeTrigger(`github:issue:${repo}#${issue.number}`, GITHUB_SOURCE, {
      kind: 'issue',
      at: issue.created_at,
      thread: { key: thread, source: GITHUB_SOURCE, label: `#${issue.number} ${issue.title}` },
      actor: this.actorOf(issue.user),
      addressed: mention ? 'mention' : 'none',
      text: budget.text,
      channel: { source: GITHUB_SOURCE, thread, to: `${repo}#${issue.number}` },
      meta: {
        repo,
        number: issue.number,
        isPr: false,
        url: issue.html_url,
        author: issue.user.login,
        ...(budget.truncated ? { textTruncated: true } : {}),
        ...(issue.labels?.length
          ? { labels: issue.labels.map(label => label.name).filter((name): name is string => Boolean(name)) }
          : {}),
      },
    })
  }

  private pullTrigger(repo: string, pull: GithubPullRequest): Trigger | undefined {
    if (!this.actorAllowed(pull.user.login, pull.user.type)) return undefined
    if (this.isOwnOutput(pull.user.login, pull.body)) return undefined
    const mention = this.mentionsSelf(pull.body)
    if (!mention && !this.config.observePulls) return undefined
    const thread = threadKeyFor(repo, pull.number)
    const budget = this.budgetText(pull.body?.trim() ? `${pull.title}\n\n${pull.body}` : pull.title)
    return makeTrigger(`github:pull:${repo}#${pull.number}`, GITHUB_SOURCE, {
      kind: 'pull',
      at: pull.created_at,
      thread: { key: thread, source: GITHUB_SOURCE, label: `#${pull.number} ${pull.title}` },
      actor: this.actorOf(pull.user),
      addressed: mention ? 'mention' : 'none',
      text: budget.text,
      channel: { source: GITHUB_SOURCE, thread, to: `${repo}#${pull.number}` },
      meta: {
        repo,
        number: pull.number,
        isPr: true,
        url: pull.html_url,
        author: pull.user.login,
        ...(budget.truncated ? { textTruncated: true } : {}),
        head: pull.head.ref,
        base: pull.base.ref,
        draft: pull.draft === true,
      },
    })
  }

  private commentTrigger(repo: string, comment: GithubComment, inline: boolean): Trigger | undefined {
    if (!this.actorAllowed(comment.user.login, comment.user.type)) return undefined
    if (this.isOwnOutput(comment.user.login, comment.body)) return undefined
    const mention = this.mentionsSelf(comment.body)
    if (!mention && !this.config.observeComments) return undefined
    const number =
      numberFromUrl(inline ? comment.pull_request_url : comment.issue_url) ??
      numberFromUrl(comment.html_url)
    if (!number) return undefined
    const isPr = inline || /\/pull\//.test(comment.html_url ?? '')
    const thread = threadKeyFor(repo, number)
    const at = comment.updated_at ?? comment.created_at
    const budget = this.budgetText(comment.body ?? '')
    return makeTrigger(`github:comment:${repo}:${comment.id}:${at}`, GITHUB_SOURCE, {
      kind: 'comment',
      at,
      thread: { key: thread, source: GITHUB_SOURCE, label: `#${number}` },
      actor: this.actorOf(comment.user),
      addressed: mention ? 'mention' : 'none',
      text: budget.text,
      channel: {
        source: GITHUB_SOURCE,
        thread,
        to: `${repo}#${number}`,
        ...(inline ? { replyTo: String(comment.id) } : {}),
      },
      meta: {
        repo,
        number,
        isPr,
        commentId: comment.id,
        url: comment.html_url,
        author: comment.user.login,
        ...(budget.truncated ? { textTruncated: true } : {}),
        kind: inline ? 'review-comment' : 'issue-comment',
        ...(comment.path ? { path: comment.path } : {}),
        ...(comment.line !== undefined ? { line: comment.line } : {}),
      },
    })
  }

  private reviewTrigger(repo: string, pull: GithubPullRequest, review: GithubReview): Trigger | undefined {
    if (!this.actorAllowed(review.user.login, review.user.type)) return undefined
    if (this.isOwnOutput(review.user.login, review.body)) return undefined
    const mention = this.mentionsSelf(review.body)
    if (!mention && !this.config.observeComments) return undefined
    const thread = threadKeyFor(repo, pull.number)
    const at = review.submitted_at ?? pull.updated_at
    const budget = this.budgetText(review.body?.trim() ? review.body : `[review ${review.state}]`)
    return makeTrigger(`github:review:${repo}:${review.id}:${at}`, GITHUB_SOURCE, {
      kind: 'review',
      at,
      thread: { key: thread, source: GITHUB_SOURCE, label: `#${pull.number} ${pull.title}` },
      actor: this.actorOf(review.user),
      addressed: mention ? 'mention' : 'none',
      text: budget.text,
      channel: { source: GITHUB_SOURCE, thread, to: `${repo}#${pull.number}` },
      meta: {
        repo,
        number: pull.number,
        isPr: true,
        reviewId: review.id,
        ...(budget.truncated ? { textTruncated: true } : {}),
        reviewState: review.state,
        url: review.html_url,
        author: review.user.login,
      },
    })
  }

  private ciTrigger(repo: string, branch: string, snapshot: CiSnapshot, revision: number): Trigger {
    const thread = ciThreadKey(repo, branch)
    const failing = snapshot.failing.length
    const text =
      failing > 0
        ? `CI on ${branch}: ${failing} failing (${snapshot.failing.slice(0, 5).join(', ')}); ${snapshot.passing} passing, ${snapshot.running} running`
        : `CI on ${branch}: recovered, ${snapshot.passing} passing${snapshot.running ? `, ${snapshot.running} running` : ''}`
    const url = snapshot.headSha ? `https://github.com/${repo}/commit/${snapshot.headSha}` : undefined
    return makeTrigger(`github:ci:${repo}:${branch}:${revision}`, GITHUB_SOURCE, {
      kind: 'ci',
      at: this.ctx.now(),
      thread: { key: thread, source: GITHUB_SOURCE, label: `CI on ${branch}` },
      actor: { id: 'github-ci', name: 'CI', bot: true },
      addressed: 'ci',
      text: url ? `${text}\n${url}` : text,
      channel: { source: GITHUB_SOURCE, thread, to: `${repo}#ci` },
      meta: {
        repo,
        branch,
        revision,
        failing: snapshot.failing,
        running: snapshot.running,
        passing: snapshot.passing,
        total: snapshot.total,
        ...(snapshot.headSha ? { headSha: snapshot.headSha, url } : {}),
      },
    })
  }

  // -------------------------------------------------------------------------
  // Filters
  // -------------------------------------------------------------------------

  private isSelf(login: string | undefined): boolean {
    return Boolean(login) && Boolean(this.login) && sameName(login, this.login)
  }

  private actorAllowed(login: string, type: string | undefined): boolean {
    const self = this.isSelf(login)
    // A dedicated agent account is never a work source unless explicitly asked:
    // otherwise every action of the agent loops back as a new Trigger.
    if (self && !this.config.allowSelf) return false
    const isBot = type === 'Bot' || login.endsWith('[bot]')
    if (isBot) {
      // The user's own account may still be a bot (e.g. a bot PAT); allowSelf
      // admits it, but other bots need an explicit botLogins entry.
      return self || this.config.botLogins.some(candidate => sameName(candidate, login))
    }
    if (self) return true
    if (this.config.allowedLogins.length === 0) return true
    return this.config.allowedLogins.some(candidate => sameName(candidate, login))
  }

  /**
   * The agent's own output (a comment or PR body carrying the hidden marker)
   * must never become a Trigger, even when `allowSelf` admits the account.
   */
  private isOwnOutput(login: string, body: string | null | undefined): boolean {
    return this.isSelf(login) && hasAgentMarker(body)
  }

  private actorOf(user: { login: string; type?: string }): { id: string; name: string; bot: boolean } {
    return {
      id: user.login,
      name: user.login,
      bot: user.type === 'Bot' || user.login.endsWith('[bot]'),
    }
  }

  /** GitHub text enters Trigger.text through a hard character budget. */
  private budgetText(text: string): { text: string; truncated: boolean } {
    const limit = this.config.maxTextChars
    if (text.length <= limit) return { text, truncated: false }
    const dropped = text.length - limit
    return { text: `${text.slice(0, limit)}\n… [truncated ${dropped} chars]`, truncated: true }
  }

  private mentionsSelf(body: string | null | undefined): boolean {
    if (!body || !this.login) return false
    const escaped = this.login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^A-Za-z0-9-])@${escaped}(?![A-Za-z0-9-])`, 'i').test(body)
  }

  private isTrackedRepo(repo: string): boolean {
    return this.effectiveRepositories().some(candidate => sameName(candidate, repo))
  }

  private isNewItem(at: string | undefined, since: string): boolean {
    const timestamp = Date.parse(at ?? '')
    const floor = Date.parse(since)
    return Number.isFinite(timestamp) && Number.isFinite(floor) && timestamp >= floor
  }

  // -------------------------------------------------------------------------
  // Callbacks
  // -------------------------------------------------------------------------

  private notifyPullOpened(repo: string, pull: GithubPullRequest): void {
    const callbacks = this.config.callbacks ?? fallbackCallbacks
    if (!callbacks?.pullOpened) return
    try {
      callbacks.pullOpened({
        repo,
        number: pull.number,
        thread: threadKeyFor(repo, pull.number),
        url: pull.html_url ?? `https://github.com/${repo}/pull/${pull.number}`,
        title: pull.title,
        head: pull.head.ref ?? '',
        base: pull.base.ref ?? '',
        author: pull.user.login,
        draft: pull.draft === true,
        at: pull.created_at,
      })
    } catch (error) {
      this.ctx.logger.warn('github: pullOpened callback failed', { repo, number: pull.number, error: describeError(error) })
    }
  }

  private notifyThreadClosed(repo: string, pull: GithubPullRequest): void {
    const callbacks = this.config.callbacks ?? fallbackCallbacks
    if (!callbacks?.threadClosed) return
    const outcome: 'merged' | 'closed' =
      pull.merged === true || Boolean(pull.merged_at) ? 'merged' : 'closed'
    try {
      callbacks.threadClosed(threadKeyFor(repo, pull.number), outcome, this.ctx.now())
    } catch (error) {
      this.ctx.logger.warn('github: threadClosed callback failed', { repo, number: pull.number, error: describeError(error) })
    }
  }

  // -------------------------------------------------------------------------
  // Persisted cursors / tracked PRs / CI baseline
  // -------------------------------------------------------------------------

  private loadCursors(repo: string): RepoCursors {
    const stored = this.ctx.kv.get<RepoCursors>(KV.cursors(repo))
    if (stored && stored.version === 1 && this.isRepoCursors(stored)) return stored
    const now = Date.parse(this.ctx.now())
    const initial = new Date((Number.isFinite(now) ? now : Date.now()) - CURSOR_LAG_MS).toISOString()
    const fresh: RepoCursors = {
      version: 1,
      startedAt: initial,
      issues: { since: initial },
      pulls: { since: initial },
      issueComments: { since: initial },
      reviewComments: { since: initial },
      reviews: { since: initial },
    }
    this.ctx.kv.set(KV.cursors(repo), fresh)
    return fresh
  }

  private isRepoCursors(value: RepoCursors): boolean {
    const cursor = (candidate: StreamCursor | undefined): boolean =>
      Boolean(candidate) && typeof candidate!.since === 'string'
    return (
      typeof value.startedAt === 'string' &&
      cursor(value.issues) &&
      cursor(value.pulls) &&
      cursor(value.issueComments) &&
      cursor(value.reviewComments) &&
      cursor(value.reviews)
    )
  }

  private saveCursors(repo: string, cursors: RepoCursors): void {
    this.ctx.kv.set(KV.cursors(repo), cursors)
  }

  private advance(
    cursor: StreamCursor,
    at: string,
    page: Pick<GithubPage<unknown>, 'notModified' | 'truncated' | 'etag'>,
    itemCount: number,
  ): void {
    if (page.notModified || page.truncated) return
    // Advance only when the page was actually read; an empty page keeps the
    // cursor so the same URL (and its ETag) can be replayed cheaply.
    if (itemCount > 0) {
      const floor = Date.parse(cursor.since)
      const timestamp = Date.parse(at)
      if (Number.isFinite(timestamp)) {
        const next = timestamp - CURSOR_LAG_MS
        if (!Number.isFinite(floor) || next > floor) cursor.since = new Date(next).toISOString()
      }
    }
    if (page.etag) cursor.etag = page.etag
    else delete cursor.etag
  }

  private loadReviewCursors(repo: string): Record<string, { since: string; etag?: string }> {
    const stored = this.ctx.kv.get<Record<string, { since?: unknown; etag?: unknown }>>(KV.reviews(repo))
    if (!stored || typeof stored !== 'object') return {}
    const cursors: Record<string, { since: string; etag?: string }> = {}
    for (const [key, value] of Object.entries(stored)) {
      if (!value || typeof value !== 'object') continue
      if (typeof value.since !== 'string') continue
      cursors[key] = {
        since: value.since,
        ...(typeof value.etag === 'string' ? { etag: value.etag } : {}),
      }
    }
    return cursors
  }

  private saveReviewCursors(repo: string, cursors: Record<string, { since: string; etag?: string }>): void {
    const entries = Object.entries(cursors)
      .sort((left, right) => Date.parse(right[1].since) - Date.parse(left[1].since))
      .slice(0, 100)
    this.ctx.kv.set(KV.reviews(repo), Object.fromEntries(entries))
  }

  private loadTrackedPulls(repo: string): TrackedPulls {
    const stored = this.ctx.kv.get<TrackedPulls>(KV.pulls(repo))
    if (!stored || typeof stored !== 'object') return {}
    const valid: TrackedPulls = {}
    for (const [key, value] of Object.entries(stored)) {
      if (!value || typeof value !== 'object') continue
      if (value.state !== 'open' && value.state !== 'closed') continue
      valid[key] = value
    }
    return valid
  }

  private saveTrackedPulls(repo: string, pulls: TrackedPulls): void {
    this.ctx.kv.set(KV.pulls(repo), pulls)
  }

  private loadCi(repo: string): CiState | undefined {
    const stored = this.ctx.kv.get<CiState>(KV.ci(repo))
    if (!stored || typeof stored !== 'object') return undefined
    if (typeof stored.branch !== 'string' || typeof stored.fingerprint !== 'string') return undefined
    if (typeof stored.revision !== 'number' || !Array.isArray(stored.failing)) return undefined
    return stored
  }

  private saveCi(repo: string, state: CiState): void {
    this.ctx.kv.set(KV.ci(repo), state)
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  async send(message: OutboundMessage): Promise<SendOutcome> {
    const target = parseCommentTarget(message.channel.to)
    if (!target || !this.isTrackedRepo(target.repo)) return 'gone'
    const api = this.getApi()
    try {
      await api.createIssueComment(target.repo, target.number, message.text, {
        idempotencyKey: message.id,
        ...(this.controller ? { signal: this.controller.signal } : {}),
      })
      return 'sent'
    } catch (error) {
      if (error instanceof GithubTokenError) throw error
      if (error instanceof GithubApiError) {
        // 404/410: issue or repo gone; 422: comment rejected (locked/too long) — permanent.
        if (error.status === 404 || error.status === 410 || error.status === 422) return 'gone'
      }
      throw error
    }
  }

  channelAllowed(channel: ChannelAddress): boolean {
    if (channel.source !== GITHUB_SOURCE) return false
    const target = parseCommentTarget(channel.to)
    return Boolean(target && this.isTrackedRepo(target.repo))
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// ---------------------------------------------------------------------------
// Source kind
// ---------------------------------------------------------------------------

/** Build the GitHub Source for one configuration. */
export function createSource(config: GithubConfig, ctx: SourceContext): Source {
  return new GithubSource(config, ctx)
}

export const kind: SourceKind<GithubConfig> = {
  id: GITHUB_SOURCE,
  title: 'GitHub',
  description:
    'GitHub repositories: new Issues and PRs, comments, reviews, pull request lifecycle and default-branch CI, polled with persisted cursors and mentioned-login filtering.',
  create: (config, ctx) => createSource(config, ctx),
}

export default kind
