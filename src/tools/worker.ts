/**
 * Worker tools.
 *
 * Registered only inside a worker session's scope. A worker can read its own
 * ticket and thread context and report structured state; it cannot route,
 * create tickets, talk to the user, or touch another ticket.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  GithubApi,
  GithubCheckRun,
  GithubCheckRunsResponse,
  GithubIssue,
  GithubPullRequest,
  GithubWorkflowRunsResponse,
} from '../sources/github-api.js'
import type { Input, PullRequestRef, Report, ReportKind } from '../core/model.js'
import { clampText, errorMessage, oneLine } from '../app/support.js'
import { renderTicketCard, renderThreadWindow, renderTriggerLine } from '../prompts/index.js'
import {
  asJson,
  clockOf,
  failure,
  registerScoped,
  renderJson,
  resolveRepository,
  workerCallContext,
  type GithubToolOptions,
  type ToolDeps,
  type WorkerCallContext,
} from './shared.js'

const REPORT_KINDS: ReportKind[] = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']

function jsonTool<S extends Record<string, any>>(definition: {
  name: string
  description: string
  parameters: S
  run(args: any, exec: Parameters<ToolDefinition['execute']>[1]): Promise<unknown>
}): ToolDefinition {
  return defineTool({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: unknown) => renderJson(value),
    },
    execute: async (args: unknown, exec: ToolRunContext) => asJson(await definition.run(args, exec)),
  } as never)
}

function pendingInputs(deps: ToolDeps, ticketId: string): Input[] {
  const ticket = deps.store.tickets.get(ticketId)
  if (!ticket) return []
  return ticket.inputs.filter(input => !input.readAt)
}

/** Normalize the report `files` argument into Engine attachments (max 10). */
function reportFilesOf(
  value: unknown,
  cwd: string | undefined,
): { files: NonNullable<Report['files']>; invalid: string[] } {
  if (!Array.isArray(value)) return { files: [], invalid: [] }
  const files: NonNullable<Report['files']> = []
  const invalid: string[] = []
  for (const item of value.slice(0, 10)) {
    const record: Record<string, unknown> =
      item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : { path: item }
    const rawPath = typeof record.path === 'string' ? record.path.trim() : ''
    if (!rawPath) continue
    const absolute = rawPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawPath) ? rawPath : resolvePath(cwd ?? process.cwd(), rawPath)
    if (!existsSync(absolute)) {
      invalid.push(rawPath)
      continue
    }
    const extension = /\.(png|jpe?g|webp|gif)$/i.exec(absolute)?.[1]?.toLowerCase()
    const kind =
      record.kind === 'photo' || record.kind === 'document'
        ? record.kind
        : extension
          ? 'photo'
          : 'document'
    files.push({
      path: absolute,
      ...(typeof record.name === 'string' && record.name.trim() ? { name: record.name.trim() } : {}),
      ...(typeof record.caption === 'string' && record.caption.trim() ? { caption: record.caption.trim().slice(0, 400) } : {}),
      kind,
    })
  }
  return { files, invalid }
}

function pullRequestOf(args: Record<string, unknown>): PullRequestRef | undefined {
  const url = typeof args.prUrl === 'string' && args.prUrl.length > 0 ? args.prUrl : undefined
  const repo = typeof args.prRepo === 'string' && args.prRepo.length > 0 ? args.prRepo : undefined
  const number = Number.isFinite(Number(args.prNumber)) ? Number(args.prNumber) : undefined
  if (!url && (!repo || !number)) return undefined
  const parsed = url ? /^https?:\/\/(?:[^/]+)\/([^/]+)\/([^/]+)\/(?:pull|pulls)\/(\d+)/.exec(url) : null
  const resolvedRepo = repo ?? (parsed ? `${parsed[1]}/${parsed[2]}` : '')
  const resolvedNumber = number ?? (parsed ? Number(parsed[3]) : 0)
  if (!resolvedRepo || !resolvedNumber) return undefined
  return {
    repo: resolvedRepo,
    number: resolvedNumber,
    url: url ?? `https://github.com/${resolvedRepo}/pull/${resolvedNumber}`,
    ...(typeof args.branch === 'string' && args.branch.length > 0 ? { head: args.branch } : {}),
  }
}

// ---------------------------------------------------------------------------
// GitHub write tool (worker-only)
//
// Workers can push a branch with bash but cannot open a pull request without
// an API call (and they often lack `gh`). This tool performs the three GitHub
// actions the report protocol expects: open/return a PR, comment, read checks.
// The token is resolved from the runtime-configured secret file or environment
// variable (never passed in the tool arguments, never returned or logged).
// ---------------------------------------------------------------------------

interface GithubRepositoryCreated {
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

interface GithubModule {
  createGithubRepository?: (
    token: string,
    input: { name: string; private?: boolean; description?: string; autoInit?: boolean },
    options?: { apiBaseUrl?: string; timeoutMs?: number },
  ) => Promise<GithubRepositoryCreated>
  GithubApi: new (options: {
    token: string | (() => Promise<string>)
    baseUrl?: string
    timeoutMs?: number
    maxAttempts?: number
    baseDelayMs?: number
    maxDelayMs?: number
    fetchImpl?: typeof fetch
  }) => GithubApi
  createGithubTokenProvider: (options?: { tokenFile?: string; tokenEnv?: string; defaultEnv?: string }) => () => Promise<string>
  addGithubCollaborator?: (
    token: string,
    repo: string,
    username: string,
    permission?: 'pull' | 'triage' | 'push' | 'maintain' | 'admin',
    options?: { apiBaseUrl?: string; timeoutMs?: number },
  ) => Promise<{
    ok: true
    repo: string
    login: string
    permission: string
    alreadyCollaborator: boolean
  }>
  acceptInvitationForRepo?: (
    token: string,
    repo: string,
    options?: { apiBaseUrl?: string; timeoutMs?: number },
  ) => Promise<{ ok: true; repo: string; status: string; invitationId?: number }>
  validateGithubToken?: (
    token: string,
    options?: { apiBaseUrl?: string; timeoutMs?: number },
  ) => Promise<{ ok: true; login: string; id: number }>
}

let githubModulePromise: Promise<GithubModule | undefined> | undefined

/** Load the stateless GitHub API module on first use (never at plugin load). */
async function loadGithubModule(): Promise<GithubModule | undefined> {
  githubModulePromise ??= import('../sources/github-api.js')
    .then(module => {
      const candidate = module as unknown as Partial<GithubModule>
      return typeof candidate.GithubApi === 'function' && typeof candidate.createGithubTokenProvider === 'function'
        ? (candidate as GithubModule)
        : undefined
    })
    .catch(() => undefined)
  return githubModulePromise
}

/** Strip credential-looking substrings from a GitHub error before it reaches the model. */
function sanitizeGithub(text: string, limit = 400): string {
  return text
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted-token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted-token]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
    .slice(0, limit)
}

