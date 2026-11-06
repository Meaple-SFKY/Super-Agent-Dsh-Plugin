/**
 * Stall watchdog tests: request a status report first, escalate (interrupt +
 * retry) only after the second threshold, and never touch healthy assignments.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { Watchdog, stalledAssignments } from '../src/app/watchdog.js'
import type { Assignment } from '../src/core/model.js'
import { FakeClock, RecordingEffects, RecordingExecutor, makeHarness, makeTrigger } from './core-fixtures.js'

function ticketWith(harness: ReturnType<typeof makeHarness>, overrides: Partial<Assignment> = {}) {
  const trigger = makeTrigger({ text: 'please fix the build' })
  harness.engine.sources.receive(trigger)
  harness.engine.evaluateDue()
  const result = harness.engine.mainSession.decide({ triggerId: trigger.id, outcome: 'accept', title: 'Fix the build', reason: [{ code: 'test' }] })
  const ticket = harness.store.tickets.get(result.ticket!.id)!
  const assignment = ticket.assignments[ticket.assignments.length - 1]!
  Object.assign(assignment, { state: 'running', startedAt: harness.clock.now(), ...overrides } satisfies Partial<Assignment>)
  harness.store.tickets.save(ticket)
  return { ticket, assignment }
}

function makeWatchdog(harness: ReturnType<typeof makeHarness>, effects: RecordingEffects, executor: RecordingExecutor, clock: FakeClock) {
  return new Watchdog({
    store: harness.store,
    executor,
    engine: () => harness.engine,
    effects,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => clock.now(),
    config: { stallMs: 1_000, escalateMs: 1_000, intervalMs: 60_000 },
  })
}

describe('watchdog', () => {
  it('requests a status report before escalating and then interrupts with a retry', () => {
    const harness = makeHarness()
    const effects = new RecordingEffects()
    const executor = new RecordingExecutor()
    const clock = new FakeClock()
    const { ticket, assignment } = ticketWith(harness)
    const watchdog = makeWatchdog(harness, effects, executor, clock)

    // Too early: nothing happens.
    watchdog.scan()
    expect(executor.statusRequests).toHaveLength(0)

    // Past the stall threshold: one status request, no interrupt.
    clock.advance(2_000)
    watchdog.scan()
    expect(executor.statusRequests).toEqual([{ ticketId: ticket.id, assignmentId: assignment.id }])
    expect(executor.interrupts).toHaveLength(0)
    expect(effects.list('launch')).toHaveLength(0)

    // Not yet at the escalation threshold.
    clock.advance(400)
    watchdog.scan()
    expect(executor.interrupts).toHaveLength(0)

    // Past the escalation threshold: interrupt + durable retry launch.
    clock.advance(700)
    watchdog.scan()
    expect(executor.interrupts).toHaveLength(1)
    expect(executor.interrupts[0]!.reason).toContain('stalled')
    const fresh = harness.store.tickets.get(ticket.id)!
    const latest = fresh.assignments[fresh.assignments.length - 1]!
    expect(latest.state).toBe('pending')
    expect(latest.id).not.toBe(assignment.id)
    const launches = effects.list('launch')
    expect(launches).toHaveLength(1)
    expect(launches[0]!.payload).toEqual({ ticketId: ticket.id, assignmentId: latest.id })
    expect(watchdog.stats().scans).toBe(4)
  })

  it('ignores assignments that reported recently', () => {
    const harness = makeHarness()
    const effects = new RecordingEffects()
    const executor = new RecordingExecutor()
    const clock = new FakeClock()
    const { ticket, assignment } = ticketWith(harness, {
      report: { kind: 'progress', summary: 'still working', at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + 4_000).toISOString() },
    })
    clock.advance(4_500)
    const watchdog = makeWatchdog(harness, effects, executor, clock)
    watchdog.scan()
    expect(executor.statusRequests).toHaveLength(0)
    expect(harness.store.tickets.get(ticket.id)!.assignments[0]!.id).toBe(assignment.id)
  })

  it('reports the stalled assignments it would escalate', () => {
    const harness = makeHarness()
    const clock = new FakeClock()
    const { ticket, assignment } = ticketWith(harness)
    clock.advance(2_000)
    const stalled = stalledAssignments(harness.store, { stallMs: 1_000 }, Date.parse(clock.now()))
    expect(stalled).toEqual([{ ticketId: ticket.id, assignmentId: assignment.id }])
  })

  it('start/stop owns a single unref timer', () => {
    const harness = makeHarness()
    const effects = new RecordingEffects()
    const executor = new RecordingExecutor()
    const clock = new FakeClock()
    const watchdog = makeWatchdog(harness, effects, executor, clock)
    watchdog.start()
    watchdog.start()
    watchdog.stop()
    watchdog.stop()
    expect(watchdog.stats().scans).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// B2: runtime/guardian status consistency
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { start } from '../src/engine.js'
import { redactDetail, startRuntime } from '../src/app/runtime.js'
import { FakeRootContext, RecordingLogger, createFakeHost } from './runtime-host.js'

const tempDirs: string[] = []

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-b2-'))
  tempDirs.push(dir)
  return dir
}

function emptyContext(): Context {
  return new FakeRootContext({}, new RecordingLogger()) as unknown as Context
}

describe('runtime lifecycle reporting (B2)', () => {
  it('throws from start() when required DSH services are missing, and cleans up', async () => {
    const stateDir = tempStateDir()
    const failure = await start(emptyContext(), { stateDir }).then(
      () => undefined,
      (error: unknown) => error as Error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure?.message).toContain('did not start (degraded)')
    expect(failure?.message).toContain('agents')

    // The state-directory lock and the SQLite handle were released: a full
    // runtime can start on the same directory right away.
    const host = createFakeHost()
    const handle = await start(host.ctx as unknown as Context, {
      stateDir,
      sources: { telegram: { enabled: false }, github: { enabled: false } },
      passIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })
    expect(handle).toBeDefined()
    await handle.stop()
  })

  it('exposes the degraded status and detail before the plugin entry throws', async () => {
    const runtimeHandle = await startRuntime(emptyContext(), { stateDir: tempStateDir() })
    expect(runtimeHandle.runtime.status).toBe('degraded')
    expect(runtimeHandle.runtime.detail).toContain('agents')
    await runtimeHandle.stop()
  })

  it('throws on invalid configuration without leaking resources', async () => {
    const failure = await start(emptyContext(), { stateDir: 'relative/path' }).then(
      () => undefined,
      (error: unknown) => error as Error,
    )
    expect(failure?.message).toContain('did not start (degraded)')
    expect(failure?.message).toContain('absolute')
  })

  it('redacts credentials from the thrown detail', () => {
    expect(redactDetail('token 1234567:AAHsecretsecretsecretsecret12345 failed')).not.toContain('AAHsecret')
    expect(redactDetail('ghp_abcdefghijklmnopqrstuvwxyz123456')).toBe('[redacted-token]')
    expect(redactDetail('TELEGRAM_TOKEN=abc123 nope')).toContain('[redacted]')
    expect(redactDetail('plain failure detail')).toBe('plain failure detail')
  })
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

// ---------------------------------------------------------------------------
// B3: bounded self-heal for a ticket whose turn ended without a report
// ---------------------------------------------------------------------------

interface SilentSetup {
  harness: ReturnType<typeof makeHarness>
  effects: RecordingEffects
  executor: RecordingExecutor
  clock: FakeClock
  ticketId: string
  health: Array<{ name: string; state: string; detail?: string }>
}

function makeSilentSetup(): SilentSetup {
  const harness = makeHarness()
  const effects = new RecordingEffects()
  const executor = new RecordingExecutor()
  const clock = new FakeClock()
  const health: Array<{ name: string; state: string; detail?: string }> = []
  const trigger = makeTrigger({ text: 'fix the build' })
  harness.engine.sources.receive(trigger)
  harness.engine.evaluateDue()
  const result = harness.engine.mainSession.decide({ triggerId: trigger.id, outcome: 'accept', title: 'Fix', reason: [{ code: 't' }] })
  const ticketId = result.ticket!.id
  const ticket = harness.store.tickets.get(ticketId)!
  const assignment = ticket.assignments[ticket.assignments.length - 1]!
  // A turn that ended without any report: the assignment ends, the ticket stays open.
  harness.engine.executor.assignmentStarted({ ticketId, assignmentId: assignment.id, sessionId: 'superagent-worker-x' })
  harness.engine.executor.turnEnded(ticketId, assignment.id)
  return { harness, effects, executor, clock, ticketId, health }
}

function silentWatchdog(setup: SilentSetup, overrides: { paused?: () => boolean; maxAttempts?: number } = {}) {
  return new Watchdog({
    store: setup.harness.store,
    executor: setup.executor,
    engine: () => setup.harness.engine,
    effects: setup.effects,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => setup.clock.now(),
    ...(overrides.paused ? { isPaused: overrides.paused } : {}),
    reportHealth: (name, state, detail) => setup.health.push({ name, state, ...(detail ? { detail } : {}) }),
    config: { stallMs: 60_000, escalateMs: 60_000, intervalMs: 60_000, silentMs: 1_000, silentMaxAttempts: overrides.maxAttempts ?? 2 },
  })
}

/** Simulate the retried assignment ending without a report again. */
function stallLatestAssignment(setup: SilentSetup): void {
  const ticket = setup.harness.store.tickets.get(setup.ticketId)!
  const latest = ticket.assignments[ticket.assignments.length - 1]!
  setup.harness.engine.executor.assignmentStarted({ ticketId: setup.ticketId, assignmentId: latest.id, sessionId: 'superagent-worker-x' })
  setup.harness.engine.executor.turnEnded(setup.ticketId, latest.id)
}

