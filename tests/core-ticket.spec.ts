import { describe, expect, it } from 'vitest'

import {
  FakeClock,
  MutablePolicy,
  RecordingEffects,
  RecordingExecutor,
  RecordingOutbox,
  effectPayload,
  makeGithubTrigger,
  makeHarness,
  makePolicy,
  makeTrigger,
  silentLogger,
} from './core-fixtures.js'
import type { Harness } from './core-fixtures.js'
import { createEngine } from '../src/core/engine.js'
import type { DeliveryPayload, EngineLanguage, LaunchPayload, RelayPayload } from '../src/core/engine.js'
import type { Ticket } from '../src/core/model.js'
import { createMemoryStore } from '../src/app/store.js'

function acceptTrigger(harness: ReturnType<typeof makeHarness>, triggerId: string, text = 'do the thing'): Ticket {
  harness.engine.sources.receive(makeTrigger({ id: triggerId, text }))
  harness.engine.evaluateDue()
  const result = harness.engine.mainSession.decide({
    triggerId,
    outcome: 'accept',
    reason: [{ code: 'asked', triggerId }],
  })
  expect(result.ticket).toBeDefined()
  return result.ticket!
}


/** A harness whose Engine is built with an explicit language (and limits). */
function localizedHarness(
  language?: EngineLanguage,
  options: { acknowledgeOnAccept?: boolean; maxMessageChars?: number } = {},
): Harness {
  const store = createMemoryStore()
  const clock = new FakeClock()
  const policy = new MutablePolicy(makePolicy())
  const effects = new RecordingEffects()
  const outbox = new RecordingOutbox()
  const executor = new RecordingExecutor()
  const engine = createEngine({
    store,
    clock,
    policy,
    effects,
    outbox,
    executor,
    logger: silentLogger,
    ...(language === undefined ? {} : { language }),
    ...(options.acknowledgeOnAccept === undefined ? {} : { acknowledgeOnAccept: options.acknowledgeOnAccept }),
    ...(options.maxMessageChars === undefined ? {} : { maxMessageChars: options.maxMessageChars }),
  })
  return { store, clock, policy, effects, outbox, executor, engine }
}

function startAssignment(harness: ReturnType<typeof makeHarness>, ticket: Ticket, sessionId = 'worker-1') {
  const assignment = harness.store.tickets.get(ticket.id)!.assignments[0]!
  harness.engine.executor.assignmentStarted({
    ticketId: ticket.id,
    assignmentId: assignment.id,
    sessionId,
  })
  return harness.store.tickets.get(ticket.id)!.assignments[0]!
}

