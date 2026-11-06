/**
 * Router/Worker tool tests: scope checks, structured failures, engine wiring.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { registerRouterTools } from '../src/tools/router.js'
import { registerWorkerTools } from '../src/tools/worker.js'
import type { ToolDeps } from '../src/tools/shared.js'
import { Sessions, type HostAgentRegistry } from '../src/app/sessions.js'
import type { Assignment, Ticket, Trigger } from '../src/core/model.js'
import { makeHarness, makeTrigger } from './core-fixtures.js'
import { createFakeHost, textOf } from './runtime-host.js'
import type { Context } from '@deepseek-ai/cordis'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface ToolSetup {
  host: ReturnType<typeof createFakeHost>
  harness: ReturnType<typeof makeHarness>
  sessions: Sessions
  deps: ToolDeps
  router: ReturnType<ReturnType<typeof makeHarness>['store']['tickets']['get']> extends never ? never : any
}

async function makeTools(): Promise<ToolSetup> {
  const host = createFakeHost()
  const harness = makeHarness()
  const sessions = new Sessions({
    agents: host.agents as unknown as HostAgentRegistry,
    presets: host.presets as never,
    persistence: host.persistence as never,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    kv: harness.store.kv,
    createTimeoutMs: 2_000,
  })
  const dir = mkdtempSync(join(tmpdir(), 'superagent-tools-'))
  dirs.push(dir)
  const routerAgent = await sessions.ensureRouter(dir)
  const deps: ToolDeps = { engine: harness.engine, store: harness.store, sessions, logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } }
  registerRouterTools(routerAgent.ctx as unknown as Context, deps)
  return { host, harness, sessions, deps, router: host.agents.liveAgent('superagent-router') }
}

/** Feed one trigger and start its Eval, without deciding it. */
function makeCandidate(setup: ToolSetup, text = 'please fix the build'): Trigger {
  const trigger = makeTrigger({ text })
  setup.harness.engine.sources.receive(trigger)
  setup.harness.engine.evaluateDue()
  return trigger
}

/** Create a ticket through the engine and return it with its pending assignment. */
function makeTicket(setup: ToolSetup, text = 'please fix the build'): { ticket: Ticket; assignment: Assignment; trigger: Trigger } {
  const trigger = makeTrigger({ text })
  setup.harness.engine.sources.receive(trigger)
  setup.harness.engine.evaluateDue()
  const result = setup.harness.engine.mainSession.decide({ triggerId: trigger.id, outcome: 'accept', title: 'Fix the build', reason: [{ code: 'test' }] })
  const ticket = setup.harness.store.tickets.get(result.ticket!.id)!
  return { ticket, assignment: ticket.assignments[ticket.assignments.length - 1]!, trigger }
}

async function makeWorkerTools(): Promise<{ setup: ToolSetup; worker: ReturnType<ReturnType<typeof createFakeHost>['agents']['liveAgent']>; ticket: Ticket; assignment: Assignment }> {
  const setup = await makeTools()
  const { ticket, assignment } = makeTicket(setup)
  const dir = mkdtempSync(join(tmpdir(), 'superagent-worker-'))
  dirs.push(dir)
  const agent = await setup.sessions.ensureWorker(ticket.id, dir)
  setup.sessions.bindAssignment(ticket.id, agent.session.id, assignment.id)
  registerWorkerTools(agent.ctx as unknown as Context, setup.deps)
  const worker = setup.host.agents.liveAgent(`superagent-worker-${ticket.id}`)!
  return { setup, worker, ticket, assignment }
}