function mapGithubError(error: unknown): { ok: false; error: string; detail?: string } {
  const message = sanitizeGithub(errorMessage(error)) || 'GitHub request failed'
  const name = error instanceof Error ? error.name : ''
  if (name === 'GithubTokenError') return failure('github_token_missing', message)
  const details = (error ?? {}) as { status?: unknown; rateLimited?: unknown }
  const status = typeof details.status === 'number' ? details.status : undefined
  if (details.rateLimited === true || status === 429) return failure('github_rate_limited', message)
  if (status === 403 || status === 404) return failure('github_forbidden_or_missing', message)
  if (status === 422) return failure('github_rejected', message)
  return failure('github_api_error', message)
}

type CollaboratorStatus = 'invited' | 'already' | 'failed'

interface InvitationOutcome {
  collaborators: Array<{ login: string; status: CollaboratorStatus }>
  warnings: string[]
}

/**
 * Invite every configured collaborator as admin, one by one. Failures never
 * fail repository creation: they become warnings on the tool result.
 */
async function inviteCollaborators(
  module: GithubModule,
  token: string,
  repo: string,
  requested: string[],
  options: GithubToolOptions,
): Promise<InvitationOutcome> {
  const seen = new Set<string>()
  const logins: string[] = []
  for (const value of requested) {
    const login = value.trim().replace(/^@/, '')
    if (!login) continue
    const key = login.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    logins.push(login)
  }
  const outcome: InvitationOutcome = { collaborators: [], warnings: [] }
  if (logins.length === 0) return outcome
  if (!module.addGithubCollaborator) {
    outcome.warnings.push('collaborator invitations are unavailable in this build; update the SuperAgent bundle')
    for (const login of logins) outcome.collaborators.push({ login, status: 'failed' })
    return outcome
  }
  for (const login of logins) {
    if (!/^[A-Za-z0-9-]+$/.test(login)) {
      outcome.collaborators.push({ login, status: 'failed' })
      outcome.warnings.push(`ignored invalid collaborator login: ${login}`)
      continue
    }
    try {
      const added = await module.addGithubCollaborator(token, repo, login, 'admin', {
        ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      })
      outcome.collaborators.push({ login, status: added.alreadyCollaborator ? 'already' : 'invited' })
    } catch (error) {
      const mapped = mapGithubError(error)
      outcome.collaborators.push({ login, status: 'failed' })
      const detail = mapped.detail ? ` (${mapped.detail})` : ''
      outcome.warnings.push(`could not invite ${login}: ${mapped.error}${detail}`)
    }
  }
  return outcome
}

function secretFileFor(deps: ToolDeps, call: WorkerCallContext, name: string): string | undefined {
  const configured = deps.github?.tokenFile
  if (typeof configured === 'string' && configured.length > 0) return configured
  if (!call.cwd) return undefined
  // The executor puts workers in `<stateDir>/work/<ticketId>`.
  const candidate = resolvePath(call.cwd, '..', '..', 'secrets', name)
  return existsSync(candidate) ? candidate : undefined
}

type GithubTokenResult = { token: string; tokenSource: 'literal' | 'file' | 'env' } | { ok: false; error: string; detail?: string }
type GithubClientResult = { client: GithubApi; tokenSource: 'literal' | 'file' | 'env' } | { ok: false; error: string; detail?: string }

/** Resolve the configured token without building a client (used by repo creation). */
async function githubToken(deps: ToolDeps, call: WorkerCallContext): Promise<GithubTokenResult> {
  const module = await loadGithubModule()
  if (!module) return failure('github_unavailable', 'the GitHub API module is unavailable in this build')
  const options = deps.github ?? {}
  if (typeof options.token === 'string' && options.token.trim().length > 0) {
    return { token: options.token.trim(), tokenSource: 'literal' }
  }
  const tokenFile = secretFileFor(deps, call, 'github-token')
  const provider = module.createGithubTokenProvider({
    ...(tokenFile ? { tokenFile } : {}),
    ...(options.tokenEnv ? { tokenEnv: options.tokenEnv } : {}),
  })
  let token: string
  try {
    token = (await provider()).trim()
  } catch (error) {
    return mapGithubError(error)
  }
  if (token.length === 0) return failure('github_token_missing', 'the GitHub token is empty')
  return { token, tokenSource: tokenFile ? 'file' : 'env' }
}

