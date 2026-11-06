import { describe, expect, it } from 'vitest'

import {
  makeGithubTrigger,
  makeHarness,
  makePolicy,
  makeTrigger,
  effectPayload,
} from './core-fixtures.js'
import type { Assignment, Ticket } from '../src/core/model.js'
import type { AssessmentPayload, LaunchPayload } from '../src/core/engine.js'

function acceptFirst(harness: ReturnType<typeof makeHarness>, triggerId: string, overrides: { title?: string; rules?: string[] } = {}): Ticket {
  harness.engine.sources.receive(makeTrigger({ id: triggerId }))
  harness.engine.evaluateDue()
  const candidate = harness.engine.mainSession.candidate(triggerId)
  expect(candidate).toBeDefined()
  const result = harness.engine.mainSession.decide({
    triggerId,
    outcome: 'accept',
    reason: [{ code: 'asked', triggerId }],
    ...overrides,
  })
  expect(result.ticket).toBeDefined()
  return result.ticket!
}

describe('receive', () => {
  it('stores a Trigger once and reports the duplicate', () => {
    const harness = makeHarness()
    const trigger = makeTrigger({ id: 'tr_1' })
    expect(harness.engine.sources.receive(trigger)).toBe('stored')
    expect(harness.store.triggers.get('tr_1')).toEqual(trigger)
    expect(harness.store.dispositions.get('tr_1')?.outcome).toBe('queued')
    expect(harness.engine.sources.receive(trigger)).toBe('duplicate')
    expect(harness.store.threads.get('chat-1')?.queued).toEqual(['tr_1'])
  })

  it('filters a Trigger whose Source is not part of the Policy', () => {
    const harness = makeHarness()
    const trigger = makeTrigger({ id: 'tr_1', source: 'slack' })
    expect(harness.engine.sources.receive(trigger)).toBe('filtered')
    expect(harness.store.dispositions.get('tr_1')?.filteredReason).toBe('source_not_configured')
    expect(harness.store.threads.get('chat-1')).toBeUndefined()
  })

  it('records correlation Threads without routing through them', () => {
    const harness = makeHarness()
    const trigger = makeTrigger({
      id: 'tr_1',
      correlations: [{ key: 'chat-2', source: 'telegram' }],
    })
    harness.engine.sources.receive(trigger)
    expect(harness.store.threads.get('chat-2')).toBeDefined()
    expect(harness.store.threads.get('chat-2')?.queued).toEqual([])
    expect(harness.store.threads.get('chat-1')?.queued).toEqual(['tr_1'])
  })
})