describe('router tools', () => {
  it('registers the full router toolset and nothing from the worker role', async () => {
    const setup = await makeTools()
    const names = setup.host.toolsFor(setup.router).names().sort()
    expect(names).toEqual(
      [
        'superagent_pause',
        'superagent_read_candidate',
        'superagent_read_thread',
        'superagent_read_ticket',
        'superagent_reply',
        'superagent_route',
        'superagent_ticket',
      ].sort(),
    )
  })

  it('rejects an accept without a title and records a valid accept', async () => {
    const setup = await makeTools()
    const trigger = makeCandidate(setup)

    const invalid = (await setup.host.executeTool(setup.router, 'superagent_route', {
      triggerId: trigger.id,
      outcome: 'accept',
    })).value as { ok: boolean; error?: string }
    expect(invalid.ok).toBe(false)
    expect(invalid.error).toBe('title_required')

    const valid = (await setup.host.executeTool(setup.router, 'superagent_route', {
      triggerId: trigger.id,
      outcome: 'accept',
      title: 'Ship the fix',
      rules: ['r1'],
      reasonCode: 'explicit_request',
      reason: 'asked directly',
    })).value as { ok: boolean; decisionId: string; ticketId: string }
    expect(valid.ok).toBe(true)
    expect(setup.harness.store.decisions.get(valid.decisionId)?.outcome).toBe('accept')
    expect(setup.harness.store.tickets.get(valid.ticketId)!.state).toBe('open')
  })

  it('reads candidate, thread and ticket with structured failures for unknown ids', async () => {
    const setup = await makeTools()
    const candidateTrigger = makeCandidate(setup)
    const { trigger, ticket } = makeTicket(setup)
    const candidate = (await setup.host.executeTool(setup.router, 'superagent_read_candidate', { triggerId: candidateTrigger.id })).value as {
      ok: boolean
      triggerId: string
    }
    expect(candidate.ok).toBe(true)
    expect(candidate.triggerId).toBe(candidateTrigger.id)

    const thread = (await setup.host.executeTool(setup.router, 'superagent_read_thread', { thread: trigger.thread.key })).value as {
      ok: boolean
      thread: string
    }
    expect(thread.ok).toBe(true)
    expect(thread.thread).toContain(trigger.thread.key)

    const card = (await setup.host.executeTool(setup.router, 'superagent_read_ticket', { ticketId: ticket.id })).value as {
      ok: boolean
      ticket: string
    }
    expect(card.ok).toBe(true)
    expect(card.ticket).toContain('Fix the build')

    const missing = (await setup.host.executeTool(setup.router, 'superagent_read_ticket', { ticketId: 't_nope' })).value as {
      ok: boolean
      error: string
    }
    expect(missing).toEqual({ ok: false, error: 'ticket_not_found' })

    const decided = (await setup.host.executeTool(setup.router, 'superagent_read_candidate', { triggerId: 'tr_missing' })).value as {
      ok: boolean
      error: string
    }
    expect(decided.ok).toBe(false)
    expect(decided.error).toBe('candidate_not_found')
  })

  it('queues a user reply and can pause/resume', async () => {
    const setup = await makeTools()
    const reply = (await setup.host.executeTool(setup.router, 'superagent_reply', {
      source: 'telegram',
      thread: 'telegram:dm:u1',
      to: 'u1',
      text: 'Do you want me to open the PR?',
    })).value as { ok: boolean; messageId: string }
    expect(reply.ok).toBe(true)
    const message = setup.harness.outbox.messages.find(entry => entry.id === reply.messageId)
    expect(message?.text).toBe('Do you want me to open the PR?')
    expect(message?.purpose).toBe('answer')
    expect(message?.channel).toEqual({ source: 'telegram', thread: 'telegram:dm:u1', to: 'u1' })

    const pause = (await setup.host.executeTool(setup.router, 'superagent_pause', { paused: true })).value as { ok: boolean; paused: boolean }
    expect(pause.ok).toBe(true)
    expect(pause.paused).toBe(true)
    const resume = (await setup.host.executeTool(setup.router, 'superagent_pause', { paused: false })).value as { ok: boolean; paused: boolean }
    expect(resume.paused).toBe(false)
  })

  it('manages tickets: retry, status, note and stop', async () => {
    const setup = await makeTools()
    const { ticket } = makeTicket(setup)
    const note = (await setup.host.executeTool(setup.router, 'superagent_ticket', {
      ticketId: ticket.id,
      action: 'note',
      text: 'prefer the smaller diff',
    })).value as { ok: boolean }
    expect(note.ok).toBe(true)
    expect(setup.harness.store.tickets.get(ticket.id)!.inputs.some(input => input.text === 'prefer the smaller diff')).toBe(true)

    const status = (await setup.host.executeTool(setup.router, 'superagent_ticket', { ticketId: ticket.id, action: 'status' })).value as {
      ok: boolean
      error?: string
    }
    expect(status.ok).toBe(false)
    expect(status.error).toBe('no_live_worker')

    const stop = (await setup.host.executeTool(setup.router, 'superagent_ticket', {
      ticketId: ticket.id,
      action: 'stop',
      text: 'user changed their mind',
    })).value as { ok: boolean }
    expect(stop.ok).toBe(true)
    expect(setup.harness.store.tickets.get(ticket.id)!.state).toBe('ended')

    const missing = (await setup.host.executeTool(setup.router, 'superagent_ticket', { ticketId: 't_nope', action: 'retry' })).value as {
      ok: boolean
    }
    expect(missing.ok).toBe(false)
  })

  it('refuses router tools outside the router session', async () => {
    const setup = await makeTools()
    const { ticket } = makeTicket(setup)
    const dir = mkdtempSync(join(tmpdir(), 'superagent-intruder-'))
    dirs.push(dir)
    const intruder = await setup.sessions.ensureWorker('t_intruder', dir)
    // Register the router tools on the worker scope to prove the runtime guard, not just scoping.
    registerRouterTools(intruder.ctx as unknown as Context, setup.deps)
    const result = (await setup.host.executeTool(setup.host.agents.liveAgent('superagent-worker-t_intruder')!, 'superagent_route', {
      triggerId: 'tr_x',
      outcome: 'accept',
      title: 'x',
    })).value as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_router_session')
    expect(ticket.state).toBe('open')
  })
})

