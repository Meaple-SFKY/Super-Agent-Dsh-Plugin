/**
 * Prompt tests: the markdown sources and the embedded fallback must stay in
 * sync, and the deterministic renderers must expose every id the model needs.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  loadPrompt,
  renderAssignmentMessage,
  renderCandidateMessage,
  renderDeliveryMessage,
  renderStatusRequest,
  renderStopMessage,
  renderThreadWindow,
  renderTicketCard,
  reportSummary,
  routerSystemPrompt,
  workerSystemPrompt,
} from '../src/prompts/index.js'
import { ADMISSION, ROUTER, WORKER } from '../src/prompts/builtin.js'
import type { Candidate, Policy, Ticket } from '../src/core/model.js'
import { makeAssignment, makeChannel, makePolicy, makeReport, makeTrigger } from './core-fixtures.js'

const ROOT = new URL('../src/prompts/', import.meta.url)

describe('prompt files', () => {
  it('keeps the embedded copy identical to the markdown sources', () => {
    const pairs: Array<[string, string]> = [
      ['router.md', ROUTER],
      ['admission.md', ADMISSION],
      ['worker.md', WORKER],
    ]
    for (const [file, embedded] of pairs) {
      const markdown = readFileSync(new URL(file, ROOT), 'utf8')
      expect(markdown).toBe(embedded)
    }
  })

  it('loads prompts through the assembler (markdown or embedded fallback)', () => {
    expect(loadPrompt('router')).toContain('SuperAgent Router')
    expect(loadPrompt('admission')).toContain('Admission rules')
    expect(loadPrompt('worker')).toContain('SuperAgent Worker')
    expect(routerSystemPrompt()).toContain('SuperAgent Router')
    expect(routerSystemPrompt()).toContain('Admission rules')
    expect(workerSystemPrompt()).toContain('never try to talk to the user directly')
  })

  it('states the hard governance rules the runtime relies on', () => {
    const router = loadPrompt('router')
    expect(router).toContain('You never do concrete work yourself')
    expect(router).toContain('exactly one question')
    expect(router).toContain('superagent_route')
    const worker = loadPrompt('worker')
    expect(worker).toContain('superagent_report')
    expect(worker).toContain('agent/')
    expect(worker).toContain('blocked')
  })
})

function makeCandidate(): Candidate {
  const trigger = makeTrigger({ id: 'tr_9', text: 'please fix the failing test', actorId: 'u1' })
  const earlier = makeTrigger({ id: 'tr_8', text: 'earlier context', actorId: 'u1' })
  const policy: Policy = makePolicy({ version: 'p9', mode: 'auto' })
  const thread = {
    thread: {
      key: trigger.thread.key,
      source: 'telegram',
      label: 'chat',
      meta: {},
      subscriptions: [],
      context: [],
      queued: [],
      expired: 0,
      decisions: [],
    },
    triggers: [earlier, trigger],
    tickets: [],
  }
  return {
    eval: { id: 'ev_1', triggerIds: [trigger.id], startedAt: '2026-01-01T00:00:00.000Z', expiries: 0 },
    primaryTrigger: trigger,
    triggers: [earlier, trigger],
    thread,
    relatedTickets: [],
    ticketsTotal: 0,
    policyVersion: policy.version,
  }
}

function makeTicket(): Ticket {
  const trigger = makeTrigger({ id: 'tr_1', text: 'fix it' })
  return {
    id: 't_1',
    title: 'Fix the failing test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    state: 'open',
    origin: { triggerId: trigger.id, triggerIds: [trigger.id] },
    mandate: {
      policyVersion: 'p9',
      strength: 'explicit',
      rules: ['r1'],
      source: 'telegram',
      scope: 'telegram:dm',
      sender: { id: 'u1', name: 'You' },
      via: 'addressed',
      at: '2026-01-01T00:00:00.000Z',
    },
    follows: [],
    subscriptions: [],
    channels: [makeChannel()],
    inputs: [],
    assignments: [makeAssignment('t_1', { state: 'running', startedAt: '2026-01-01T00:00:02.000Z' })],
    latestReport: makeReport({ kind: 'progress', summary: 'working' }),
  }
}

describe('prompt renderers', () => {
  it('renders a compact candidate block with every routing id', () => {
    const policy = makePolicy({ version: 'p9', mode: 'auto' })
    const text = renderCandidateMessage(makeCandidate(), policy, ['superagent_route', 'superagent_read_thread'])
    expect(text).toContain('[superagent candidate]')
    expect(text).toContain('ev_1')
    expect(text).toContain('tr_9')
    expect(text).toContain('tr_8')
    expect(text).toContain('mode=auto')
    expect(text).toContain('superagent_route')
    expect(text).toContain('please fix the failing test')
  })

  it('renders an assignment card with directory, branch, acceptance and recovery note', () => {
    const ticket = makeTicket()
    const text = renderAssignmentMessage({
      ticket,
      assignment: ticket.assignments[0]!,
      directory: '/tmp/work/t_1',
      triggers: [makeTrigger({ id: 'tr_1' })],
      recovery: true,
      branch: 'agent/t_1',
    })
    expect(text).toContain('[superagent assignment]')
    expect(text).toContain('t_1')
    expect(text).toContain('/tmp/work/t_1')
    expect(text).toContain('agent/t_1')
    expect(text).toContain('acceptance criteria')
    expect(text).toContain('[recovery]')
    expect(text).toContain('superagent_report')
  })

  it('renders delivery, status and stop messages', () => {
    const ticket = makeTicket()
    const assignment = ticket.assignments[0]!
    const delivery = renderDeliveryMessage(ticket, [
      { id: 'in_1', kind: 'text', at: '2026-01-01T00:00:03.000Z', text: 'use the staging branch', person: true },
    ])
    expect(delivery).toContain('[superagent input]')
    expect(delivery).toContain('in_1')
    expect(delivery).toContain('use the staging branch')

    const status = renderStatusRequest(ticket, assignment, 'no report')
    expect(status).toContain('[superagent status request]')
    expect(status).toContain('superagent_report')

    const stop = renderStopMessage(ticket, 'user stopped it')
    expect(stop).toContain('[superagent stop]')
    expect(stop).toContain('user stopped it')
  })

  it('renders ticket cards and thread windows', () => {
    const ticket = makeTicket()
    const card = renderTicketCard(ticket)
    expect(card).toContain('t_1')
    expect(card).toContain('explicit')
    expect(card).toContain('Fix the failing test')

    const snapshot = makeCandidate().thread
    const window = renderThreadWindow(snapshot, 5)
    expect(window).toContain(triggerKeyOf(snapshot.triggers[1]!.thread.key))
    expect(window).toContain('tr_9')
  })

  it('summarizes reports for user-facing messages', () => {
    const blocked = makeReport({ kind: 'blocked', summary: 'stuck', question: 'Proceed?' })
    expect(reportSummary(blocked)).toContain('Proceed?')
    const ready = makeReport({
      kind: 'ready',
      summary: 'done',
      pullRequest: { repo: 'owner/repo', number: 3, url: 'https://github.com/owner/repo/pull/3' },
    })
    expect(reportSummary(ready)).toContain('pull/3')
  })
})

function triggerKeyOf(key: string): string {
  return key
}