/** Build an authenticated client; token failures are structured, never thrown with the secret. */
async function githubClient(deps: ToolDeps, call: WorkerCallContext): Promise<GithubClientResult> {
  const module = await loadGithubModule()
  if (!module) return failure('github_unavailable', 'the GitHub API module is unavailable in this build')
  const tokenResult = await githubToken(deps, call)
  if ('ok' in tokenResult) return tokenResult
  const options = deps.github ?? {}
  const client = new module.GithubApi({
    token: tokenResult.token,
    ...(options.apiBaseUrl ? { baseUrl: options.apiBaseUrl } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    maxAttempts: 2,
    baseDelayMs: 250,
    maxDelayMs: 2_000,
  })
  return { client, tokenSource: tokenResult.tokenSource }
}

const PR_CACHE_PREFIX = 'superagent.github.pr.'

interface CachedPull {
  repo: string
  number: number
  url: string
  head: string
  base: string
  title: string
  at: string
}

function readCachedPull(deps: ToolDeps, ticketId: string): CachedPull | undefined {
  try {
    return deps.store.kv.get<CachedPull>(PR_CACHE_PREFIX + ticketId)
  } catch {
    return undefined
  }
}

function writeCachedPull(deps: ToolDeps, ticketId: string, pull: CachedPull): void {
  try {
    deps.store.kv.set(PR_CACHE_PREFIX + ticketId, pull)
  } catch {
    // best effort: idempotency also has the API scan path
  }
}

function pullUrl(repo: string, pull: GithubPullRequest): string {
  return typeof pull.html_url === 'string' && pull.html_url.length > 0
    ? pull.html_url
    : `https://github.com/${repo}/pull/${pull.number}`
}

function pullSummary(repo: string, pull: GithubPullRequest, created: boolean): Record<string, unknown> {
  return {
    ok: true,
    action: 'pull_request',
    repo,
    number: pull.number,
    url: pullUrl(repo, pull),
    state: pull.merged === true ? 'merged' : pull.state,
    created,
    head: pull.head?.ref,
    base: pull.base?.ref,
    title: pull.title,
  }
}

function isDuplicatePullError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const details = (error as { status?: unknown }).status
  return details === 422 && /already exists/i.test(error.message)
}

/** Find an existing PR by head/base; the GitHub API has no head filter on list. */
async function findExistingPull(
  client: GithubApi,
  repo: string,
  head: string,
  base: string,
  since: string,
): Promise<GithubPullRequest | undefined> {
  try {
    const page = await client.listPullsUpdatedSince(repo, since, { maxPages: 2 })
    const matches = page.items.filter(pull => pull.head?.ref === head && (!base || pull.base?.ref === base))
    matches.sort((left, right) => {
      const leftOpen = left.state === 'open' ? 0 : 1
      const rightOpen = right.state === 'open' ? 0 : 1
      return leftOpen !== rightOpen ? leftOpen - rightOpen : right.number - left.number
    })
    return matches[0]
  } catch {
    return undefined
  }
}

function sinceHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

function summarizeCheckRuns(response: GithubCheckRunsResponse): Record<string, unknown> {
  const runs = Array.isArray(response.check_runs) ? response.check_runs : []
  return {
    total: typeof response.total_count === 'number' ? response.total_count : runs.length,
    runs: runs.slice(0, 30).map((run: GithubCheckRun) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion ?? null,
      url: run.html_url ?? null,
      detailsUrl: run.details_url ?? null,
    })),
  }
}

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function configuredRepositories(deps: ToolDeps): string[] {
  try {
    const policy = deps.engine.settings.policy()
    return Array.isArray(policy.sources?.github?.repositories) ? policy.sources.github.repositories : []
  } catch {
    return []
  }
}

function configuredGithubLogin(deps: ToolDeps): string | undefined {
  const login = (deps.github as (GithubToolOptions & { login?: unknown }) | undefined)?.login
  return typeof login === 'string' && login.trim() ? login.trim() : undefined
}

/**
 * Writes may only touch repositories the Source is configured to listen to:
 * an explicit allowlist, or (with `repositories: ['*']`) repositories owned by
 * the token account / a configured operator. Everywhere else is denied before
 * any API call.
 */
async function repositoryAllowedForWrites(deps: ToolDeps, repo: string, client: GithubApi): Promise<boolean> {
  if (!REPO_NAME.test(repo)) return false
  const configured = configuredRepositories(deps)
  if (configured.length === 0) return false
  if (!configured.includes('*')) {
    return configured.some(entry => entry.toLowerCase() === repo.toLowerCase())
  }
  const trusted = new Set<string>()
  try {
    for (const actor of deps.engine.settings.policy().sources?.github?.allowed ?? []) {
      trusted.add(actor.id.toLowerCase())
    }
  } catch {
    // policy unavailable: rely on the token account below
  }
  for (const login of deps.github?.collaborators ?? []) trusted.add(login.toLowerCase())
  const configuredLogin = configuredGithubLogin(deps)
  if (configuredLogin) trusted.add(configuredLogin.toLowerCase())
  if (!configuredLogin) {
    try {
      trusted.add((await client.getAuthenticatedUser()).login.toLowerCase())
    } catch {
      return false
    }
  }
  return trusted.has(repo.split('/')[0]!.toLowerCase())
}

function summarizeWorkflowRuns(response: GithubWorkflowRunsResponse): Record<string, unknown> {
  const runs = Array.isArray(response.workflow_runs) ? response.workflow_runs : []
  return {
    total: typeof response.total_count === 'number' ? response.total_count : runs.length,
    runs: runs.slice(0, 20).map(run => ({
      name: run.name ?? run.display_title ?? 'workflow',
      status: run.status,
      conclusion: run.conclusion ?? null,
      url: run.html_url ?? null,
      headSha: run.head_sha ?? null,
    })),
  }
}

function summarizeIssue(issue: GithubIssue): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.user?.login ?? null,
    url: issue.html_url ?? null,
    labels: Array.isArray(issue.labels)
      ? issue.labels.map(label => (typeof label === 'string' ? label : label?.name)).filter(Boolean)
      : [],
    comments: issue.comments ?? null,
    body: issue.body === null || issue.body === undefined ? null : clampText(String(issue.body), 2_000),
    updatedAt: issue.updated_at ?? null,
  }
}

function summarizePull(pull: GithubPullRequest): Record<string, unknown> {
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    merged: pull.merged === true,
    draft: pull.draft === true,
    author: pull.user?.login ?? null,
    url: pull.html_url ?? null,
    head: pull.head?.ref ?? null,
    base: pull.base?.ref ?? null,
    headSha: pull.head?.sha ?? null,
    body: pull.body === null || pull.body === undefined ? null : clampText(String(pull.body), 2_000),
    updatedAt: pull.updated_at ?? null,
  }
}

