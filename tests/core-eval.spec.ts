import { describe, expect, it } from 'vitest'

import {
  effectPayload,
  makeHarness,
  makePolicy,
  makeTrigger,
} from './core-fixtures.js'
import type { AssessmentPayload, LaunchPayload } from '../src/core/engine.js'
import type { Policy } from '../src/core/model.js'

function accept(
  harness: ReturnType<typeof makeHarness>,
  triggerId: string,
  overrides: { rules?: string[]; title?: string; note?: string } = {},
) {
  const result = harness.engine.mainSession.decide({
    triggerId,
    outcome: 'accept',
    reason: [{ code: 'asked', triggerId }],
    ...overrides,
  })
  return result
}

function latestDecision(harness: ReturnType<typeof makeHarness>, threadKey: string) {
  const thread = harness.store.threads.get(threadKey)!
  const id = thread.decisions[thread.decisions.length - 1]!
  return harness.store.decisions.get(id)!
}

describe('Eval batching', () => {
  it('batches the Triggers queued on a Thread into one Eval', () => {
    const harness = makeHarness()
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1', text: 'first' }))
    harness.engine.sources.receive(makeTrigger({ id: 'tr_2', text: 'second' }))
    harness.engine.sources.receive(makeTrigger({ id: 'tr_3', text: 'third' }))
    harness.engine.evaluateDue()

    const thread = harness.store.threads.get('chat-1')!
    expect(thread.queued).toEqual([])
    expect(thread.eval?.triggerIds).toEqual(['tr_1', 'tr_2', 'tr_3'])
    expect(harness.effects.list('assessment')).toHaveLength(1)
    const candidate = harness.engine.mainSession.candidate('tr_2')!
    expect(candidate.triggers.map(trigger => trigger.id)).toEqual(['tr_1', 'tr_2', 'tr_3'])
    expect(candidate.primaryTrigger.id).toBe('tr_3')
    expect(candidate.policyVersion).toBe('policy-1')
  })

  it('delivers a candidate and starts the deadline only when it reached the Session', () => {
    const harness = makeHarness({ evalTimeoutMs: 60_000 })
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1' }))
    harness.engine.evaluateDue()
    const evalRun = harness.store.threads.get('chat-1')!.eval!
    expect(evalRun.deliveredAt).toBeUndefined()
    expect(evalRun.deadlineAt).toBeUndefined()

    harness.engine.mainSession.candidateDelivered(evalRun.id)
    const delivered = harness.store.threads.get('chat-1')!.eval!
    expect(delivered.deliveredAt).toBe(harness.clock.now())
    expect(delivered.deadlineAt).toBe(new Date(Date.parse(harness.clock.now()) + 60_000).toISOString())
  })

  it('requeues an expired Eval twice, then records it unavailable', () => {
    const harness = makeHarness({ evalTimeoutMs: 60_000 })
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1' }))

    for (let expiry = 1; expiry <= 2; expiry += 1) {
      harness.engine.evaluateDue()
      const evalRun = harness.store.threads.get('chat-1')!.eval!
      harness.engine.mainSession.candidateDelivered(evalRun.id)
      harness.clock.advance(60_001)
      harness.engine.evaluateDue()
      const thread = harness.store.threads.get('chat-1')!
      // The expired batch is queued again and started in the same pass.
      expect(thread.expired).toBe(expiry)
      expect(thread.eval).toBeDefined()
      expect(thread.eval!.triggerIds).toEqual(['tr_1'])
    }

    const evalRun = harness.store.threads.get('chat-1')!.eval!
    harness.engine.mainSession.candidateDelivered(evalRun.id)
    harness.clock.advance(60_001)
    harness.engine.evaluateDue()

    const thread = harness.store.threads.get('chat-1')!
    expect(thread.eval).toBeUndefined()
    expect(thread.queued).toEqual([])
    const decision = latestDecision(harness, 'chat-1')
    expect(decision.outcome).toBe('unavailable')
    expect(decision.reason[0]?.code).toBe('timeout')
    expect(thread.decisions).toHaveLength(1)
  })

  it('does not expire an Eval whose candidate never reached the Session', () => {
    const harness = makeHarness({ evalTimeoutMs: 1_000 })
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1' }))
    harness.engine.evaluateDue()
    harness.clock.advance(120_000)
    harness.engine.evaluateDue()
    expect(harness.store.threads.get('chat-1')!.eval).toBeDefined()
  })
})