describe('reports', () => {
  it('keeps progress quiet', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)
    harness.outbox.messages = []
    harness.effects.clear()

    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'progress', summary: 'halfway', at: harness.clock.now() },
    })

    const stored = harness.store.tickets.get(ticket.id)!
    expect(stored.latestReport?.summary).toBe('halfway')
    expect(harness.outbox.messages).toEqual([])
    expect(harness.effects.list('relay')).toEqual([])
    expect(stored.assignments[0]?.state).toBe('running')
    expect(stored.waitingForPerson).toBe(false)
  })

  it('asks a person about a blocked report, forwarding its question', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)

    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: {
        kind: 'blocked',
        summary: 'cannot choose a database',
        question: 'SQLite or Postgres?',
        at: harness.clock.now(),
      },
    })

    const stored = harness.store.tickets.get(ticket.id)!
    expect(stored.waitingForPerson).toBe(true)
    // The Report itself does not end the Assignment; the turn end does.
    expect(stored.assignments[0]?.state).toBe('running')
    harness.engine.executor.turnEnded(ticket.id, assignment.id)
    expect(harness.store.tickets.get(ticket.id)?.assignments[0]?.state).toBe('ended')
    expect(harness.outbox.messages).toHaveLength(1)
    expect(harness.outbox.messages[0]?.purpose).toBe('attention')
    expect(harness.outbox.messages[0]?.text).toContain('SQLite or Postgres?')
    expect(harness.outbox.messages[0]?.ticketId).toBe(ticket.id)
    expect(effectPayload<RelayPayload>(harness, 'relay')?.code).toBe('report_blocked')
  })

  it('reports a failure as attention and waits for a person', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'failed', summary: 'tests cannot pass', at: harness.clock.now() },
    })
    const stored = harness.store.tickets.get(ticket.id)!
    expect(stored.waitingForPerson).toBe(true)
    expect(harness.outbox.messages[0]?.purpose).toBe('attention')
    // A later Report that is neither blocked nor failed ends the hold.
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'waiting', summary: 'idle', at: harness.clock.now() },
    })
    expect(harness.store.tickets.get(ticket.id)?.waitingForPerson).toBe(false)
  })

  it('sends a result for a ready report and ends the Ticket as completed, keeping its Subscriptions', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    harness.engine.sources.bindThread(ticket.id, { key: 'owner/repo#7', source: 'github' }, true)
    const assignment = startAssignment(harness, ticket)

    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: {
        kind: 'ready',
        summary: 'opened a pull request',
        pullRequest: { repo: 'owner/repo', number: 7, url: 'https://example.test/pull/7' },
        at: harness.clock.now(),
      },
    })

    const stored = harness.store.tickets.get(ticket.id)!
    expect(stored.ends?.by).toBe('executor')
    expect(stored.ends?.outcome).toBe('completed')
    expect(stored.state).toBe('ended')
    // Ended Tickets keep their Subscriptions so a person message can resume them.
    expect(stored.subscriptions.some(thread => thread.key === 'chat-1')).toBe(true)
    expect(stored.subscriptions.some(thread => thread.key === 'owner/repo#7')).toBe(true)
    expect(harness.outbox.messages[0]?.purpose).toBe('result')
    expect(harness.outbox.messages[0]?.text).toContain('https://example.test/pull/7')
    // The attention/active views are built from open Tickets only.
    expect(harness.store.tickets.open().some(candidate => candidate.id === ticket.id)).toBe(false)
    expect(harness.store.tickets.active().some(candidate => candidate.id === ticket.id)).toBe(false)
  })

  it('ends an open Ticket once every Thread it follows closed, with the latest outcome', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    harness.engine.sources.bindThread(ticket.id, { key: 'owner/repo#7', source: 'github' }, true)

    harness.engine.sources.threadClosed('chat-1', 'merged', harness.clock.now())
    expect(harness.store.tickets.get(ticket.id)?.ends).toBeUndefined()
    harness.clock.advance(1_000)
    harness.engine.sources.threadClosed('owner/repo#7', 'closed', harness.clock.now())

    const closed = harness.store.tickets.get(ticket.id)!
    expect(closed.ends?.outcome).toBe('closed')
    expect(closed.ends?.by).toBe('system')
    expect(closed.follows.every(follow => follow.closed !== undefined)).toBe(true)
  })

  it('does not double-end or change the outcome of a Ticket already ended by ready', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    harness.engine.sources.bindThread(ticket.id, { key: 'owner/repo#7', source: 'github' }, true)
    const assignment = startAssignment(harness, ticket)
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'ready', summary: 'works', at: harness.clock.now() },
    })
    const endedAt = harness.store.tickets.get(ticket.id)!.ends!.at

    harness.clock.advance(5_000)
    harness.engine.sources.threadClosed('chat-1', 'merged', harness.clock.now())
    harness.engine.sources.threadClosed('owner/repo#7', 'merged', harness.clock.now())

    const closed = harness.store.tickets.get(ticket.id)!
    expect(closed.ends?.outcome).toBe('completed')
    expect(closed.ends?.at).toBe(endedAt)
    expect(closed.follows.some(follow => follow.closed !== undefined)).toBe(false)
  })

  it('ends a Telegram-origin ready Ticket and resumes it from a follow-up', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'ready', summary: 'done', at: harness.clock.now() },
    })
    expect(harness.store.tickets.get(ticket.id)?.ends?.outcome).toBe('completed')
    harness.effects.clear()

    harness.engine.sources.receive(makeTrigger({ id: 'tr_2', text: 'one more thing' }))
    harness.engine.evaluateDue()

    const resumed = harness.store.tickets.get(ticket.id)!
    expect(resumed.ends).toBeUndefined()
    expect(resumed.state).toBe('open')
    expect(resumed.assignments).toHaveLength(2)
    expect(resumed.assignments[1]?.state).toBe('pending')
    expect(harness.effects.list('assessment')).toEqual([])
    expect(effectPayload<LaunchPayload>(harness, 'launch')?.assignmentId).toBe(resumed.assignments[1]?.id)
  })

  it('ends a GitHub-issue ready Ticket even though the issue never closes', () => {
    const harness = makeHarness()
    harness.engine.sources.receive(makeGithubTrigger({ id: 'tr_gh', addressed: 'mention' }))
    harness.engine.evaluateDue()
    const result = harness.engine.mainSession.decide({
      triggerId: 'tr_gh',
      outcome: 'accept',
      reason: [{ code: 'asked', triggerId: 'tr_gh' }],
    })
    const ticket = result.ticket!
    const assignment = startAssignment(harness, ticket)
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: {
        kind: 'ready',
        summary: 'fixed',
        pullRequest: { repo: 'owner/repo', number: 9, url: 'https://example.test/pull/9' },
        at: harness.clock.now(),
      },
    })

    const stored = harness.store.tickets.get(ticket.id)!
    expect(stored.ends?.outcome).toBe('completed')
    expect(stored.subscriptions.some(thread => thread.key === 'owner/repo#1')).toBe(true)
    expect(harness.outbox.messages[0]?.purpose).toBe('result')
  })

  it('ends a dropped Ticket without an attention message', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'dropped', summary: 'no work here', at: harness.clock.now() },
    })
    const stored = harness.store.tickets.get(ticket.id)!
    expect(stored.ends?.outcome).toBe('dropped')
    expect(stored.state).toBe('ended')
    expect(harness.outbox.messages).toEqual([])
    expect(effectPayload<RelayPayload>(harness, 'relay')?.code).toBe('report_dropped')
  })
})