/** The `superagent_github` tool definition (worker scope only). */
function githubToolDefinition(deps: ToolDeps): ToolDefinition {
  const now = clockOf(deps)

  const definition = jsonTool({
    name: 'superagent_github',
    description:
      'GitHub actions for your ticket: create a repository, open (or return) a pull request for your branch, comment on a PR/issue, or read CI checks. ' +
      'Uses the configured SuperAgent GitHub token; never pass a token. Idempotent: an existing repository returns created:false, the same branch returns the existing PR, and a repeated comment is not posted twice.',
    parameters: {
      action: {
        type: 'string',
        enum: [
          'create_repository',
          'pull_request',
          'comment',
          'checks',
          'list_checks',
          'get_issue',
          'list_issues',
          'create_issue',
          'update_issue',
          'get_pull',
          'list_pulls',
          'get_pull_files',
          'review',
          'merge_pull',
          'search',
        ],
        required: true,
        description: 'Which GitHub action to perform',
      },
      name: { type: 'string', description: 'create_repository: repository name (letters, digits, dot, dash, underscore; max 100)' },
      private: { type: 'boolean', description: 'create_repository: private repository (default true)' },
      description: { type: 'string', description: 'create_repository: optional repository description' },
      autoInit: {
        type: 'boolean',
        description: 'create_repository: create with an initial README/default branch (default false; the worker pushes main itself)',
      },
      repo: { type: 'string', description: 'owner/name; defaults to the repository inferred from the ticket' },
      head: { type: 'string', description: 'pull_request: source branch (default agent/<ticketId>)' },
      base: { type: 'string', description: 'pull_request: target branch (default: repository default branch)' },
      title: { type: 'string', description: 'pull_request: title (default: ticket title)' },
      body: { type: 'string', description: 'pull_request/comment: markdown body; the PR gets a hidden SuperAgent marker automatically' },
      number: { type: 'integer', description: 'comment: PR/issue number (default: the ticket PR); checks: resolve the head SHA from this PR' },
      ref: { type: 'string', description: 'checks: commit SHA or branch (default agent/<ticketId>)' },
      draft: { type: 'boolean', description: 'pull_request: open as draft' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'list/issues/update: state filter or target state' },
      labels: { type: 'array', items: { type: 'string' }, description: 'issue/PR labels (list filter or write value)' },
      assignees: { type: 'array', items: { type: 'string' }, description: 'issue assignees (GitHub logins)' },
      event: {
        type: 'string',
        enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'],
        description: 'review: GitHub review event',
      },
      comments: {
        type: 'json',
        description: 'review: optional inline comments [{path, body, line?, side?}]',
      },
      mergeMethod: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'merge_pull: merge method (default merge)' },
      confirm: { type: 'boolean', description: 'merge_pull: must be true; merging is never automatic' },
      query: { type: 'string', description: 'search: GitHub search query (issues/PRs)' },
      limit: { type: 'integer', description: 'list/search: maximum results (default 20, max 100)' },
    },
    async run(args, exec) {
      const call = workerCallContext(exec, deps)
      if ('ok' in call) return call
      const action = String(args.action ?? '')
      const KNOWN_ACTIONS = new Set([
        'create_repository',
        'pull_request',
        'comment',
        'checks',
        'list_checks',
        'get_issue',
        'list_issues',
        'create_issue',
        'update_issue',
        'get_pull',
        'list_pulls',
        'get_pull_files',
        'review',
        'merge_pull',
        'search',
      ])
      if (!KNOWN_ACTIONS.has(action)) {
        return failure('invalid_action', `unsupported action; expected one of ${[...KNOWN_ACTIONS].join(', ')}`)
      }

      if (action === 'create_repository') {
        const module = await loadGithubModule()
        if (!module?.createGithubRepository) {
          return failure(
            'github_create_repository_unavailable',
            'repository creation is unavailable in this build; update the SuperAgent bundle',
          )
        }
        const name = String(args.name ?? '').trim()
        if (!name) return failure('name_required', 'create_repository needs a repository name')
        if (name.length > 100 || !/^[A-Za-z0-9._-]+$/.test(name)) {
          return failure('invalid_name', 'repository names may use letters, digits, dot, dash and underscore (max 100)')
        }
        const tokenResult = await githubToken(deps, call)
        if ('ok' in tokenResult) return tokenResult
        const options = deps.github ?? {}
        try {
          const created = await module.createGithubRepository(
            tokenResult.token,
            {
              name,
              private: args.private !== false,
              ...(typeof args.description === 'string' && args.description.trim()
                ? { description: args.description.trim().slice(0, 350) }
                : {}),
              autoInit: args.autoInit === true,
            },
            {
              ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
              ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
            },
          )
          // Collaborators come only from the runtime configuration: the model
          // cannot name arbitrary users, and an existing repository is left
          // untouched (no surprise admin grants on retries/idempotent calls).
          let requested = created.created ? [...(options.collaborators ?? [])] : []
          // With an operator PAT but no configured collaborator list, derive the
          // operator login from the token so the bot invitation still happens.
          if (created.created && requested.length === 0 && options.operatorTokenFile && module.validateGithubToken) {
            try {
              const operatorToken = readFileSync(options.operatorTokenFile, 'utf8').trim()
              if (operatorToken) {
                const validated = await module.validateGithubToken(operatorToken, {
                  ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
                  ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
                })
                if (validated.login) requested = [validated.login]
              }
            } catch (error) {
              // Not fatal: repository creation already succeeded.
              requested = []
            }
          }
          const invitations = await inviteCollaborators(module, tokenResult.token, created.fullName, requested, options)
          const warnings = [...invitations.warnings]
          // Bootstrap automation: the operator (personal account) invites the
          // bot, then the operator PAT accepts that invitation for the new repo
          // so the bot can push immediately. Best effort: failures are warnings.
          let operator: Record<string, unknown> | undefined
          if (created.created && options.operatorTokenFile && requested.length > 0) {
            try {
              const operatorToken = readFileSync(options.operatorTokenFile, 'utf8').trim()
              if (!operatorToken) {
                warnings.push('operator token file is empty; the bot must accept the invitation manually')
              } else if (!module.acceptInvitationForRepo) {
                warnings.push('invitation-auto-accept is unavailable in this build; accept the invitation manually')
              } else {
                const accepted = await module.acceptInvitationForRepo(
                  operatorToken,
                  created.fullName,
                  {
                    ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
                    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
                  },
                )
                operator = {
                  status: accepted.status,
                  ...(accepted.invitationId !== undefined ? { invitationId: accepted.invitationId } : {}),
                }
                if (accepted.status === 'none') {
                  warnings.push(
                    'the operator account has no pending invitation for the new repository; check it can access the repository',
                  )
                }
              }
            } catch (error) {
              warnings.push(`could not accept the repository invitation as the operator: ${sanitizeGithub(errorMessage(error))}`)
            }
          }
          return {
            ok: true,
            action: 'create_repository',
            repo: created.fullName,
            fullName: created.fullName,
            name: created.name,
            private: created.private,
            htmlUrl: created.htmlUrl,
            sshUrl: created.sshUrl,
            cloneUrl: created.cloneUrl,
            defaultBranch: created.defaultBranch,
            created: created.created,
            ...(invitations.collaborators.length > 0 ? { collaborators: invitations.collaborators } : {}),
            ...(operator ? { operator } : {}),
            ...(warnings.length > 0 ? { warnings } : {}),
          }
        } catch (error) {
          return mapGithubError(error)
        }
      }

      const repo = resolveRepository(deps, call.ticketId, typeof args.repo === 'string' ? args.repo : undefined)
      if (!repo) {
        return failure(
          'repo_required',
          'pass repo "owner/name": no repository could be inferred from this ticket (trigger meta or mandate scope)',
        )
      }
      const clientResult = await githubClient(deps, call)
      if ('ok' in clientResult) return clientResult
      const client = clientResult.client
      if (!(await repositoryAllowedForWrites(deps, repo, client))) {
        return failure(
          'repo_not_allowed',
          `repository ${repo} is outside the configured repositories allowlist (sources.github.repositories)`,
        )
      }
      const ticket = deps.store.tickets.get(call.ticketId)

      try {
        if (
          action === 'get_issue' ||
          action === 'list_issues' ||
          action === 'create_issue' ||
          action === 'update_issue' ||
          action === 'get_pull' ||
          action === 'list_pulls' ||
          action === 'get_pull_files' ||
          action === 'review' ||
          action === 'merge_pull' ||
          action === 'search'
        ) {
          const limit = Number.isInteger(Number(args.limit)) ? Math.min(Math.max(Number(args.limit), 1), 100) : 20
          const bodyMarker = (body: string, kind: string): string =>
            body.includes('<!-- superagent:') ? body : `${body}${body.trim() ? '\n\n' : ''}<!-- superagent:${call.ticketId}:${kind} -->`
          const ticket = deps.store.tickets.get(call.ticketId)

          try {
            if (action === 'get_issue') {
              if (!Number.isInteger(Number(args.number)) || Number(args.number) <= 0) return failure('number_required', 'get_issue needs number')
              const issue = (await client.getIssue(repo, Number(args.number))) as GithubIssue
              return { ok: true, action, repo, issue: summarizeIssue(issue) }
            }
            if (action === 'list_issues') {
              const page = (await client.listIssues(repo, {
                ...(typeof args.state === 'string' ? { state: args.state } : {}),
                ...(Array.isArray(args.labels) ? { labels: args.labels.map(String) } : {}),
                ...(Array.isArray(args.assignees) && args.assignees[0] ? { assignee: String(args.assignees[0]) } : {}),
                maxPages: 2,
              }))
              return { ok: true, action, repo, issues: page.items.slice(0, limit).map(summarizeIssue) }
            }
            if (action === 'create_issue') {
              const title = typeof args.title === 'string' ? args.title.trim() : ''
              if (!title) return failure('title_required', 'create_issue needs title')
              const body = bodyMarker(typeof args.body === 'string' ? args.body : '', 'issue')
              const issue = await client.createIssue(repo, {
                title,
                body,
                ...(Array.isArray(args.labels) && args.labels.length > 0 ? { labels: args.labels.map(String) } : {}),
                ...(Array.isArray(args.assignees) && args.assignees.length > 0 ? { assignees: args.assignees.map(String) } : {}),
              })
              return { ok: true, action, repo, issue: summarizeIssue(issue) }
            }
            if (action === 'update_issue') {
              if (!Number.isInteger(Number(args.number)) || Number(args.number) <= 0) return failure('number_required', 'update_issue needs number')
              const patch: Record<string, unknown> = {}
              if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim()
              if (typeof args.body === 'string') patch.body = args.body
              if (args.state === 'open' || args.state === 'closed') patch.state = args.state
              if (Array.isArray(args.labels)) patch.labels = args.labels.map(String)
              if (Array.isArray(args.assignees)) patch.assignees = args.assignees.map(String)
              if (Object.keys(patch).length === 0) {
                return failure('nothing_to_update', 'update_issue needs at least one of title/body/state/labels/assignees')
              }
              const issue = await client.updateIssue(repo, Number(args.number), patch)
              return { ok: true, action, repo, issue: summarizeIssue(issue) }
            }
            if (action === 'get_pull') {
              if (!Number.isInteger(Number(args.number)) || Number(args.number) <= 0) return failure('number_required', 'get_pull needs number')
              const pull = (await client.getPull(repo, Number(args.number))) as GithubPullRequest
              return { ok: true, action, repo, pull: summarizePull(pull) }
            }
            if (action === 'list_pulls') {
              const page = (await client.listPulls(repo, {
                ...(typeof args.state === 'string' ? { state: args.state } : {}),
                maxPages: 2,
              }))
              return {
                ok: true,
                action,
                repo,
                pulls: page.items.slice(0, limit).map(pull => summarizePull(pull)),
              }
            }
            if (action === 'get_pull_files') {
              if (!Number.isInteger(Number(args.number)) || Number(args.number) <= 0) {
                return failure('number_required', 'get_pull_files needs number')
              }
              const files = await client.listPullFiles(repo, Number(args.number))
              const maxFiles = Math.min(Math.max(limit, 1), 30)
              // Structured truncation: cap each patch and the whole list by bytes,
              // so the model always receives valid JSON with an explicit marker.
              const budget = 8_000
              const summarized: Array<Record<string, unknown>> = []
              let used = 0
              let truncated = files.length > maxFiles
              for (const file of files.slice(0, maxFiles)) {
                const patch = typeof file.patch === 'string' ? clampText(file.patch, 800) : null
                const entry = {
                  filename: file.filename,
                  status: file.status,
                  additions: file.additions,
                  deletions: file.deletions,
                  changes: file.changes,
                  patch,
                }
                const size = JSON.stringify(entry).length
                if (used + size > budget) {
                  truncated = true
                  break
                }
                used += size
                summarized.push(entry)
              }
              return {
                ok: true,
                action,
                repo,
                number: Number(args.number),
                files: summarized,
                fileCount: summarized.length,
                truncated,
              }
            }
            if (action === 'review') {
              if (!Number.isInteger(Number(args.number)) || Number(args.number) <= 0) return failure('number_required', 'review needs number')
              const event = args.event
              if (event !== 'APPROVE' && event !== 'REQUEST_CHANGES' && event !== 'COMMENT') {
                return failure('event_required', 'review needs event APPROVE|REQUEST_CHANGES|COMMENT')
              }
              if (event !== 'APPROVE' && !(typeof args.body === 'string' && args.body.trim())) {
                return failure('body_required', 'REQUEST_CHANGES/COMMENT reviews need a body')
              }
              const body = bodyMarker(typeof args.body === 'string' ? args.body : '', 'review')
              let comments: Array<Record<string, unknown>> | undefined
              if (Array.isArray(args.comments)) {
                comments = (args.comments as unknown[])
                  .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
                  .map(item => ({
                    path: String(item.path ?? ''),
                    body: String(item.body ?? ''),
                    ...(Number.isInteger(Number(item.line)) ? { line: Number(item.line) } : {}),
                    ...(item.side === 'LEFT' || item.side === 'RIGHT' ? { side: item.side } : {}),
                  }))
                  .filter(item => item.path.length > 0 && item.body.length > 0)
              }
              const result = await client.createPullReview(repo, Number(args.number), {
                event,
                body,
                ...(comments && comments.length > 0 ? { comments: comments as never } : {}),
              })
              return { ok: true, action, repo, number: Number(args.number), reviewId: result.id, state: result.state, url: result.html_url ?? null }
            }
            if (action === 'merge_pull') {
              if (args.confirm !== true) {
                return failure('confirm_required', 'merge_pull needs confirm:true; merging is never automatic')
              }
              if (!ticket || ticket.state !== 'open') {
                return failure('ticket_not_open', 'merge_pull is only allowed for an open ticket with a live mandate')
              }
              if (!Number.isInteger(Number(args.number)) || Number(args.number) <= 0) return failure('number_required', 'merge_pull needs number')
              const methodName = args.mergeMethod === 'squash' || args.mergeMethod === 'rebase' ? args.mergeMethod : 'merge'
              const result = await client.mergePull(repo, Number(args.number), {
                merge_method: methodName as 'merge' | 'squash' | 'rebase',
                ...(typeof args.title === 'string' && args.title.trim() ? { commit_title: args.title.trim() } : {}),
                ...(typeof args.body === 'string' && args.body.trim() ? { commit_message: args.body.trim() } : {}),
              })
              return {
                ok: true,
                action,
                repo,
                number: Number(args.number),
                merged: result.merged === true,
                commit: result.sha ?? null,
                message: result.message ?? null,
                mergeMethod: methodName,
              }
            }
            // action === 'search'
            const query = typeof args.query === 'string' ? args.query.trim() : ''
            if (!query) return failure('query_required', 'search needs a query')
            const result = await client.searchIssues(query, { perPage: limit, maxPages: 1 })
            return {
              ok: true,
              action,
              total: typeof result.total_count === 'number' ? result.total_count : (result.items ?? []).length,
              items: (result.items ?? []).slice(0, limit).map(issue => ({
                number: issue.number,
                title: issue.title,
                state: issue.state,
                url: issue.html_url ?? null,
                isPull: typeof issue.pull_request !== 'undefined',
              })),
            }
          } catch (error) {
            return mapGithubError(error)
          }
        }

        if (action === 'pull_request') {
          const head = (typeof args.head === 'string' && args.head.trim()) || `agent/${call.ticketId}`
          const title = (typeof args.title === 'string' && args.title.trim()) || ticket?.title || `SuperAgent: ${call.ticketId}`
          const marker = `<!-- superagent:${call.ticketId}:pr -->`
          const bodyText = typeof args.body === 'string' ? args.body.trim() : ''
          const body = bodyText.length > 0 ? `${bodyText}\n\n${marker}` : marker
          const base =
            (typeof args.base === 'string' && args.base.trim()) || (await client.getDefaultBranch(repo))

          const cached = readCachedPull(deps, call.ticketId)
          if (cached && cached.repo === repo && cached.head === head && cached.base === base) {
            try {
              const existing = await client.getPull(repo, cached.number)
              return pullSummary(repo, existing, false)
            } catch {
              // stale cache (deleted PR, different repo state): fall through to scan/create
            }
          }

          const scanSince = ticket?.createdAt ?? sinceHoursAgo(24 * 7)
          const existing = await findExistingPull(client, repo, head, base, scanSince)
          if (existing) {
            writeCachedPull(deps, call.ticketId, {
              repo,
              number: existing.number,
              url: pullUrl(repo, existing),
              head,
              base,
              title: existing.title,
              at: now(),
            })
            return pullSummary(repo, existing, false)
          }

          try {
            const created = await client.createPullRequest(repo, {
              title,
              head,
              base,
              body,
              ...(typeof args.draft === 'boolean' ? { draft: args.draft } : {}),
            })
            writeCachedPull(deps, call.ticketId, {
              repo,
              number: created.number,
              url: pullUrl(repo, created),
              head,
              base,
              title: created.title ?? title,
              at: now(),
            })
            return pullSummary(repo, created, true)
          } catch (error) {
            if (isDuplicatePullError(error)) {
              const raced = await findExistingPull(client, repo, head, base, sinceHoursAgo(24))
              if (raced) {
                writeCachedPull(deps, call.ticketId, {
                  repo,
                  number: raced.number,
                  url: pullUrl(repo, raced),
                  head,
                  base,
                  title: raced.title,
                  at: now(),
                })
                return pullSummary(repo, raced, false)
              }
              return failure(
                'pull_request_exists_unresolved',
                `a pull request already exists for ${head} but its number could not be resolved; use action=comment with an explicit number or read the PR manually`,
              )
            }
            throw error
          }
        }

        if (action === 'comment') {
          const bodyText = typeof args.body === 'string' ? args.body.trim() : ''
          if (!bodyText) return failure('body_required', 'comment needs a non-empty body')
          const cached = readCachedPull(deps, call.ticketId)
          const number =
            Number.isInteger(Number(args.number)) && Number(args.number) > 0
              ? Number(args.number)
              : cached?.repo === repo
                ? cached.number
                : undefined
          if (number === undefined) {
            return failure('number_required', 'pass number (PR/issue number) or open the ticket PR with action=pull_request first')
          }
          const comment = await client.createIssueComment(repo, number, bodyText, {
            idempotencyKey: `superagent:${call.ticketId}:comment:${repo}#${number}`,
          })
          return {
            ok: true,
            action: 'comment',
            repo,
            number,
            commentId: comment.id,
            url: comment.html_url ?? null,
          }
        }

        // action === 'checks' | 'list_checks'
        let ref = typeof args.ref === 'string' ? args.ref.trim() : ''
        const number = Number.isInteger(Number(args.number)) && Number(args.number) > 0 ? Number(args.number) : undefined
        if (!ref && number !== undefined) {
          try {
            const pull = await client.getPull(repo, number)
            ref = pull.head?.sha ?? ''
          } catch {
            // fall through to the branch default
          }
        }
        if (!ref) ref = `agent/${call.ticketId}`
        const checks = await Promise.resolve()
          .then(() => client.getCheckRunsForRef(repo, ref))
          .then(summarizeCheckRuns)
          .catch((error: unknown) => ({ error: sanitizeGithub(errorMessage(error)) }))
        const workflows = await Promise.resolve()
          .then(() =>
            client.listWorkflowRunsForRef(repo, ref, { by: /^[0-9a-f]{7,40}$/i.test(ref) ? 'sha' : 'branch' }),
          )
          .then(summarizeWorkflowRuns)
          .catch((error: unknown) => ({ error: sanitizeGithub(errorMessage(error)) }))
        const checksFailed = 'error' in checks
        const workflowsFailed = 'error' in workflows
        if (checksFailed && workflowsFailed) {
          return failure(
            'checks_unavailable',
            `could not read checks (${String((checks as { error: string }).error)}); ` +
              `workflow runs (${String((workflows as { error: string }).error)})`,
          )
        }
        return {
          ok: true,
          action,
          repo,
          ref,
          checks,
          workflows,
          partial: checksFailed || workflowsFailed,
        }
      } catch (error) {
        return mapGithubError(error)
      }
    },
  })
  return definition
}