describe('gate', () => {
  it('ignores a stranger addressed to the agent without waking the assessor', () => {
    const policy = makePolicy()
    policy.sources.telegram = { allowed: [{ id: 'u2' }], bots: [] }
    const harness = makeHarness({ policy })
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1', actorId: 'stranger' }))
    harness.engine.evaluateDue()

    expect(harness.effects.list('assessment')).toEqual([])
    const decision = latestDecision(harness, 'chat-1')
    expect(decision.outcome).toBe('ignore')
    expect(decision.reason.map(reason => reason.code)).toContain('not_allowed')
  })

  it('does not admit an unaddressed message from an allowed person on a fresh Thread', () => {
    const harness = makeHarness()
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1', addressed: 'none' }))
    harness.engine.evaluateDue()
    expect(harness.effects.list('assessment')).toEqual([])
    expect(latestDecision(harness, 'chat-1').reason.map(reason => reason.code)).toContain('not_addressed')
  })

  it('ignores an inferred candidate in off mode', () => {
    const policy = makePolicy({ mode: 'off' })
    policy.sources.telegram = { allowed: [{ id: 'u1' }], bots: [{ id: 'ci-bot' }] }
    const harness = makeHarness({ policy })
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1', actorId: 'ci-bot', bot: true }))
    harness.engine.evaluateDue()

    expect(harness.effects.list('assessment')).toEqual([])
    expect(latestDecision(harness, 'chat-1').reason.map(reason => reason.code)).toContain('accept_mode_off')
  })

  it('records a would-accept in observe mode without creating a Ticket', () => {
    const policy = makePolicy({ mode: 'observe' })
    policy.sources.telegram = { allowed: [{ id: 'u1' }], bots: [{ id: 'ci-bot' }] }
    const harness = makeHarness({ policy })
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1', actorId: 'ci-bot', bot: true }))
    harness.engine.evaluateDue()
    expect(harness.effects.list('assessment')).toHaveLength(1)

    const result = accept(harness, 'tr_1')
    expect(result.ticket).toBeUndefined()
    expect(result.decision.outcome).toBe('ignore')
    expect(result.decision.reason.map(reason => reason.code)).toContain('would_accept')
  })

  it('refuses an inferred accept in auto mode without a matching rule', () => {
    const policy = makePolicy({ mode: 'auto', rules: [{ id: 'r1', name: 'R', enabled: true, instructions: 'do it' }] })
    policy.sources.telegram = { allowed: [{ id: 'u1' }], bots: [{ id: 'ci-bot' }] }
    const harness = makeHarness({ policy })
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1', actorId: 'ci-bot', bot: true }))
    harness.engine.evaluateDue()
    const result = accept(harness, 'tr_1')
    expect(result.ticket).toBeUndefined()
    expect(result.decision.reason.map(reason => reason.code)).toContain('no_matching_rule')
  })

  it('accepts an inferred candidate in auto mode with a matched rule and records the Mandate', () => {
    const policy = makePolicy({ mode: 'auto', rules: [{ id: 'r1', name: 'R', enabled: true, instructions: 'do it' }] })
    policy.sources.telegram = { allowed: [{ id: 'u1' }], bots: [{ id: 'ci-bot' }] }
    const harness = makeHarness({ policy })
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1', actorId: 'ci-bot', bot: true, text: 'fix the build' }))
    harness.engine.evaluateDue()

    const result = accept(harness, 'tr_1', { rules: ['r1'] })
    expect(result.ticket).toBeDefined()
    expect(result.ticket?.mandate.strength).toBe('inferred')
    expect(result.ticket?.mandate.via).toBe('bot')
    expect(result.ticket?.mandate.rules).toEqual(['r1'])
    expect(result.decision.policyVersion).toBe('policy-1')
  })
})