describe('delivery and turns', () => {
  it('records a failed delivery until an Input is delivered', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)
    harness.engine.executor.deliveryFailed(ticket.id, assignment.id, 'session unavailable')
    expect(harness.store.tickets.get(ticket.id)?.delivery?.error).toBe('session unavailable')

    harness.engine.mainSession.note(ticket.id, 'a fact from another task')
    const payload = effectPayload<DeliveryPayload>(harness, 'delivery')!
    const notedInput = harness.store.tickets.get(ticket.id)!.inputs.find(input => input.kind === 'text')!
    expect(payload.inputIds).toContain(notedInput.id)

    harness.engine.executor.inputsDelivered(ticket.id, assignment.id, payload.inputIds)
    const delivered = harness.store.tickets.get(ticket.id)!
    expect(delivered.delivery).toBeUndefined()
    expect(delivered.inputs.find(input => input.kind === 'text')?.readAt).toBeDefined()
  })

  it('ends the Assignment when its turn ends', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)
    expect(harness.store.tickets.get(ticket.id)?.assignments[0]?.state).toBe('running')
    harness.engine.executor.turnEnded(ticket.id, assignment.id)
    expect(harness.store.tickets.get(ticket.id)?.assignments[0]?.state).toBe('ended')
  })

  it('records and announces the same report only once', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)
    const report = { kind: 'blocked' as const, summary: 'cannot choose a database', question: 'SQLite or Postgres?', at: harness.clock.now() }

    harness.engine.executor.report({ ticketId: ticket.id, assignmentId: assignment.id, report })
    harness.engine.executor.report({ ticketId: ticket.id, assignmentId: assignment.id, report })

    expect(harness.outbox.messages).toHaveLength(1)
    expect(harness.effects.list('relay')).toHaveLength(1)
    expect(harness.store.tickets.get(ticket.id)?.latestReport?.summary).toBe('cannot choose a database')
  })

  it('does not announce the same ready report twice either', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)
    const report = { kind: 'ready' as const, summary: 'opened a pull request', at: harness.clock.now() }

    harness.engine.executor.report({ ticketId: ticket.id, assignmentId: assignment.id, report })
    harness.engine.executor.report({ ticketId: ticket.id, assignmentId: assignment.id, report })

    expect(harness.outbox.messages).toHaveLength(1)
    expect(harness.outbox.messages[0]?.purpose).toBe('result')
    expect(harness.effects.list('relay')).toHaveLength(1)
  })

  it('ignores a report for an Assignment whose turn already ended', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)
    harness.engine.executor.turnEnded(ticket.id, assignment.id)

    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'blocked', summary: 'late question', question: 'still there?', at: harness.clock.now() },
    })

    expect(harness.outbox.messages).toEqual([])
    expect(harness.effects.list('relay')).toEqual([])
    expect(harness.store.tickets.get(ticket.id)?.latestReport).toBeUndefined()
    expect(harness.store.tickets.get(ticket.id)?.waitingForPerson).toBeFalsy()
  })

  it('still applies a new report of a different kind on the same Assignment', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)

    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'blocked', summary: 'cannot choose', question: 'Which one?', at: harness.clock.now() },
    })
    harness.clock.advance(1_000)
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'ready', summary: 'found a way after all', at: harness.clock.now() },
    })

    const stored = harness.store.tickets.get(ticket.id)!
    expect(stored.latestReport?.kind).toBe('ready')
    expect(stored.waitingForPerson).toBe(false)
    expect(harness.outbox.messages.map(message => message.purpose)).toEqual(['attention', 'result'])
  })
})