const workerDefinitionsCache = new WeakMap<ToolDeps, ToolDefinition[]>()

/** All Worker tools, in prompt order (schema compiled once per runtime deps). */
export function workerToolDefinitions(deps: ToolDeps): ToolDefinition[] {
  const cached = workerDefinitionsCache.get(deps)
  if (cached !== undefined) return cached
  const now = clockOf(deps)

  const readContext = jsonTool({
    name: 'superagent_worker_context',
    description:
      'Read your own ticket: card, thread window around the origin trigger, delivered inputs, and acceptance criteria. Call this before starting work and after an interruption.',
    parameters: {},
    async run(_args, exec) {
      const call = workerCallContext(exec, deps)
      if ('ok' in call) return call
      const ticket = deps.store.tickets.get(call.ticketId)
      if (!ticket) return failure('ticket_not_found')
      const originTrigger = deps.store.triggers.get(ticket.origin.triggerId)
      const snapshot = originTrigger ? deps.store.read.threadSnapshot(originTrigger.thread.key) : undefined
      const assignment = ticket.assignments.filter(item => item.id === call.assignmentId)[0]
      return {
        ok: true,
        assignmentId: call.assignmentId,
        ticket: renderTicketCard(ticket),
        acceptanceCriteria: [
          `deliver: ${ticket.title}`,
          `work inside your assignment directory; branch agent/${ticket.id}`,
          'tests/linters pass or the failure is explained in the report',
          'report ready with the exact branch/commit/PR reference',
        ],
        assignmentDirectory: assignment?.directory,
        originTrigger: originTrigger ? renderTriggerLine(originTrigger) : null,
        thread: snapshot ? renderThreadWindow(snapshot, 20) : null,
        undeliveredInputs: pendingInputs(deps, call.ticketId).map(input => ({
          id: input.id,
          kind: input.kind,
          at: input.at,
          text: oneLine(input.text ?? '', 800),
        })),
        previousReports: ticket.assignments
          .flatMap(item => (item.report ? [item.report] : []))
          .slice(-5)
          .map(report => ({ kind: report.kind, at: report.at, summary: oneLine(report.summary, 300) })),
      }
    },
  })

  const report = jsonTool({
    name: 'superagent_report',
    description:
      'Report structured state to your ticket. progress/waiting stay quiet; ready/blocked/failed notify the user. A blocked report requires exactly one question. End every turn with a report.',
    parameters: {
      kind: {
        type: 'string',
        enum: REPORT_KINDS as unknown as string[],
        required: true,
        description: 'progress | waiting | ready | blocked | failed | dropped',
      },
      summary: { type: 'string', required: true, description: 'Short factual summary (<= 500 chars)' },
      question: { type: 'string', description: 'blocked only: exactly one concrete question for a person' },
      prUrl: { type: 'string', description: 'ready: pull request URL' },
      prRepo: { type: 'string', description: 'ready: repository owner/name when the URL is unavailable' },
      prNumber: { type: 'integer', description: 'ready: pull request number' },
      branch: { type: 'string', description: 'Branch carrying the change, e.g. agent/t-123' },
      facts: { type: 'json', description: 'Free-form JSON facts (files, test results, commit sha)' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'Absolute local path (or path relative to the working directory)' },
            name: { type: 'string', description: 'Display name' },
            caption: { type: 'string', description: 'Short caption shown with the file' },
            kind: { type: 'string', enum: ['photo', 'document'], description: 'Send as photo or document (default: by extension)' },
          },
        },
        description: 'Local files to deliver to the user with a ready/blocked/failed report (max 10; screenshots, logs, artifacts)',
      },
    },
    async run(args, exec) {
      const call = workerCallContext(exec, deps)
      if ('ok' in call) return call
      const kind = String(args.kind) as ReportKind
      if (!REPORT_KINDS.includes(kind)) return failure('invalid_kind', `expected one of ${REPORT_KINDS.join(', ')}`)
      const summary = oneLine(args.summary, 500)
      if (!summary) return failure('summary_required')
      const question = oneLine(args.question ?? '', 500)
      if (kind === 'blocked' && !question) {
        return failure('question_required', 'a blocked report must contain exactly one concrete question')
      }
      const facts: Record<string, unknown> = {}
      if (args.facts && typeof args.facts === 'object' && !Array.isArray(args.facts)) {
        Object.assign(facts, args.facts as Record<string, unknown>)
      } else if (args.facts !== undefined) {
        facts.value = args.facts
      }
      if (typeof args.branch === 'string' && args.branch.trim()) facts.branch = args.branch.trim()
      const pullRequest = pullRequestOf(args as Record<string, unknown>)
      if (pullRequest) facts.pullRequest = pullRequest
      const reportFiles = reportFilesOf(args.files, call.cwd)
      if (reportFiles.invalid.length > 0) {
        return failure('invalid_file_path', `files must exist and be readable: ${reportFiles.invalid.join(', ')}`)
      }
      const reportValue: Report = {
        kind,
        summary,
        at: now(),
        ...(kind === 'blocked' ? { question } : {}),
        ...(pullRequest ? { pullRequest } : {}),
        ...(Object.keys(facts).length > 0 ? { facts } : {}),
        ...(reportFiles.files.length > 0 ? { files: reportFiles.files } : {}),
      }
      deps.engine.executor.report({ ticketId: call.ticketId, assignmentId: call.assignmentId, report: reportValue })
      deps.wake?.()
      return {
        ok: true,
        accepted: true,
        kind,
        at: reportValue.at,
        ticketId: call.ticketId,
        ...(reportFiles.files.length > 0 ? { files: reportFiles.files.length } : {}),
      }
    },
  })

  const ack = jsonTool({
    name: 'superagent_ack',
    description: 'Acknowledge delivered ticket input once you start acting on it (all undelivered input when ids are omitted).',
    parameters: {
      inputIds: { type: 'array', items: { type: 'string' }, description: 'Input ids to acknowledge' },
    },
    async run(args, exec) {
      const call = workerCallContext(exec, deps)
      if ('ok' in call) return call
      const undelivered = pendingInputs(deps, call.ticketId)
      const requested: string[] = Array.isArray(args.inputIds) ? args.inputIds.map(String) : []
      const ids = requested.length > 0 ? requested : undelivered.map(input => input.id)
      if (ids.length === 0) return { ok: true, acknowledged: 0 }
      deps.engine.executor.inputsDelivered(call.ticketId, call.assignmentId, ids)
      deps.wake?.()
      return { ok: true, acknowledged: ids.length, inputIds: ids }
    },
  })

  const handback = jsonTool({
    name: 'superagent_handback',
    description:
      'Hand a trigger back to the Router when it belongs to different work than this ticket. Use instead of answering it yourself.',
    parameters: {
      triggerId: { type: 'string', required: true, description: 'Trigger id that should be re-routed' },
      reason: { type: 'string', required: true, description: 'Why it does not belong to this ticket' },
    },
    async run(args, exec) {
      const call = workerCallContext(exec, deps)
      if ('ok' in call) return call
      deps.engine.executor.handback(call.ticketId, String(args.triggerId), oneLine(args.reason, 300))
      deps.wake?.()
      return { ok: true, ticketId: call.ticketId, triggerId: String(args.triggerId) }
    },
  })

  const followContext = jsonTool({
    name: 'superagent_follow_context',
    description: 'Follow another thread for context only (no authority is granted by following).',
    parameters: {
      thread: { type: 'string', required: true, description: 'Thread key to follow' },
      source: { type: 'string', required: true, description: 'Source id of that thread' },
      label: { type: 'string', description: 'Optional human label' },
    },
    async run(args, exec) {
      const call = workerCallContext(exec, deps)
      if ('ok' in call) return call
      deps.wake?.()
      deps.engine.executor.followForContext(call.ticketId, {
        key: String(args.thread),
        source: String(args.source),
        ...(args.label ? { label: oneLine(args.label, 120) } : {}),
      })
      return { ok: true, ticketId: call.ticketId, following: String(args.thread) }
    },
  })

  const markUnrelated = jsonTool({
    name: 'superagent_mark_unrelated',
    description: 'Tell the runtime that a subscribed thread is unrelated to this ticket, so it stops forwarding it.',
    parameters: {
      thread: { type: 'string', required: true, description: 'Thread key that is unrelated' },
      reason: { type: 'string', required: true, description: 'Why it is unrelated' },
    },
    async run(args, exec) {
      const call = workerCallContext(exec, deps)
      if ('ok' in call) return call
      deps.engine.executor.markUnrelated(call.ticketId, String(args.thread), oneLine(args.reason, 300))
      deps.wake?.()
      return { ok: true, ticketId: call.ticketId, thread: String(args.thread) }
    },
  })

  const definitions = [readContext, report, ack, githubToolDefinition(deps), handback, followContext, markUnrelated]
  workerDefinitionsCache.set(deps, definitions)
  return definitions
}

/** Register every Worker tool in a worker agent's scope. */
export function registerWorkerTools(agentCtx: Context, deps: ToolDeps): void {
  registerScoped(agentCtx, deps, workerToolDefinitions(deps))
}