describe('fan-out', () => {
  it('delivers a person message on a live Ticket Thread to the Ticket and skips Eval', () => {
    const harness = makeHarness()
    const ticket = acceptFirst(harness, 'tr_1')
    harness.effects.clear()

    const followUp = makeTrigger({ id: 'tr_2', text: 'also please update the docs' })
    expect(harness.engine.sources.receive(followUp)).toBe('stored')
    harness.engine.evaluateDue()

    const stored = harness.store.tickets.get(ticket.id)!
    expect(stored.inputs.some(input => input.triggerId === 'tr_2')).toBe(true)
    expect(harness.store.dispositions.get('tr_2')?.tickets).toContain(ticket.id)
    expect(harness.effects.list('assessment')).toEqual([])
    // The pending first Assignment gets the new Input (launch is coalesced, not doubled).
    expect(harness.effects.list('launch')).toHaveLength(1)
    expect(harness.store.threads.get('chat-1')?.queued).toEqual([])
  })

  it('queues a bot Trigger for Eval while still delivering it to subscribed Tickets', () => {
    const policy = makePolicy()
    policy.sources.telegram = { allowed: [{ id: 'u1' }], bots: [{ id: 'ci-bot' }] }
    const harness = makeHarness({ policy })
    const ticket = acceptFirst(harness, 'tr_1')
    harness.effects.clear()

    const botTrigger = makeTrigger({ id: 'tr_2', actorId: 'ci-bot', bot: true, kind: 'ci', text: 'CI failed' })
    expect(harness.engine.sources.receive(botTrigger)).toBe('stored')
    harness.engine.evaluateDue()

    expect(harness.store.tickets.get(ticket.id)?.inputs.some(input => input.triggerId === 'tr_2')).toBe(true)
    expect(harness.store.dispositions.get('tr_2')?.tickets).toContain(ticket.id)
    const assessment = effectPayload<AssessmentPayload>(harness, 'assessment')
    expect(assessment?.triggerId).toBe('tr_2')
  })

  it('does not deliver bot or CI Triggers to an ended Ticket', () => {
    const policy = makePolicy()
    policy.sources.telegram = { allowed: [{ id: 'u1' }], bots: [{ id: 'ci-bot' }] }
    const harness = makeHarness({ policy })
    const ticket = acceptFirst(harness, 'tr_1')
    const assignment = harness.store.tickets.get(ticket.id)!.assignments[0]!
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'dropped', summary: 'nothing to do', at: harness.clock.now() },
    })
    expect(harness.store.tickets.get(ticket.id)?.ends).toBeDefined()

    harness.engine.sources.receive(makeTrigger({ id: 'tr_2', actorId: 'ci-bot', bot: true, kind: 'ci' }))
    const stored = harness.store.tickets.get(ticket.id)!
    expect(stored.inputs.some(input => input.triggerId === 'tr_2')).toBe(false)
  })

  it('resumes an ended Ticket under the same Mandate after a person writes there', () => {
    const harness = makeHarness()
    const ticket = acceptFirst(harness, 'tr_1')
    const first = harness.store.tickets.get(ticket.id)!.assignments[0]!
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: first.id,
      report: { kind: 'dropped', summary: 'done', at: harness.clock.now() },
    })
    expect(harness.store.tickets.get(ticket.id)?.ends).toBeDefined()
    harness.effects.clear()

    harness.engine.sources.receive(makeTrigger({ id: 'tr_2', text: 'actually, one more thing' }))
    harness.engine.evaluateDue()

    const resumed = harness.store.tickets.get(ticket.id)!
    expect(resumed.ends).toBeUndefined()
    expect(resumed.state).toBe('open')
    expect(resumed.mandate).toEqual(ticket.mandate)
    expect(resumed.assignments).toHaveLength(2)
    expect(resumed.assignments[1]?.state).toBe('pending')
    expect(harness.effects.list('assessment')).toEqual([])
    const launch = effectPayload<LaunchPayload>(harness, 'launch')
    expect(launch?.assignmentId).toBe(resumed.assignments[1]?.id)
  })

  it('refuses to resume a Ticket whose Mandate no longer holds', () => {
    const harness = makeHarness()
    const ticket = acceptFirst(harness, 'tr_1')
    const first = harness.store.tickets.get(ticket.id)!.assignments[0]!
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: first.id,
      report: { kind: 'dropped', summary: 'done', at: harness.clock.now() },
    })
    const updated = makePolicy()
    updated.sources.telegram = { allowed: [{ id: 'u2' }], bots: [] }
    harness.policy.set(updated)
    harness.effects.clear()

    harness.engine.sources.receive(makeTrigger({ id: 'tr_2', text: 'one more thing' }))
    harness.engine.evaluateDue()

    expect(harness.store.tickets.get(ticket.id)?.ends).toBeDefined()
    // The message becomes an independent candidate instead; the old Mandate cannot resume.
    const thread = harness.store.threads.get('chat-1')!
    expect(thread.eval).toBeUndefined()
    const lastDecision = harness.store.decisions.get(thread.decisions[thread.decisions.length - 1]!)!
    expect(lastDecision.outcome).toBe('ignore')
    expect(lastDecision.reason.map(reason => reason.code)).toContain('not_allowed')
    expect(harness.effects.list('assessment')).toEqual([])
  })

  it('delivers a person message on a context-only Thread without giving follow-up authority', () => {
    const harness = makeHarness()
    const ticket = acceptFirst(harness, 'tr_1')
    harness.engine.executor.followForContext(ticket.id, { key: 'chat-2', source: 'telegram' })
    harness.effects.clear()

    harness.engine.sources.receive(makeTrigger({ id: 'tr_2', threadKey: 'chat-2', text: 'context here' }))
    harness.engine.evaluateDue()

    expect(harness.store.tickets.get(ticket.id)?.inputs.some(input => input.triggerId === 'tr_2')).toBe(true)
    expect(harness.store.threads.get('chat-2')?.eval?.triggerIds).toEqual(['tr_2'])
    expect(effectPayload(harness, 'assessment')).toBeDefined()
  })

  it('does not demote an existing subscription to context-only', () => {
    const harness = makeHarness()
    const ticket = acceptFirst(harness, 'tr_1')
    harness.engine.executor.followForContext(ticket.id, { key: 'chat-1', source: 'telegram' })
    harness.effects.clear()

    harness.engine.sources.receive(makeTrigger({ id: 'tr_2', text: 'follow up' }))
    harness.engine.evaluateDue()
    expect(harness.store.tickets.get(ticket.id)?.inputs.some(input => input.triggerId === 'tr_2')).toBe(true)
    expect(harness.effects.list('assessment')).toEqual([])
  })

  it('binds a Thread so its Triggers reach the Ticket', () => {
    const harness = makeHarness()
    const ticket = acceptFirst(harness, 'tr_1')
    harness.engine.sources.bindThread(ticket.id, { key: 'owner/repo#7', source: 'github', label: 'PR #7' }, true)
    harness.effects.clear()

    harness.engine.sources.receive(makeGithubTrigger({ id: 'tr_2', threadKey: 'owner/repo#7', actorId: 'ci-bot', bot: true }))
    const stored = harness.store.tickets.get(ticket.id)!
    expect(stored.subscriptions.some(thread => thread.key === 'owner/repo#7')).toBe(true)
    expect(stored.inputs.some(input => input.triggerId === 'tr_2')).toBe(true)
    expect(stored.follows.find(follow => follow.key === 'owner/repo#7')?.own).toBe(true)
  })
})

