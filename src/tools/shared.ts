/**
 * Shared tool plumbing.
 *
 * Tools are *small and unambiguous*: one verb per tool, minimal parameters,
 * structured JSON results, and a hard check that the calling session is the
 * role the tool was registered for. Router tools live only in the Router
 * session's scope; worker tools only in a worker session's scope.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Engine, Store } from '../core/ports.js'
import type { IsoTime, TicketId } from '../core/model.js'
import type { Sessions } from '../app/sessions.js'
import type { AppLogger } from '../app/support.js'
import { errorMessage, nowIso, oneLine } from '../app/support.js'

/** GitHub credentials for the worker GitHub tool (runtime config or tests). */
export interface GithubToolOptions {
  /** Literal token (tests only; production reads a file or env). */
  token?: string
  /** Absolute token file; omitted → `<stateDir>/secrets/github-token` when present. */
  tokenFile?: string
  /** Environment variable name; defaults to the Source default `SUPERAGENT_GITHUB_TOKEN`. */
  tokenEnv?: string
  /** API base URL (GitHub Enterprise/tests); defaults to `https://api.github.com`. */
  apiBaseUrl?: string
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
  /** Injected fetch (tests). */
  fetchImpl?: typeof fetch
  /**
   * GitHub logins automatically invited (permission: admin) when
   * `superagent_github action=create_repository` creates a repository. The
   * invite list comes from configuration only (the tool has no per-call arg).
   */
  collaborators?: string[]
  /** Authenticated GitHub account login (used for wildcard repo-owner checks). */
  login?: string
  /** Personal (operator) PAT file used to auto-accept repository invitations. */
  operatorTokenFile?: string
}

export interface ToolDeps {
  engine: Engine
  store: Store
  sessions: Sessions
  logger: AppLogger
  now?: () => IsoTime
  /** Prefix used for ids minted by tools (replies). */
  idPrefix?: string
  /** GitHub credentials for `superagent_github`; resolved from env/secret file when absent. */
  github?: GithubToolOptions
  /** Wake the runtime pipeline after a committed command (event-driven fast path). */
  wake?: () => void
}

export function clockOf(deps: ToolDeps): () => IsoTime {
  return deps.now ?? nowIso
}

let counter = 0
/** Mint a collision-resistant id without a host service. */
export function toolId(prefix: string): string {
  counter = (counter + 1) % 0xffff
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** Round-trip a value through JSON so it is lossless-JSON for the tool output. */
export function asJson(value: unknown): any {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return { ok: false, error: 'unserializable' }
  }
}

/** Render a tool value as one text block, bounded in size. */
export function renderJson(value: unknown, limit = 12_000): Array<{ type: 'text'; text: string }> {
  let text: string
  try {
    text = JSON.stringify(value, null, 1)
  } catch {
    text = String(value)
  }
  if (text.length > limit) text = `${text.slice(0, limit)}\n… [truncated]`
  return [{ type: 'text', text }]
}

/** A uniform success/failure envelope for the model. */
export interface ToolResultOk {
  ok: true
  [key: string]: unknown
}
export interface ToolResultError {
  ok: false
  error: string
  detail?: string
}

export function failure(error: string, detail?: string): ToolResultError {
  return { ok: false, error, ...(detail ? { detail } : {}) }
}

/** Register definitions in the agent scope, logging and skipping broken ones. */
export function registerScoped(agentCtx: Context, deps: ToolDeps, definitions: ToolDefinition[]): void {
  const tools = agentCtx.get('tools') as { register?: (definition: ToolDefinition, options?: unknown) => () => void } | undefined
  if (!tools?.register) {
    deps.logger.warn('tool registry unavailable; SuperAgent tools are not registered')
    return
  }
  for (const definition of definitions) {
    try {
      tools.register(definition)
    } catch (error) {
      deps.logger.error('failed to register tool', { tool: definition.name, error: errorMessage(error) })
    }
  }
}

/** The worker identity of the calling session, or a thrown structured failure. */
export interface WorkerCallContext {
  ticketId: TicketId
  assignmentId: string
  sessionId: string
  /** The worker's working directory, when the session was created by the Executor. */
  cwd?: string
}

export function workerCallContext(
  exec: ToolRunContext,
  deps: ToolDeps,
): WorkerCallContext | ToolResultError {
  const agent = exec.agent
  if (!agent) return failure('no_caller', 'this tool must be called by a SuperAgent worker session')
  const sessionId = String(agent.session.id)
  const info = deps.sessions.infoForSession(agent.session.id)
  if (!info || info.role !== 'worker' || !info.ticketId) {
    return failure('not_worker_session', 'this tool is only available inside a SuperAgent worker session')
  }
  const ticketId = info.ticketId
  const binding = deps.sessions.bindingFor(ticketId)
  let assignmentId = binding?.assignmentId
  if (!assignmentId) {
    const ticket = deps.store.tickets.get(ticketId)
    const running = ticket?.assignments.filter(assignment => assignment.state === 'running')
    assignmentId = running?.[running.length - 1]?.id
  }
  if (!assignmentId) {
    return failure('no_assignment', 'this ticket has no running assignment; the runtime will start one')
  }
  return { ticketId, assignmentId, sessionId, ...(info.cwd ? { cwd: info.cwd } : {}) }
}

/** Resolve a repository for a ticket: explicit argument, trigger meta, then mandate scope. */
export function resolveRepository(deps: ToolDeps, ticketId: TicketId, explicit?: string): string | undefined {
  const fromArgument = explicit?.trim()
  if (fromArgument) return /^[\w.-]+\/[\w.-]+$/.test(fromArgument) ? fromArgument : undefined
  const ticket = deps.store.tickets.get(ticketId)
  if (!ticket) return undefined
  const trigger = deps.store.triggers.get(ticket.origin.triggerId)
  const meta = trigger?.meta ?? {}
  for (const key of ['repository', 'repo', 'fullName', 'repoFullName']) {
    const value = meta[key]
    if (typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value)) return value
  }
  const scope = ticket.mandate.scope
  if (scope.startsWith('github:')) {
    const repo = scope.slice('github:'.length)
    if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return repo
  }
  return undefined
}

/** The router identity check for router-scoped tools. */
export function isRouterCall(exec: ToolRunContext, deps: ToolDeps): boolean {
  const agent = exec.agent
  if (!agent) return false
  const info = deps.sessions.infoForSession(agent.session.id)
  return info?.role === 'router'
}

/** Human-readable one-liner used by tool render output. */
export function describeTicket(deps: ToolDeps, ticketId: TicketId): string {
  const ticket = deps.store.tickets.get(ticketId)
  return ticket ? oneLine(ticket.title, 120) : ticketId
}