describe('worker tools', () => {
  it('registers the worker toolset without router tools', async () => {
    const { setup, worker } = await makeWorkerTools()
    const names = setup.host.toolsFor(worker!).names().sort()
    expect(names).toEqual(
      [
        'superagent_ack',
        'superagent_follow_context',
        'superagent_handback',
        'superagent_mark_unrelated',
        'superagent_report',
        'superagent_worker_context',
      ].sort(),
    )
  })

  it('reads the worker context with acceptance criteria and assignment', async () => {
    const { setup, worker, ticket, assignment } = await makeWorkerTools()
    const context = (await setup.host.executeTool(worker!, 'superagent_worker_context', {})).value as {
      ok: boolean
      assignmentId: string
      ticket: string
      acceptanceCriteria: string[]
    }
    expect(context.ok).toBe(true)
    expect(context.assignmentId).toBe(assignment.id)
    expect(context.ticket).toContain(ticket.id)
    expect(context.acceptanceCriteria.length).toBeGreaterThan(2)
  })

  it('validates report kinds and records ready reports with a PR reference', async () => {
    const { setup, worker, ticket } = await makeWorkerTools()
    await expect(setup.host.executeTool(worker!, 'superagent_report', { kind: 'progress' })).rejects.toThrow(/summary/)

    const ready = (await setup.host.executeTool(worker!, 'superagent_report', {
      kind: 'ready',
      summary: 'PR is up',
      prUrl: 'https://github.com/owner/repo/pull/12',
      branch: 'agent/t-1',
      facts: { commit: 'abc123' },
    })).value as { ok: boolean; kind: string }
    expect(ready.ok).toBe(true)
    expect(ready.kind).toBe('ready')
    const stored = setup.harness.store.tickets.get(ticket.id)!
    expect(stored.latestReport?.kind).toBe('ready')
    expect(stored.latestReport?.pullRequest?.number).toBe(12)
    expect(stored.latestReport?.pullRequest?.repo).toBe('owner/repo')
    expect(stored.latestReport?.facts?.commit).toBe('abc123')
  })

  it('delivers a blocked report with exactly one question to the user channel', async () => {
    const { setup, worker, ticket } = await makeWorkerTools()
    await setup.host.executeTool(worker!, 'superagent_report', {
      kind: 'blocked',
      summary: 'need permission',
      question: 'May I delete the old branch?',
    })
    const message = setup.harness.outbox.messages.find(entry => entry.purpose === 'attention')
    expect(message?.text).toContain('May I delete the old branch?')
    expect(setup.harness.store.tickets.get(ticket.id)!.waitingForPerson).toBe(true)
  })

  it('acknowledges undelivered input and forwards contextual signals', async () => {
    const { setup, worker, ticket, assignment } = await makeWorkerTools()
    const withInput = setup.harness.store.tickets.get(ticket.id)!
    withInput.inputs.push({ id: 'in_x', kind: 'text', at: new Date().toISOString(), text: 'use main', person: true })
    setup.harness.store.tickets.save(withInput)

    const ack = (await setup.host.executeTool(worker!, 'superagent_ack', {})).value as { ok: boolean; acknowledged: number }
    expect(ack.ok).toBe(true)
    expect(ack.acknowledged).toBeGreaterThanOrEqual(1)
    expect(setup.harness.store.tickets.get(ticket.id)!.inputs.find(input => input.id === 'in_x')!.readAt).toBeTruthy()

    const handback = (await setup.host.executeTool(worker!, 'superagent_handback', {
      triggerId: 'tr_other',
      reason: 'different work',
    })).value as { ok: boolean }
    expect(handback.ok).toBe(true)

    const follow = (await setup.host.executeTool(worker!, 'superagent_follow_context', {
      thread: 'github:owner/repo#3',
      source: 'github',
    })).value as { ok: boolean }
    expect(follow.ok).toBe(true)
    expect(setup.harness.store.tickets.get(ticket.id)!.subscriptions.some(thread => thread.key === 'github:owner/repo#3')).toBe(true)

    const unrelated = (await setup.host.executeTool(worker!, 'superagent_mark_unrelated', {
      thread: 'github:owner/repo#3',
      reason: 'not related',
    })).value as { ok: boolean }
    expect(unrelated.ok).toBe(true)

    const status = (await setup.host.executeTool(worker!, 'superagent_report', {
      kind: 'waiting',
      summary: 'waiting for CI',
    })).value as { ok: boolean }
    expect(status.ok).toBe(true)
    expect(assignment.id).toBeTruthy()
  })

  it('refuses worker tools outside a worker session', async () => {
    const setup = await makeTools()
    // Router session has no worker tools registered; register them to prove the guard.
    registerWorkerTools(setup.router.ctx as unknown as Context, setup.deps)
    const result = (await setup.host.executeTool(setup.router, 'superagent_report', { kind: 'progress', summary: 'x' })).value as {
      ok: boolean
      error: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_worker_session')
    expect(textOf({ content: [{ type: 'text', text: 'x' }] })).toBe('x')
  })
})
