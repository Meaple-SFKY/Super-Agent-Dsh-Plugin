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

export interface ToolDeps {
  engine: Engine
  store: Store
  sessions: Sessions
  logger: AppLogger
  now?: () => IsoTime
  /** Prefix used for ids minted by tools (replies). */
  idPrefix?: string
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
  return { ticketId, assignmentId, sessionId }
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
