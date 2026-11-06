/**
 * Worker tools.
 *
 * Registered only inside a worker session's scope. A worker can read its own
 * ticket and thread context and report structured state; it cannot route,
 * create tickets, talk to the user, or touch another ticket.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Input, PullRequestRef, Report, ReportKind } from '../core/model.js'
import { oneLine } from '../app/support.js'
import { renderTicketCard, renderThreadWindow, renderTriggerLine } from '../prompts/index.js'
import {
  asJson,
  clockOf,
  failure,
  registerScoped,
  renderJson,
  workerCallContext,
  type ToolDeps,
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

  return [readContext, report, ack, handback, followContext, markUnrelated]
}

/** Register every Worker tool in a worker agent's scope. */
export function registerWorkerTools(agentCtx: Context, deps: ToolDeps): void {
  registerScoped(agentCtx, deps, workerToolDefinitions(deps))
}