describe('recovery', () => {
  it('restarts an interrupted Assignment with a recovery note', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)
    harness.effects.clear()

    harness.engine.executor.assignmentInterrupted(ticket.id, assignment.id)
    const stored = harness.store.tickets.get(ticket.id)!
    expect(stored.assignments).toHaveLength(2)
    expect(stored.assignments[0]?.state).toBe('ended')
    expect(stored.assignments[1]?.state).toBe('pending')
    expect(stored.inputs.some(input => input.kind === 'resume')).toBe(true)
    expect(effectPayload<LaunchPayload>(harness, 'launch')?.assignmentId).toBe(stored.assignments[1]?.id)
  })

  it('retries a stalled Ticket with a fresh Assignment and interrupts the old one', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'failed', summary: 'broke', at: harness.clock.now() },
    })
    expect(harness.store.tickets.get(ticket.id)?.waitingForPerson).toBe(true)

    harness.engine.people.retryTicket(ticket.id)
    const stored = harness.store.tickets.get(ticket.id)!
    expect(stored.waitingForPerson).toBe(false)
    expect(stored.assignments).toHaveLength(2)
    expect(stored.assignments[0]?.state).toBe('ended')
    expect(stored.assignments[1]?.state).toBe('pending')
    // The stalled turn is cancelled; a failed Report no longer ends the Assignment itself.
    expect(harness.executor.interrupts).toHaveLength(1)
  })

  it('asks a running Assignment for its status', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    expect(harness.engine.mainSession.requestStatus(ticket.id)).toBe(false)
    const assignment = startAssignment(harness, ticket)
    expect(harness.engine.mainSession.requestStatus(ticket.id)).toBe(true)
    expect(harness.executor.statusRequests[0]?.assignmentId).toBe(assignment.id)
  })
})

describe('handback and unrelated Threads', () => {
  it('hands a Trigger back once and queues a fresh Eval', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    harness.engine.sources.receive(makeTrigger({ id: 'tr_2', text: 'out of scope' }))
    harness.effects.clear()

    harness.engine.executor.handback(ticket.id, 'tr_2', 'belongs to another Ticket')
    expect(harness.store.threads.get('chat-1')?.queued).toEqual(['tr_2'])
    expect(harness.store.dispositions.get('tr_2')?.handedBack.map(entry => entry.reason)).toEqual([
      'belongs to another Ticket',
    ])

    // A second hand-back of the same Trigger is a no-op.
    harness.engine.executor.handback(ticket.id, 'tr_2', 'again')
    expect(harness.store.dispositions.get('tr_2')?.handedBack).toHaveLength(1)
    harness.engine.evaluateDue()
    expect(effectPayload(harness, 'assessment')).toBeDefined()
  })

  it('drops only an attached Thread and hands its follow-ups back', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    harness.engine.executor.followForContext(ticket.id, { key: 'chat-9', source: 'telegram' })
    harness.engine.sources.receive(makeTrigger({ id: 'tr_2', threadKey: 'chat-9', text: 'follow up' }))
    expect(harness.store.tickets.get(ticket.id)?.inputs.some(input => input.triggerId === 'tr_2')).toBe(true)

    harness.engine.executor.markUnrelated(ticket.id, 'chat-9', 'different topic')
    const stored = harness.store.tickets.get(ticket.id)!
    expect(stored.subscriptions.some(thread => thread.key === 'chat-9')).toBe(false)
    expect(harness.store.threads.get('chat-9')?.subscriptions).toEqual([])
    expect(harness.store.threads.get('chat-9')?.queued).toContain('tr_2')
  })

  it('refuses to drop the Thread a Ticket owns', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    harness.engine.executor.markUnrelated(ticket.id, 'chat-1', 'not relevant')
    const stored = harness.store.tickets.get(ticket.id)!
    expect(stored.subscriptions.some(thread => thread.key === 'chat-1')).toBe(true)
  })
})

