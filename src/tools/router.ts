/**
 * Router tools.
 *
 * Registered only inside the Router session's scope, so a user session never
 * sees them and a worker session cannot route work. The Router decides; it has
 * no write/execute tools by construction (the `superagent-router` preset only
 * mounts read tools).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { OutboundMessage, Reason, ReplyPurpose } from '../core/model.js'
import { oneLine } from '../app/support.js'
import { renderTicketCard, renderThreadWindow } from '../prompts/index.js'
import {
  asJson,
  clockOf,
  failure,
  isRouterCall,
  registerScoped,
  renderJson,
  toolId,
  type ToolDeps,
} from './shared.js'

const REPLY_PURPOSES: ReplyPurpose[] = ['answer', 'attention', 'notice', 'result', 'acknowledgement']

/** Build a JSON-returning tool definition with the shared envelope. */
function jsonTool<S extends Record<string, any>>(
  definition: {
    name: string
    description: string
    parameters: S
    run(args: any, exec: ToolRunContext): Promise<unknown>
  },
): ToolDefinition {
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

/** All Router tools, in prompt order. */
export function routerToolDefinitions(deps: ToolDeps): ToolDefinition[] {
  const now = clockOf(deps)

  const readCandidate = jsonTool({
    name: 'superagent_read_candidate',
    description:
      'Read one candidate (a trigger batch waiting for a routing decision) with its thread window and related tickets.',
    parameters: {
      triggerId: { type: 'string', required: true, description: 'Trigger id from the candidate block' },
      limit: { type: 'integer', description: 'Thread window size (default 12, max 40)' },
    },
    async run(args) {
      const candidate = deps.engine.candidateOf(String(args.triggerId))
      if (!candidate) return failure('candidate_not_found', 'the candidate was already decided or expired')
      const limit = Math.min(Math.max(Number(args.limit ?? 12), 1), 40)
      return {
        ok: true,
        evalId: candidate.eval.id,
        triggerId: candidate.primaryTrigger.id,
        policyVersion: candidate.policyVersion,
        ticketsTotal: candidate.ticketsTotal,
        thread: renderThreadWindow(candidate.thread, limit),
        triggers: candidate.triggers.map(trigger => ({
          id: trigger.id,
          at: trigger.at,
          actor: trigger.actor,
          addressed: trigger.addressed,
          text: oneLine(trigger.text, 2000),
        })),
        relatedTickets: candidate.relatedTickets.map(ticket => ({
          id: ticket.id,
          title: ticket.title,
          state: ticket.state,
          latestReport: ticket.latestReport?.kind,
        })),
      }
    },
  })

  const readThread = jsonTool({
    name: 'superagent_read_thread',
    description: 'Read a conversation thread (recent triggers plus the tickets attached to it).',
    parameters: {
      thread: { type: 'string', required: true, description: 'Thread key, e.g. telegram:dm:42' },
      limit: { type: 'integer', description: 'How many recent triggers (default 12, max 40)' },
    },
    async run(args) {
      const limit = Math.min(Math.max(Number(args.limit ?? 12), 1), 40)
      const snapshot = deps.store.read.threadSnapshot(String(args.thread))
      if (!snapshot) return failure('thread_not_found')
      return { ok: true, thread: renderThreadWindow(snapshot, limit) }
    },
  })

  const readTicket = jsonTool({
    name: 'superagent_read_ticket',
    description: 'Read one ticket: card, follow refs and the latest report.',
    parameters: {
      ticketId: { type: 'string', required: true, description: 'Ticket id from a candidate or the panel' },
    },
    async run(args) {
      const ticket = deps.store.tickets.get(String(args.ticketId))
      if (!ticket) return failure('ticket_not_found')
      return { ok: true, ticket: renderTicketCard(ticket) }
    },
  })

  const route = jsonTool({
    name: 'superagent_route',
    description:
      'Record the routing decision for one candidate. Call this exactly once per candidate: accept opens a ticket and starts a worker, ignore drops it, stop ends the thread\'s work.',
    parameters: {
      triggerId: { type: 'string', required: true, description: 'Trigger id of the candidate batch' },
      outcome: { type: 'string', enum: ['accept', 'ignore', 'stop'], required: true },
      title: { type: 'string', description: 'Accept only: short imperative ticket title (<= 80 chars)' },
      reasonCode: {
        type: 'string',
        description: 'Stable code, e.g. noise | duplicate | out_of_scope | needs_clarification | already_answered | user_stop | thread_closed',
      },
      reason: { type: 'string', description: 'One short line explaining the decision' },
      rules: { type: 'array', items: { type: 'string' }, description: 'Matched policy rule ids (accept only)' },
      note: { type: 'string', description: 'Accept only: extra guidance delivered to the worker once' },
    },
    async run(args, exec) {
      if (!isRouterCall(exec, deps)) return failure('not_router_session')
      if (args.outcome === 'accept' && !String(args.title ?? '').trim()) {
        return failure('title_required', 'accept decisions need a short title')
      }
      const reason: Reason[] = []
      if (args.reasonCode) reason.push({ code: String(args.reasonCode) })
      if (args.reason) reason.push({ code: 'said', said: oneLine(args.reason, 300) })
      if (reason.length === 0) reason.push({ code: args.outcome === 'accept' ? 'accepted' : 'decided' })
      const result = deps.engine.mainSession.decide({
        triggerId: String(args.triggerId),
        outcome: args.outcome,
        reason,
        ...(args.title ? { title: oneLine(args.title, 120) } : {}),
        ...(Array.isArray(args.rules) ? { rules: args.rules.map(String) } : {}),
        ...(args.note ? { note: oneLine(args.note, 1000) } : {}),
      })
      return {
        ok: true,
        decisionId: result.decision.id,
        outcome: result.decision.outcome,
        ticketId: result.ticket?.id,
      }
    },
  })

  const ticket = jsonTool({
    name: 'superagent_ticket',
    description:
      'Manage an existing ticket: retry (new attempt), status (ask the worker), stop (end it), note (guidance without interrupting).',
    parameters: {
      ticketId: { type: 'string', required: true, description: 'Ticket id' },
      action: { type: 'string', enum: ['retry', 'status', 'stop', 'note'], required: true },
      text: { type: 'string', description: 'note: guidance text; stop: optional reason' },
    },
    async run(args, exec) {
      if (!isRouterCall(exec, deps)) return failure('not_router_session')
      const ticketId = String(args.ticketId)
      const existing = deps.store.tickets.get(ticketId)
      if (!existing) return failure('ticket_not_found')
      switch (args.action) {
        case 'retry': {
          deps.engine.people.retryTicket(ticketId)
          return { ok: true, action: 'retry', ticketId }
        }
        case 'status': {
          const asked = deps.engine.mainSession.requestStatus(ticketId)
          return asked
            ? { ok: true, action: 'status', ticketId }
            : { ok: false, error: 'no_live_worker', detail: 'the worker session is not live; use retry to start one' }
        }
        case 'stop': {
          deps.engine.people.stopTicket(ticketId, args.text ? oneLine(args.text, 300) : undefined)
          return { ok: true, action: 'stop', ticketId }
        }
        case 'note': {
          if (!String(args.text ?? '').trim()) return failure('text_required')
          deps.engine.mainSession.note(ticketId, oneLine(args.text, 1000))
          return { ok: true, action: 'note', ticketId }
        }
        default:
          return failure('unknown_action')
      }
    },
  })

  const reply = jsonTool({
    name: 'superagent_reply',
    description:
      'Send one short message to a person on a Source channel. Use only when the person is waiting or a decision is needed. Quiet policy: no acks, no progress.',
    parameters: {
      source: { type: 'string', required: true, description: 'Source id, e.g. telegram or github' },
      thread: { type: 'string', required: true, description: 'Thread key the reply belongs to' },
      to: { type: 'string', required: true, description: 'Source-specific destination (chat id, issue number)' },
      text: { type: 'string', required: true, description: 'Message text, <= 500 chars, one question at most' },
      purpose: {
        type: 'string',
        enum: REPLY_PURPOSES as unknown as string[],
        description: 'Defaults to answer',
      },
      replyTo: { type: 'string', description: 'Optional message/comment id to thread under' },
    },
    async run(args, exec) {
      if (!isRouterCall(exec, deps)) return failure('not_router_session')
      const text = String(args.text ?? '').trim()
      if (!text) return failure('text_required')
      const message: OutboundMessage = {
        id: toolId('msg'),
        purpose: REPLY_PURPOSES.includes(args.purpose as ReplyPurpose) ? (args.purpose as ReplyPurpose) : 'answer',
        channel: {
          source: String(args.source),
          thread: String(args.thread),
          to: String(args.to),
          ...(args.replyTo ? { replyTo: String(args.replyTo) } : {}),
        },
        text: text.length > 500 ? `${text.slice(0, 499)}…` : text,
        markdown: 'plain',
        at: now(),
      }
      deps.engine.mainSession.reply(message)
      return { ok: true, messageId: message.id, queued: true }
    },
  })

  const pause = jsonTool({
    name: 'superagent_pause',
    description: 'Pause or resume all proactive SuperAgent work (existing tickets are not cancelled).',
    parameters: {
      paused: { type: 'boolean', required: true, description: 'true pauses, false resumes' },
    },
    async run(args, exec) {
      if (!isRouterCall(exec, deps)) return failure('not_router_session')
      deps.engine.people.pause(Boolean(args.paused))
      return { ok: true, paused: Boolean(args.paused) }
    },
  })

  return [readCandidate, readThread, readTicket, route, ticket, reply, pause]
}

/** Register every Router tool in the Router agent's scope. */
export function registerRouterTools(agentCtx: Context, deps: ToolDeps): void {
  registerScoped(agentCtx, deps, routerToolDefinitions(deps))
}