describe('accept', () => {
  it('creates the Ticket, Mandate, first Assignment, Subscriptions and launch atomically', () => {
    const harness = makeHarness({ acknowledgeOnAccept: true })
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1', text: 'add a health endpoint' }))
    harness.engine.evaluateDue()
    harness.effects.clear()
    harness.outbox.messages = []

    const { ticket, decision } = accept(harness, 'tr_1', { title: 'Add health endpoint' })
    expect(ticket).toBeDefined()
    expect(decision.outcome).toBe('accept')
    expect(decision.ticketId).toBe(ticket!.id)
    const stored = harness.store.tickets.get(ticket!.id)!
    expect(stored.title).toBe('Add health endpoint')
    expect(stored.mandate.strength).toBe('explicit')
    expect(stored.mandate.via).toBe('addressed')
    expect(stored.mandate.sender.id).toBe('u1')
    expect(stored.assignments).toHaveLength(1)
    expect(stored.assignments[0]?.state).toBe('pending')
    expect(stored.subscriptions).toEqual([{ key: 'chat-1', source: 'telegram', label: 'thread chat-1' }])
    expect(harness.store.threads.get('chat-1')?.subscriptions).toEqual([ticket!.id])
    const launch = effectPayload<LaunchPayload>(harness, 'launch')
    expect(launch).toEqual({ ticketId: ticket!.id, assignmentId: stored.assignments[0]!.id })
    expect(harness.effects.list('assessment')).toEqual([])
    expect(harness.outbox.messages).toHaveLength(1)
    expect(harness.outbox.messages[0]?.purpose).toBe('acknowledgement')
    expect(harness.outbox.messages[0]?.ticketId).toBe(ticket!.id)
    expect(harness.engine.mainSession.candidate('tr_1')).toBeUndefined()
  })

  it('puts every Trigger of the batch and the note on the new Ticket', () => {
    const harness = makeHarness()
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1', text: 'one' }))
    harness.engine.sources.receive(makeTrigger({ id: 'tr_2', text: 'two' }))
    harness.engine.evaluateDue()
    const { ticket } = accept(harness, 'tr_1', { note: 'the repo is owner/repo' })
    const stored = harness.store.tickets.get(ticket!.id)!
    expect(stored.origin.triggerIds).toEqual(['tr_1', 'tr_2'])
    expect(stored.inputs.filter(input => input.kind === 'trigger').map(input => input.triggerId)).toEqual(['tr_1', 'tr_2'])
    expect(stored.inputs.find(input => input.kind === 'text')?.text).toBe('the repo is owner/repo')
  })
})

describe('attach', () => {
  it('routes a Trigger to a Ticket, ends its Eval and requeues the rest', () => {
    const harness = makeHarness()
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1' }))
    harness.engine.evaluateDue()
    const { ticket } = accept(harness, 'tr_1')

    harness.engine.sources.receive(makeTrigger({ id: 'tr_2', threadKey: 'chat-2', text: 'context' }))
    harness.engine.sources.receive(makeTrigger({ id: 'tr_3', threadKey: 'chat-2', text: 'other' }))
    harness.engine.evaluateDue()
    expect(harness.store.threads.get('chat-2')?.eval?.triggerIds).toEqual(['tr_2', 'tr_3'])

    harness.engine.mainSession.attach({ ticketId: ticket!.id, triggerId: 'tr_2', note: 'attach this' })
    const stored = harness.store.tickets.get(ticket!.id)!
    expect(stored.inputs.some(input => input.triggerId === 'tr_2')).toBe(true)
    const thread = harness.store.threads.get('chat-2')!
    expect(thread.eval).toBeUndefined()
    expect(thread.queued).toEqual(['tr_3'])
    const decision = latestDecision(harness, 'chat-2')
    expect(decision.outcome).toBe('accept')
    expect(decision.ticketId).toBe(ticket!.id)
    expect(decision.reason.map(reason => reason.code)).toContain('attached')
  })
})