describe('stop', () => {
  it('drops the Subscriptions of a stopped Ticket and lets later messages be assessed independently', () => {
    const harness = makeHarness()
    const ticket = acceptFirst(harness, 'tr_1')
    harness.engine.people.stopTicket(ticket.id, 'user said stop')
    const stopped = harness.store.tickets.get(ticket.id)!
    expect(stopped.ends?.by).toBe('person')
    expect(stopped.subscriptions).toEqual([])
    expect(harness.store.threads.get('chat-1')?.subscriptions).toEqual([])

    harness.effects.clear()
    harness.engine.sources.receive(makeTrigger({ id: 'tr_2', text: 'new request' }))
    harness.engine.evaluateDue()
    const after = harness.store.tickets.get(ticket.id)!
    expect(after.inputs.some(input => input.triggerId === 'tr_2')).toBe(false)
    expect(harness.store.threads.get('chat-1')?.eval?.triggerIds).toEqual(['tr_2'])
    expect(effectPayload(harness, 'assessment')).toBeDefined()
  })

  it('interrupts the running Assignment of a stopped Ticket', () => {
    const harness = makeHarness()
    const ticket = acceptFirst(harness, 'tr_1')
    const assignment = harness.store.tickets.get(ticket.id)!.assignments[0]!
    harness.engine.executor.assignmentStarted({ ticketId: ticket.id, assignmentId: assignment.id, sessionId: 'worker-1' })

    harness.engine.people.stopTicket(ticket.id)
    expect(harness.executor.interrupts).toHaveLength(1)
    expect(harness.executor.interrupts[0]?.assignmentId).toBe(assignment.id)
    const ended = harness.store.tickets.get(ticket.id)!
    expect(ended.assignments.every((candidate: Assignment) => candidate.state === 'ended')).toBe(true)
  })
})
