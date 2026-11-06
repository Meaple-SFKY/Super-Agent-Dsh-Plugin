/**
 * Worker tools.
 *
 * Registered only inside a worker session's scope. A worker can read its own
 * ticket and thread context and report structured state; it cannot route,
 * create tickets, talk to the user, or touch another ticket.
 */

import { existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  GithubApi,
  GithubCheckRun,
  GithubCheckRunsResponse,
  GithubPullRequest,
  GithubWorkflowRunsResponse,
} from '../sources/github-api.js'
import type { Input, PullRequestRef, Report, ReportKind } from '../core/model.js'
import { errorMessage, oneLine } from '../app/support.js'
import { renderTicketCard, renderThreadWindow, renderTriggerLine } from '../prompts/index.js'
import {
  asJson,
  clockOf,
  failure,
  registerScoped,
  renderJson,
  resolveRepository,
  workerCallContext,
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

interface GithubModule {
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

function secretFileFor(deps: ToolDeps, call: WorkerCallContext, name: string): string | undefined {
  const configured = deps.github?.tokenFile
  if (typeof configured === 'string' && configured.length > 0) return configured
  if (!call.cwd) return undefined
  // The executor puts workers in `<stateDir>/work/<ticketId>`.
  const candidate = resolvePath(call.cwd, '..', '..', 'secrets', name)
  return existsSync(candidate) ? candidate : undefined
}

type GithubClientResult = { client: GithubApi; tokenSource: 'literal' | 'file' | 'env' } | { ok: false; error: string; detail?: string }

/** Build an authenticated client; token failures are structured, never thrown with the secret. */
async function githubClient(deps: ToolDeps, call: WorkerCallContext): Promise<GithubClientResult> {
  const module = await loadGithubModule()
  if (!module) return failure('github_unavailable', 'the GitHub API module is unavailable in this build')
  const options = deps.github ?? {}
  let token: string
  let tokenSource: 'literal' | 'file' | 'env'
  if (typeof options.token === 'string' && options.token.trim().length > 0) {
    token = options.token.trim()
    tokenSource = 'literal'
  } else {
    const tokenFile = secretFileFor(deps, call, 'github-token')
    const provider = module.createGithubTokenProvider({
      ...(tokenFile ? { tokenFile } : {}),
      ...(options.tokenEnv ? { tokenEnv: options.tokenEnv } : {}),
    })
    try {
      token = (await provider()).trim()
    } catch (error) {
      return mapGithubError(error)
    }
    if (token.length === 0) return failure('github_token_missing', 'the GitHub token is empty')
    tokenSource = tokenFile ? 'file' : 'env'
  }
  const client = new module.GithubApi({
    token,
    ...(options.apiBaseUrl ? { baseUrl: options.apiBaseUrl } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    maxAttempts: 2,
    baseDelayMs: 250,
    maxDelayMs: 2_000,
  })
  return { client, tokenSource }
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

/** The `superagent_github` tool definition (worker scope only). */
function githubToolDefinition(deps: ToolDeps): ToolDefinition {
  const now = clockOf(deps)

  const definition = jsonTool({
    name: 'superagent_github',
    description:
      'GitHub actions for your ticket: open (or return) a pull request for your branch, comment on a PR/issue, or read CI checks. ' +
      'Uses the configured SuperAgent GitHub token; never pass a token. Idempotent: the same branch returns the existing PR, and a repeated comment is not posted twice.',
    parameters: {
      action: { type: 'string', enum: ['pull_request', 'comment', 'checks'], required: true, description: 'Which GitHub action to perform' },
      repo: { type: 'string', description: 'owner/name; defaults to the repository inferred from the ticket' },
      head: { type: 'string', description: 'pull_request: source branch (default agent/<ticketId>)' },
      base: { type: 'string', description: 'pull_request: target branch (default: repository default branch)' },
      title: { type: 'string', description: 'pull_request: title (default: ticket title)' },
      body: { type: 'string', description: 'pull_request/comment: markdown body; the PR gets a hidden SuperAgent marker automatically' },
      number: { type: 'integer', description: 'comment: PR/issue number (default: the ticket PR); checks: resolve the head SHA from this PR' },
      ref: { type: 'string', description: 'checks: commit SHA or branch (default agent/<ticketId>)' },
      draft: { type: 'boolean', description: 'pull_request: open as draft' },
    },
    async run(args, exec) {
      const call = workerCallContext(exec, deps)
      if ('ok' in call) return call
      const action = String(args.action ?? '')
      if (action !== 'pull_request' && action !== 'comment' && action !== 'checks') {
        return failure('invalid_action', 'expected pull_request, comment or checks')
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
      const ticket = deps.store.tickets.get(call.ticketId)

      try {
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

        // action === 'checks'
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
          action: 'checks',
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

/** All Worker tools, in prompt order. */
export function workerToolDefinitions(deps: ToolDeps): ToolDefinition[] {
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
      const reportValue: Report = {
        kind,
        summary,
        at: now(),
        ...(kind === 'blocked' ? { question } : {}),
        ...(pullRequest ? { pullRequest } : {}),
        ...(Object.keys(facts).length > 0 ? { facts } : {}),
      }
      deps.engine.executor.report({ ticketId: call.ticketId, assignmentId: call.assignmentId, report: reportValue })
      return { ok: true, accepted: true, kind, at: reportValue.at, ticketId: call.ticketId }
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
      return { ok: true, ticketId: call.ticketId, thread: String(args.thread) }
    },
  })

  return [readContext, report, ack, githubToolDefinition(deps), handback, followContext, markUnrelated]
}

/** Register every Worker tool in a worker agent's scope. */
export function registerWorkerTools(agentCtx: Context, deps: ToolDeps): void {
  registerScoped(agentCtx, deps, workerToolDefinitions(deps))
}