describe('pause', () => {
  it('stops new Evals and expiry, then shifts deadlines by the pause length', () => {
    const harness = makeHarness({ evalTimeoutMs: 60_000 })
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1' }))
    harness.engine.evaluateDue()
    const evalRun = harness.store.threads.get('chat-1')!.eval!
    harness.engine.mainSession.candidateDelivered(evalRun.id)
    const originalDeadline = harness.store.threads.get('chat-1')!.eval!.deadlineAt!

    harness.clock.advance(30_000)
    harness.engine.people.pause(true)

    harness.clock.advance(300_000)
    harness.engine.sources.receive(makeTrigger({ id: 'tr_2', text: 'during pause' }))
    harness.engine.evaluateDue()
    expect(harness.store.threads.get('chat-1')!.eval!.deadlineAt).toBe(originalDeadline)
    expect(harness.store.threads.get('chat-1')!.queued).toEqual(['tr_2'])

    harness.engine.people.pause(false)
    const thread = harness.store.threads.get('chat-1')!
    // One Eval per Thread: the Trigger queued during the pause waits for the next batch.
    expect(thread.queued).toEqual(['tr_2'])
    expect(thread.eval!.triggerIds).toEqual(['tr_1'])
    expect(thread.eval!.deadlineAt).toBe(new Date(Date.parse(originalDeadline) + 300_000).toISOString())
  })

  it('resumes an ended Ticket only on the first pass after the pause', () => {
    const harness = makeHarness()
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1' }))
    harness.engine.evaluateDue()
    const { ticket } = accept(harness, 'tr_1')
    const assignment = harness.store.tickets.get(ticket!.id)!.assignments[0]!
    harness.engine.executor.report({
      ticketId: ticket!.id,
      assignmentId: assignment.id,
      report: { kind: 'dropped', summary: 'done', at: harness.clock.now() },
    })
    expect(harness.store.tickets.get(ticket!.id)?.ends).toBeDefined()

    harness.engine.people.pause(true)
    harness.engine.sources.receive(makeTrigger({ id: 'tr_2', text: 'after pause' }))
    expect(harness.store.tickets.get(ticket!.id)?.ends).toBeDefined()
    harness.engine.people.pause(false)
    const resumed = harness.store.tickets.get(ticket!.id)!
    expect(resumed.ends).toBeUndefined()
    expect(resumed.assignments).toHaveLength(2)
  })
})

describe('policyChanged', () => {
  it('notifies only the live Tickets the change bears on', () => {
    const rules = [{ id: 'r1', name: 'Rule', enabled: true, instructions: 'do proactive work' }]
    const base: Policy = makePolicy({ mode: 'auto', rules })
    base.sources.telegram = { allowed: [{ id: 'u1' }], bots: [{ id: 'ci-bot' }] }
    const harness = makeHarness({ policy: base })

    // Explicit Ticket, no matched rule.
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1' }))
    harness.engine.evaluateDue()
    const explicit = accept(harness, 'tr_1').ticket!

    // Inferred Ticket accepted under r1.
    harness.engine.sources.receive(makeTrigger({ id: 'tr_2', actorId: 'ci-bot', bot: true }))
    harness.engine.evaluateDue()
    const inferred = accept(harness, 'tr_2', { rules: ['r1'] }).ticket!

    const changed: Policy = {
      ...base,
      version: 'policy-2',
      rules: [{ ...rules[0]!, enabled: false }],
    }
    harness.policy.set(changed)
    harness.engine.settings.policyChanged(base, changed)

    const inferredInputs = harness.store.tickets.get(inferred.id)!.inputs.filter(input => input.kind === 'policy')
    const explicitInputs = harness.store.tickets.get(explicit.id)!.inputs.filter(input => input.kind === 'policy')
    expect(inferredInputs).toHaveLength(1)
    expect(inferredInputs[0]?.text).toContain('rule_changed')
    expect(explicitInputs).toHaveLength(0)
  })
})

describe('reevaluate and dismiss', () => {
  it('queues a stored Trigger for a fresh Eval and records the requeue', () => {
    const harness = makeHarness()
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1' }))
    harness.engine.evaluateDue()
    accept(harness, 'tr_1')
    harness.effects.clear()

    harness.engine.people.reevaluate('tr_1')
    expect(harness.store.threads.get('chat-1')?.queued).toEqual(['tr_1'])
    expect(harness.store.dispositions.get('tr_1')?.requeuedAt).toBeDefined()
    harness.engine.evaluateDue()
    expect(harness.effects.list('assessment')).toHaveLength(1)
  })

  it('dismisses an unavailable Decision', () => {
    const harness = makeHarness({ evalTimeoutMs: 1 })
    harness.engine.sources.receive(makeTrigger({ id: 'tr_1' }))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      harness.engine.evaluateDue()
      const evalRun = harness.store.threads.get('chat-1')!.eval
      if (evalRun !== undefined) harness.engine.mainSession.candidateDelivered(evalRun.id)
      harness.clock.advance(10)
    }
    harness.engine.evaluateDue()
    const decision = latestDecision(harness, 'chat-1')
    expect(decision.outcome).toBe('unavailable')
    harness.engine.people.dismiss(decision.id)
    expect(harness.store.decisions.get(decision.id)?.dismissedAt).toBeDefined()
  })
})
