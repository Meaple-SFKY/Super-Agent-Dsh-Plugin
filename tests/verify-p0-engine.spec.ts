/**
 * Independent adversarial verification of the P0 state-machine fixes
 * (task-59, part 1/3).
 *
 * Covers:
 *  1. resume explosion — 20 ended tickets on one Thread + 1 person message ⇒
 *     exactly one resume/launch; explicit `meta.ticketId`; an open owner wins.
 *  2. decide/accept idempotency; retry stacking; reevaluate still decides.
 *
 * These tests use only the public Engine port plus the in-memory store, so they
 * are independent of the implementation's own test harness additions.
 */

import { describe, expect, it } from 'vitest'

import type { Ticket, ThreadState } from '../src/core/model.js'
import { makeHarness, makePolicy, makeTrigger } from './core-fixtures.js'
import type { Harness } from './core-fixtures.js'

const AT = '2026-02-01T00:00:00.000Z'
const THREAD = 'telegram:dm:1'

function endedTicket(id: string, updatedAt: string, threadKey = THREAD): Ticket {
  return {
    id,
    title: `ticket ${id}`,
    createdAt: AT,
    updatedAt,
    state: 'ended',
    origin: { triggerId: `tr_origin_${id}`, triggerIds: [`tr_origin_${id}`] },
    mandate: {
      policyVersion: 'policy-1',
      strength: 'explicit',
      rules: [],
      source: 'telegram',
      scope: 'telegram:dm',
      sender: { id: 'u1', name: 'You' },
      via: 'addressed',
      at: AT,
    },
    ends: { at: updatedAt, by: 'executor', reason: 'ready', outcome: 'completed' },
    follows: [],
    subscriptions: [{ key: threadKey, source: 'telegram' }],
    channels: [{ source: 'telegram', thread: threadKey, to: '1' }],
    inputs: [],
    assignments: [
      {
        id: `as_${id}`,
        ticketId: id,
        state: 'ended',
        createdAt: AT,
        startedAt: AT,
        endedAt: updatedAt,
      },
    ],
  }
}

function openTicket(id: string, threadKey = THREAD): Ticket {
  return {
    id,
    title: `open ${id}`,
    createdAt: AT,
    updatedAt: AT,
    state: 'open',
    origin: { triggerId: `tr_open_${id}`, triggerIds: [`tr_open_${id}`] },
    mandate: {
      policyVersion: 'policy-1',
      strength: 'explicit',
      rules: [],
      source: 'telegram',
      scope: 'telegram:dm',
      sender: { id: 'u1', name: 'You' },
      via: 'addressed',
      at: AT,
    },
    follows: [],
    subscriptions: [{ key: threadKey, source: 'telegram' }],
    channels: [{ source: 'telegram', thread: threadKey, to: '1' }],
    inputs: [],
    assignments: [{ id: `as_${id}`, ticketId: id, state: 'running', createdAt: AT, startedAt: AT }],
  }
}

function threadState(subscriptions: string[], threadKey = THREAD): ThreadState {
  return {
    key: threadKey,
    source: 'telegram',
    meta: {},
    subscriptions: [...subscriptions],
    context: [],
    queued: [],
    expired: 0,
    decisions: [],
    lastTriggerAt: AT,
  }
}

function personTrigger(id: string, meta: Record<string, unknown> = {}, threadKey = THREAD) {
  const trigger = makeTrigger({
    id,
    source: 'telegram',
    threadKey,
    actorId: 'u1',
    addressed: 'direct',
    text: 'follow up please',
    at: '2026-02-01T00:00:10.000Z',
  })
  trigger.meta = meta
  return trigger
}

function seedEndedTickets(harness: Harness, count: number): Ticket[] {
  const tickets: Ticket[] = []
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    // Strictly increasing updatedAt: tk_19 is the most recently updated.
    const at = new Date(Date.parse(AT) + index * 1_000).toISOString()
    const ticket = endedTicket(`tk_${String(index).padStart(2, '0')}`, at)
    harness.store.tickets.save(ticket)
    tickets.push(ticket)
    ids.push(ticket.id)
  }
  harness.store.threads.save(threadState(ids))
  return tickets
}

function launches(harness: Harness) {
  return harness.effects.entries.filter(entry => entry.kind === 'launch')
}