describe('silent-ticket self-heal (B3)', () => {
  it('retries a silent ticket, stops at the cap and records health', () => {
    const setup = makeSilentSetup()
    const watchdog = silentWatchdog(setup)

    watchdog.scan()
    expect(setup.harness.store.tickets.get(setup.ticketId)!.assignments).toHaveLength(1)

    setup.clock.advance(2_000)
    watchdog.scan()
    let ticket = setup.harness.store.tickets.get(setup.ticketId)!
    expect(ticket.assignments).toHaveLength(2)
    expect(setup.harness.store.kv.get<number>(`superagent.watchdog.silent.${setup.ticketId}`)).toBe(1)
    stallLatestAssignment(setup)

    setup.clock.advance(2_000)
    watchdog.scan()
    ticket = setup.harness.store.tickets.get(setup.ticketId)!
    expect(ticket.assignments).toHaveLength(3)
    expect(setup.harness.store.kv.get<number>(`superagent.watchdog.silent.${setup.ticketId}`)).toBe(2)
    stallLatestAssignment(setup)

    // Budget exhausted: no third automatic retry, health reports the ticket.
    setup.clock.advance(2_000)
    watchdog.scan()
    expect(setup.harness.store.tickets.get(setup.ticketId)!.assignments).toHaveLength(3)
    expect(watchdog.stats().silentRetries).toBe(2)
    expect(watchdog.stats().silentExhausted).toEqual([setup.ticketId])
    const last = setup.health[setup.health.length - 1]!
    expect(last.name).toBe('watchdog:silent')
    expect(last.state).toBe('error')
    expect(last.detail).toContain(setup.ticketId)

    // A fresh scan keeps reporting the exhausted state without acting.
    setup.clock.advance(2_000)
    watchdog.scan()
    expect(setup.harness.store.tickets.get(setup.ticketId)!.assignments).toHaveLength(3)
  })

  it('does not touch a ticket waiting for a person, a terminal report or a paused runtime', () => {
    const setup = makeSilentSetup()
    const blocked = setup.harness.store.tickets.get(setup.ticketId)!
    blocked.latestReport = { kind: 'blocked', summary: 'stuck', question: 'Proceed?', at: setup.clock.now() }
    blocked.waitingForPerson = true
    setup.harness.store.tickets.save(blocked)
    const watchdog = silentWatchdog(setup)
    setup.clock.advance(2_000)
    watchdog.scan()
    expect(setup.harness.store.tickets.get(setup.ticketId)!.assignments).toHaveLength(1)
    expect(setup.health[setup.health.length - 1]!.state).toBe('ready')

    const pausedSetup = makeSilentSetup()
    const pausedWatchdog = silentWatchdog(pausedSetup, { paused: () => true })
    pausedSetup.clock.advance(2_000)
    pausedWatchdog.scan()
    expect(pausedSetup.harness.store.tickets.get(pausedSetup.ticketId)!.assignments).toHaveLength(1)
  })

  it('keeps the retry budget across a restart', () => {
    const setup = makeSilentSetup()
    setup.clock.advance(2_000)
    silentWatchdog(setup).scan()
    expect(setup.harness.store.kv.get<number>(`superagent.watchdog.silent.${setup.ticketId}`)).toBe(1)

    // New watchdog instance on the same store (host restart) must see the same budget.
    const restarted = silentWatchdog(setup)
    stallLatestAssignment(setup)
    setup.clock.advance(2_000)
    restarted.scan()
    expect(restarted.stats().silentRetries).toBe(1)
    expect(setup.harness.store.kv.get<number>(`superagent.watchdog.silent.${setup.ticketId}`)).toBe(2)
  })
})