describe('reply', () => {
  it('queues a Channel write through the Outbox port', () => {
    const harness = makeHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    harness.outbox.messages = []
    harness.engine.mainSession.reply({
      id: 'msg_manual',
      ticketId: ticket.id,
      purpose: 'answer',
      channel: { source: 'telegram', thread: 'chat-1', to: 'chat-1' },
      text: 'here is the answer',
      at: harness.clock.now(),
    })
    expect(harness.outbox.messages).toHaveLength(1)
    expect(harness.outbox.messages[0]?.id).toBe('msg_manual')
  })
})

describe('language', () => {
  it('writes Chinese user-facing messages by default', () => {
    const harness = localizedHarness()
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)

    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'blocked', summary: 'cannot choose a database', question: '用哪个数据库？', at: harness.clock.now() },
    })
    harness.clock.advance(1_000)
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'failed', summary: '编译失败', at: harness.clock.now() },
    })
    harness.clock.advance(1_000)
    // A ready Report is terminal for the Ticket, so it comes last.
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: {
        kind: 'ready',
        summary: 'opened a pull request',
        pullRequest: { repo: 'owner/repo', number: 7, url: 'https://example.test/pull/7' },
        at: harness.clock.now(),
      },
    })

    expect(harness.outbox.messages.map(message => message.purpose)).toEqual(['attention', 'attention', 'result'])
    expect(harness.outbox.messages[0]?.text).toBe('需要你决定：用哪个数据库？')
    expect(harness.outbox.messages[1]?.text).toBe('出了点问题：编译失败')
    expect(harness.outbox.messages[2]?.text).toBe('已完成，请验收：opened a pull request https://example.test/pull/7')
  })

  it('writes English user-facing messages when configured', () => {
    const harness = localizedHarness('en')
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)

    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'blocked', summary: 'cannot choose', question: 'Which database?', at: harness.clock.now() },
    })
    harness.clock.advance(1_000)
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'failed', summary: 'the build is red', at: harness.clock.now() },
    })
    harness.clock.advance(1_000)
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: {
        kind: 'ready',
        summary: 'opened a pull request',
        pullRequest: { repo: 'owner/repo', number: 7, url: 'https://example.test/pull/7' },
        at: harness.clock.now(),
      },
    })

    expect(harness.outbox.messages[0]?.text).toBe('Need your decision: Which database?')
    expect(harness.outbox.messages[1]?.text).toBe('Something went wrong: the build is red')
    expect(harness.outbox.messages[2]?.text).toBe(
      'Ready for review: opened a pull request https://example.test/pull/7',
    )
  })

  it('localizes the acknowledgement when it is enabled', () => {
    const chinese = localizedHarness(undefined, { acknowledgeOnAccept: true })
    acceptTrigger(chinese, 'tr_1')
    expect(chinese.outbox.messages[0]?.purpose).toBe('acknowledgement')
    expect(chinese.outbox.messages[0]?.text).toBe('收到，开始处理：do the thing')

    const english = localizedHarness('en', { acknowledgeOnAccept: true })
    acceptTrigger(english, 'tr_1')
    expect(english.outbox.messages[0]?.text).toBe('On it: do the thing')
  })

  it('truncates localized messages to the configured limit', () => {
    const harness = localizedHarness('zh', { maxMessageChars: 24 })
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'ready', summary: 'x'.repeat(200), at: harness.clock.now() },
    })

    const text = harness.outbox.messages[0]?.text ?? ''
    expect(text).toHaveLength(24)
    expect(text.endsWith('…')).toBe(true)
    expect(text.startsWith('已完成，请验收：')).toBe(true)
  })

  it('keeps English messages within the same limit', () => {
    const harness = localizedHarness('en', { maxMessageChars: 30 })
    const ticket = acceptTrigger(harness, 'tr_1')
    const assignment = startAssignment(harness, ticket)
    harness.engine.executor.report({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      report: { kind: 'blocked', summary: 'y'.repeat(200), question: 'z'.repeat(200), at: harness.clock.now() },
    })

    const text = harness.outbox.messages[0]?.text ?? ''
    expect(text).toHaveLength(30)
    expect(text.startsWith('Need your decision: ')).toBe(true)
    expect(text.endsWith('…')).toBe(true)
  })
})