function notices(harness: Harness) {
  return harness.effects.entries.filter(entry => entry.kind === 'notice')
}

describe('resume explosion (P0: 20 ended tickets → 1 resume)', () => {
  it('resumes exactly one ended ticket for one person message', () => {
    const harness = makeHarness()
    seedEndedTickets(harness, 20)

    const disposition = harness.engine.sources.receive(personTrigger('tr_follow_1'))
    expect(disposition).toBe('stored')

    expect(launches(harness)).toHaveLength(1)
    expect(notices(harness)).toHaveLength(1)

    const all = new Map<string, Ticket>()
    for (const ticket of harness.store.tickets.open()) all.set(ticket.id, ticket)
    for (let index = 0; index < 20; index += 1) {
      const id = `tk_${String(index).padStart(2, '0')}`
      all.set(id, harness.store.tickets.get(id)!)
    }
    const resumed = [...all.values()].filter(ticket =>
      ticket.assignments.some(assignment => assignment.state === 'pending'),
    )

    // Exactly one ticket gained a fresh pending assignment: the newest one.
    expect(resumed.map(ticket => ticket.id)).toEqual(['tk_19'])
    // The one resume carries exactly one launch (no per-ended-ticket fan-out).
    expect(resumed[0]!.assignments.filter(assignment => assignment.state === 'pending')).toHaveLength(1)
  })

  it('honours an explicit meta.ticketId even when the Thread no longer lists it', () => {
    const harness = makeHarness()
    // 20 ended tickets subscribed, but the target is deliberately not listed.
    seedEndedTickets(harness, 20)
    const target = endedTicket('tk_explicit', AT) // oldest updatedAt of all
    harness.store.tickets.save(target)
    const state = harness.store.threads.get(THREAD)!
    expect(state.subscriptions).not.toContain('tk_explicit')

    harness.engine.sources.receive(personTrigger('tr_follow_2', { ticketId: 'tk_explicit' }))

    const resumed = harness.store.tickets.get('tk_explicit')!
    expect(resumed.assignments.some(assignment => assignment.state === 'pending')).toBe(true)
    expect(launches(harness)).toHaveLength(1)
  })

  it('lets an open owner take the follow-up and resumes no ended ticket', () => {
    const harness = makeHarness()
    seedEndedTickets(harness, 20)
    harness.store.tickets.save(openTicket('tk_open'))
    harness.store.threads.save(threadState(['tk_open', ...Array.from({ length: 20 }, (_, index) => `tk_${String(index).padStart(2, '0')}`)]))

    const disposition = harness.engine.sources.receive(personTrigger('tr_follow_3'))
    expect(disposition).toBe('stored')

    // The open ticket gets the input; the ended ones stay untouched.
    expect(harness.store.tickets.get('tk_open')!.inputs).toHaveLength(1)
    expect(launches(harness)).toHaveLength(0)
    expect(notices(harness)).toHaveLength(0)
    const pendingEnded = harness.store
      .tickets.active()
      .filter(ticket => ticket.id !== 'tk_open' && ticket.assignments.some(assignment => assignment.state === 'pending'))
    expect(pendingEnded).toHaveLength(0)
    // The follow-up is delivered to the running assignment (delivery effect).
    expect(harness.effects.entries.some(entry => entry.kind === 'delivery')).toBe(true)
  })

  it('honours an explicit meta.ticketId even when an open ticket owns the Thread (documented behavior)', () => {
    const harness = makeHarness()
    seedEndedTickets(harness, 3)
    const target = endedTicket('tk_meta', AT)
    harness.store.tickets.save(target)
    harness.store.threads.save(threadState(['tk_meta', 'tk_open']))
    harness.store.tickets.save(openTicket('tk_open'))

    harness.engine.sources.receive(personTrigger('tr_follow_meta', { ticketId: 'tk_meta' }))

    // Explicit metadata wins over the open-owner shortcut: the named ended
    // ticket is resumed AND the open owner receives the follow-up input. This
    // is only reachable when a Source puts meta.ticketId on a Trigger (no
    // current Source does); it is recorded here so a future Source cannot
    // silently double-deliver.
    expect(harness.store.tickets.get('tk_meta')!.assignments.some(a => a.state === 'pending')).toBe(true)
    expect(harness.store.tickets.get('tk_open')!.inputs).toHaveLength(1)
    expect(launches(harness)).toHaveLength(1)
  })

  it('does not resume a stopped (person-ended) ticket', () => {
    const harness = makeHarness()
    const stopped = endedTicket('tk_stopped', AT)
    stopped.ends = { at: AT, by: 'person', reason: 'stopped', outcome: 'abandoned' }
    harness.store.tickets.save(stopped)
    harness.store.threads.save(threadState(['tk_stopped']))

    harness.engine.sources.receive(personTrigger('tr_follow_4'))
    expect(harness.store.tickets.get('tk_stopped')!.assignments.some(a => a.state === 'pending')).toBe(false)
    expect(launches(harness)).toHaveLength(0)
  })
})

