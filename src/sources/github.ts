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
  isAbortError,
  sleepWithSignal,
  type GithubCheckRun,
  type GithubComment,
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
  /** Repositories to watch, `owner/name`. */
  repositories?: string[]
  /** The agent's own login; fetched from `/user` when unset. */
  login?: string
  /** Humans whose events are admitted. Empty means every human except `login`. */
  allowedLogins?: string[]
  /** Bots whose events are admitted (as inferred candidates). */
  botLogins?: string[]
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
  allowedLogins: string[]
  botLogins: string[]
  observeIssues: boolean
  observePulls: boolean
  observeComments: boolean
  observeCi: boolean
  pollSeconds: number
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
  for (const value of stringList(config.repositories)) {
    const parts = value.split('/')
    if (parts.length === 2 && parts[0] && parts[1]) repositories.push(`${parts[0]}/${parts[1]}`)
  }
  return {
    ...(config.tokenEnv?.trim() ? { tokenEnv: config.tokenEnv.trim() } : {}),
    ...(config.tokenFile?.trim() ? { tokenFile: config.tokenFile.trim() } : {}),
    repositories: [...new Set(repositories)],
    ...(config.login?.trim() ? { login: config.login.trim() } : {}),
    allowedLogins: stringList(config.allowedLogins),
    botLogins: stringList(config.botLogins),
    observeIssues: config.observeIssues === true,
    observePulls: config.observePulls === true,
    observeComments: config.observeComments === true,
    observeCi: config.observeCi === true,
    pollSeconds: clampNumber(config.pollSeconds ?? 60, 10, 3600),
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

export interface GithubPollResult {
  repos: number
  emitted: number
  filtered: number
  errors: string[]
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
        const detail =
          result.errors.length > 0
            ? `${result.emitted} trigger(s); ${result.errors.length} repo read(s) failed: ${result.errors[0]}`
            : `${result.emitted} trigger(s), ${result.filtered} filtered in ${result.repos} repo(s)`
        this.report(failures >= 3 ? 'error' : 'ready', detail)
        await this.sleep(this.config.pollSeconds * 1000, signal)
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
      this.ctx.health({ name: GITHUB_SOURCE, state, detail, at: this.ctx.now() })
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
    if (!this.login) {
      const user = await api.getAuthenticatedUser({ signal })
      this.login = user.login
    }
    const result: GithubPollResult = {
      repos: this.config.repositories.length,
      emitted: 0,
      filtered: 0,
      errors: [],
    }
    for (const repo of this.config.repositories) {
      if (signal.aborted) throw abortError()
      try {
        const repoResult = await this.pollRepo(api, repo, signal)
        result.emitted += repoResult.emitted
        result.filtered += repoResult.filtered
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error
        result.errors.push(`${repo}: ${describeError(error)}`)
      }
    }
    return result
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
      this.advance(cursors.issues, roundStartedAt, page, page.items.length)
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
        // an `@mention` inside a review is always admitted.
        if (!this.isSelf(pull.user.login)) reviewCandidates.push(pull)
      }
      for (const pull of reviewCandidates.slice(0, MAX_REVIEW_PULLS)) {
        const reviews = await api.listPullReviews(repo, pull.number, { signal })
        if (reviews.notModified) continue
        let read = 0
        for (const review of reviews.items) {
          const at = review.submitted_at ?? pull.updated_at
          if (!this.isNewItem(at, reviewSince)) continue
          receive(this.reviewTrigger(repo, pull, review))
          read += 1
        }
        this.advance(cursors.reviews, roundStartedAt, { notModified: false, truncated: false }, read)
      }
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
    const mention = this.mentionsSelf(issue.body)
    if (!mention && !this.config.observeIssues) return undefined
    const thread = threadKeyFor(repo, issue.number)
    const text = issue.body?.trim() ? `${issue.title}\n\n${issue.body}` : issue.title
    return makeTrigger(`github:issue:${repo}#${issue.number}`, GITHUB_SOURCE, {
      kind: 'issue',
      at: issue.created_at,
      thread: { key: thread, source: GITHUB_SOURCE, label: `#${issue.number} ${issue.title}` },
      actor: this.actorOf(issue.user),
      addressed: mention ? 'mention' : 'none',
      text,
      channel: { source: GITHUB_SOURCE, thread, to: `${repo}#${issue.number}` },
      meta: {
        repo,
        number: issue.number,
        isPr: false,
        url: issue.html_url,
        author: issue.user.login,
        ...(issue.labels?.length
          ? { labels: issue.labels.map(label => label.name).filter((name): name is string => Boolean(name)) }
          : {}),
      },
    })
  }

  private pullTrigger(repo: string, pull: GithubPullRequest): Trigger | undefined {
    if (!this.actorAllowed(pull.user.login, pull.user.type)) return undefined
    const mention = this.mentionsSelf(pull.body)
    if (!mention && !this.config.observePulls) return undefined
    const thread = threadKeyFor(repo, pull.number)
    const text = pull.body?.trim() ? `${pull.title}\n\n${pull.body}` : pull.title
    return makeTrigger(`github:pull:${repo}#${pull.number}`, GITHUB_SOURCE, {
      kind: 'pull',
      at: pull.created_at,
      thread: { key: thread, source: GITHUB_SOURCE, label: `#${pull.number} ${pull.title}` },
      actor: this.actorOf(pull.user),
      addressed: mention ? 'mention' : 'none',
      text,
      channel: { source: GITHUB_SOURCE, thread, to: `${repo}#${pull.number}` },
      meta: {
        repo,
        number: pull.number,
        isPr: true,
        url: pull.html_url,
        author: pull.user.login,
        head: pull.head.ref,
        base: pull.base.ref,
        draft: pull.draft === true,
      },
    })
  }

  private commentTrigger(repo: string, comment: GithubComment, inline: boolean): Trigger | undefined {
    if (!this.actorAllowed(comment.user.login, comment.user.type)) return undefined
    const mention = this.mentionsSelf(comment.body)
    if (!mention && !this.config.observeComments) return undefined
    const number =
      numberFromUrl(inline ? comment.pull_request_url : comment.issue_url) ??
      numberFromUrl(comment.html_url)
    if (!number) return undefined
    const isPr = inline || /\/pull\//.test(comment.html_url ?? '')
    const thread = threadKeyFor(repo, number)
    const at = comment.updated_at ?? comment.created_at
    return makeTrigger(`github:comment:${repo}:${comment.id}:${at}`, GITHUB_SOURCE, {
      kind: 'comment',
      at,
      thread: { key: thread, source: GITHUB_SOURCE, label: `#${number}` },
      actor: this.actorOf(comment.user),
      addressed: mention ? 'mention' : 'none',
      text: comment.body ?? '',
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
        kind: inline ? 'review-comment' : 'issue-comment',
        ...(comment.path ? { path: comment.path } : {}),
        ...(comment.line !== undefined ? { line: comment.line } : {}),
      },
    })
  }

  private reviewTrigger(repo: string, pull: GithubPullRequest, review: GithubReview): Trigger | undefined {
    if (!this.actorAllowed(review.user.login, review.user.type)) return undefined
    const mention = this.mentionsSelf(review.body)
    if (!mention && !this.config.observeComments) return undefined
    const thread = threadKeyFor(repo, pull.number)
    const at = review.submitted_at ?? pull.updated_at
    return makeTrigger(`github:review:${repo}:${review.id}:${at}`, GITHUB_SOURCE, {
      kind: 'review',
      at,
      thread: { key: thread, source: GITHUB_SOURCE, label: `#${pull.number} ${pull.title}` },
      actor: this.actorOf(review.user),
      addressed: mention ? 'mention' : 'none',
      text: review.body?.trim() ? review.body : `[review ${review.state}]`,
      channel: { source: GITHUB_SOURCE, thread, to: `${repo}#${pull.number}` },
      meta: {
        repo,
        number: pull.number,
        isPr: true,
        reviewId: review.id,
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
    if (this.isSelf(login)) return false
    const isBot = type === 'Bot' || login.endsWith('[bot]')
    if (isBot) return this.config.botLogins.some(candidate => sameName(candidate, login))
    if (this.config.allowedLogins.length === 0) return true
    return this.config.allowedLogins.some(candidate => sameName(candidate, login))
  }

  private actorOf(user: { login: string; type?: string }): { id: string; name: string; bot: boolean } {
    return {
      id: user.login,
      name: user.login,
      bot: user.type === 'Bot' || user.login.endsWith('[bot]'),
    }
  }

  private mentionsSelf(body: string | null | undefined): boolean {
    if (!body || !this.login) return false
    const escaped = this.login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^A-Za-z0-9-])@${escaped}(?![A-Za-z0-9-])`, 'i').test(body)
  }

  private isTrackedRepo(repo: string): boolean {
    return this.config.repositories.some(candidate => sameName(candidate, repo))
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