describe('decide/accept idempotency (P0)', () => {
  function acceptTwice(harness: Harness) {
    const trigger = personTrigger('tr_accept_1')
    harvestCandidate(harness, trigger)
    const first = harness.engine.mainSession.decide({
      triggerId: trigger.id,
      outcome: 'accept',
      title: 'Fix it',
      reason: [{ code: 'explicit' }],
    })
    const second = harness.engine.mainSession.decide({
      triggerId: trigger.id,
      outcome: 'accept',
      title: 'Fix it again',
      reason: [{ code: 'explicit' }],
    })
    return { trigger, first, second }
  }

  function harvestCandidate(harness: Harness, trigger: ReturnType<typeof personTrigger>) {
    expect(harness.engine.sources.receive(trigger)).toBe('stored')
    harness.engine.evaluateDue()
    expect(harness.effects.entries.some(entry => entry.kind === 'assessment')).toBe(true)
  }

  it('creates one Ticket/Decision for a repeated accept', () => {
    const harness = makeHarness()
    const { first, second } = acceptTwice(harness)

    expect(first.ticket?.id).toBeDefined()
    expect(second.decision.id).toBe(first.decision.id)
    expect(second.ticket?.id).toBe(first.ticket!.id)
    expect(harness.store.tickets.open()).toHaveLength(1)
    expect(launches(harness)).toHaveLength(1)
    // Both decision records resolve to the same stored decision.
    expect(harness.store.decisions.get(first.decision.id)?.outcome).toBe('accept')
  })

  it('does not stack retries while a pending assignment is already queued', () => {
    const harness = makeHarness()
    const { first } = acceptTwice(harness)
    const ticketId = first.ticket!.id
    const before = harness.store.tickets.get(ticketId)!

    harness.engine.people.retryTicket(ticketId)
    harness.engine.people.retryTicket(ticketId)

    const after = harness.store.tickets.get(ticketId)!
    expect(after.assignments).toHaveLength(before.assignments.length)
    expect(after.assignments.filter(assignment => assignment.state === 'pending')).toHaveLength(1)
    expect(launches(harness)).toHaveLength(1)
  })

  it('still allows a second decision after an explicit reevaluate', () => {
    const harness = makeHarness()
    const { trigger, first } = acceptTwice(harness)
    expect(harness.store.tickets.open()).toHaveLength(1)

    harness.engine.people.reevaluate(trigger.id)
    harness.engine.evaluateDue()
    const second = harness.engine.mainSession.decide({
      triggerId: trigger.id,
      outcome: 'ignore',
      reason: [{ code: 'noise' }],
    })

    expect(second.decision.id).not.toBe(first.decision.id)
    expect(second.decision.outcome).toBe('ignore')
    // The reevaluated ignore does not spawn a second ticket.
    expect(harness.store.tickets.open()).toHaveLength(1)
  })

  it('keeps the first decision for a repeated decide even when the outcome differs', () => {
    const harness = makeHarness()
    const { trigger, first } = acceptTwice(harness)
    expect(first.decision.outcome).toBe('accept')

    // Same trigger, no fresh Eval: an ignore/stop attempt returns the stored
    // accept decision instead of creating a second decision. A real change of
    // mind needs `people.reevaluate` first (tested above).
    for (const outcome of ['ignore', 'stop'] as const) {
      const repeated = harness.engine.mainSession.decide({
        triggerId: trigger.id,
        outcome,
        reason: [{ code: 'retry' }],
      })
      expect(repeated.decision.id).toBe(first.decision.id)
      expect(repeated.decision.outcome).toBe('accept')
    }
    expect(harness.store.tickets.open()).toHaveLength(1)
  })
})
