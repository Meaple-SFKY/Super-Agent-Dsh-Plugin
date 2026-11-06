/**
 * End-to-end runtime test against a simulated DSH host and the real domain
 * engine/store/effects/outbox.
 *
 * Covers the milestone's acceptance path:
 *   candidate → Router accept → launch → worker report → user-facing message
 * plus blocked questions, quiet runs, restart recovery and failure isolation.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { Runtime, validateConfig, type RuntimeConfig } from '../src/app/runtime.js'
import { createMemoryStore } from '../src/app/store.js'
import { makeTrigger } from './core-fixtures.js'
import { FakeSource, createFakeHost, textOf, until } from './runtime-host.js'
import type { Context } from '@deepseek-ai/cordis'

interface Harness {
  stateDir: string
  host: ReturnType<typeof createFakeHost>
  store: ReturnType<typeof createMemoryStore>
  source: FakeSource
  runtime: Runtime
  config: RuntimeConfig
  cleanup: () => Promise<void>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch {
      // keep the suite green
    }
  }
})

async function startRuntime(): Promise<Harness> {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-rt-'))
  const host = createFakeHost()
  const store = createMemoryStore()
  const source = new FakeSource('telegram')
  const config: RuntimeConfig = {
    stateDir,
    sources: {
      telegram: { enabled: false, allowedUserIds: ['u1'] },
      github: { enabled: false },
    },
    policy: { mode: 'auto' },
    executor: { maxWorkers: 2 },
    passIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    watchdog: { intervalMs: 60_000, stallMs: 60_000, escalateMs: 60_000 },
  }
  const runtime = new Runtime(host.ctx as unknown as Context, config, {
    store,
    sources: [{ id: 'telegram', source }],
    skipLock: true,
  })
  await runtime.ready
  const cleanup = async (): Promise<void> => {
    await runtime.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
  cleanups.push(cleanup)
  return { stateDir, host, store, source, runtime, config, cleanup }
}

function routerAgent(harness: Harness) {
  const agent = harness.host.agents.liveAgent('superagent-router')
  if (!agent) throw new Error('router agent was not created')
  return agent
}

function workerAgent(harness: Harness, ticketId: string) {
  const agent = harness.host.agents.liveAgent(`superagent-worker-${ticketId}`)
  if (!agent) throw new Error(`worker agent for ${ticketId} was not created`)
  return agent
}

/** Feed one trigger, run an engine pass and the effect pump, then return the candidate text. */
async function deliverCandidate(harness: Harness, text: string, id = `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`) {
  const trigger = makeTrigger({ id, text })
  const disposition = harness.runtime.enginePort!.sources.receive(trigger)
  expect(disposition).toBe('stored')
  await harness.runtime.pass('test')
  await harness.runtime.pumpEffects()
  return { trigger, text: routerAgent(harness).allText().join('\n') }
}

describe('runtime end to end', () => {
  it('wakes assessment from ingest without a manual pass (event-driven fast path)', async () => {
    const harness = await startRuntime()
    const router = routerAgent(harness)
    const disposition = harness.runtime.ingest(makeTrigger({ text: 'please fix the failing test in owner/repo' }))
    expect(disposition).toBe('stored')
    // passIntervalMs is 60 s in this harness: only the wake path can deliver.
    await until(() => router.followups.length > 0, 500, 'router followup after wake')
    expect(router.allText().join('\n')).toContain('[superagent candidate]')
  })

  it('creates the router session with the router preset, prompt and tools', async () => {
    const harness = await startRuntime()
    const router = routerAgent(harness)
    expect(String(router.id)).toBe('superagent-router')
    expect(harness.host.presets.mounted.some(entry => entry.presetId === 'superagent-router')).toBe(true)
    expect(harness.host.promptFor(router).sections.map(section => section.name)).toContain('superagent:router-role')
    const toolNames = harness.host.toolsFor(router).names()
    expect(toolNames).toContain('superagent_route')
    expect(toolNames).toContain('superagent_reply')
    expect(toolNames).not.toContain('superagent_report')
    expect(harness.source.started).toBe(1)
    expect(harness.host.webServer.route('/superagent/api/state')).toBeDefined()
    expect(harness.host.webServer.route('/superagent/api/action')).toBeDefined()
  })

  it('walks candidate → accept → launch → ready report → user message', async () => {
    const harness = await startRuntime()
    const router = routerAgent(harness)

    const candidate = await deliverCandidate(harness, 'please fix the failing test in owner/repo')
    expect(candidate.text).toContain('[superagent candidate]')
    expect(candidate.text).toContain(candidate.trigger.id)

    const accepted = (await harness.host.executeTool(router, 'superagent_route', {
      triggerId: candidate.trigger.id,
      outcome: 'accept',
      title: 'Fix the failing test',
      reason: 'explicit request',
    })).value as { ok: boolean; ticketId?: string }
    expect(accepted.ok).toBe(true)
    expect(accepted.ticketId).toBeTruthy()
    const ticketId = accepted.ticketId!

    await harness.runtime.pumpEffects()
    await until(() => harness.host.agents.liveAgent(`superagent-worker-${ticketId}`) !== undefined, 4_000, 'worker session')

    const worker = workerAgent(harness, ticketId)
    expect(worker.allText().join('\n')).toContain('[superagent assignment]')
    expect(harness.host.presets.mounted.some(entry => entry.presetId === 'superagent-worker')).toBe(true)
    const ticket = harness.store.tickets.get(ticketId)!
    expect(ticket.state).toBe('open')
    const assignment = ticket.assignments[ticket.assignments.length - 1]!
    expect(assignment.state).toBe('running')
    expect(assignment.sessionId).toBe(`superagent-worker-${ticketId}`)

    const reported = (await harness.host.executeTool(worker, 'superagent_report', {
      kind: 'ready',
      summary: 'PR opened with the fix',
      prUrl: 'https://github.com/owner/repo/pull/7',
    })).value as { ok: boolean }
    expect(reported.ok).toBe(true)

    await harness.runtime.pumpEffects()
    await until(() => harness.source.sent.length > 0, 4_000, 'user-facing ready message')
    expect(harness.source.sent[0]!.text).toContain('PR opened with the fix')
    expect(harness.source.sent[0]!.text).toContain('pull/7')
    expect(harness.store.tickets.get(ticketId)!.latestReport?.kind).toBe('ready')
  })

  it('turns a blocked report into exactly one attention question', async () => {
    const harness = await startRuntime()
    const router = routerAgent(harness)
    const candidate = await deliverCandidate(harness, 'migrate the database')
    const accepted = (await harness.host.executeTool(router, 'superagent_route', {
      triggerId: candidate.trigger.id,
      outcome: 'accept',
      title: 'Migrate the database',
    })).value as { ticketId?: string }
    await harness.runtime.pumpEffects()
    const ticketId = accepted.ticketId!
    await until(() => harness.host.agents.liveAgent(`superagent-worker-${ticketId}`) !== undefined, 4_000, 'worker session')
    const worker = workerAgent(harness, ticketId)

    const missingQuestion = (await harness.host.executeTool(worker, 'superagent_report', {
      kind: 'blocked',
      summary: 'need a decision',
    })).value as { ok: boolean; error?: string }
    expect(missingQuestion.ok).toBe(false)
    expect(missingQuestion.error).toBe('question_required')

    await harness.host.executeTool(worker, 'superagent_report', {
      kind: 'blocked',
      summary: 'Cannot continue',
      question: 'Should I drop the legacy column?',
    })
    await harness.runtime.pumpEffects()
    await until(() => harness.source.sent.length > 0, 4_000, 'blocked attention message')
    const text = harness.source.sent[0]!.text
    expect(text).toContain('Should I drop the legacy column?')
    expect(harness.store.tickets.get(ticketId)!.waitingForPerson).toBe(true)
  })

  it('stays quiet for progress reports and ignored candidates', async () => {
    const harness = await startRuntime()
    const router = routerAgent(harness)

    const noisy = await deliverCandidate(harness, 'thanks!')
    await harness.host.executeTool(router, 'superagent_route', {
      triggerId: noisy.trigger.id,
      outcome: 'ignore',
      reasonCode: 'noise',
    })
    await harness.runtime.pumpEffects()

    const work = await deliverCandidate(harness, 'please fix the build')
    const accepted = (await harness.host.executeTool(router, 'superagent_route', {
      triggerId: work.trigger.id,
      outcome: 'accept',
      title: 'Fix the build',
    })).value as { ticketId?: string }
    await harness.runtime.pumpEffects()
    const ticketId = accepted.ticketId!
    await until(() => harness.host.agents.liveAgent(`superagent-worker-${ticketId}`) !== undefined, 4_000, 'worker session')
    const worker = workerAgent(harness, ticketId)
    await harness.host.executeTool(worker, 'superagent_report', {
      kind: 'progress',
      summary: 'tests are running',
    })
    await harness.host.executeTool(worker, 'superagent_report', {
      kind: 'waiting',
      summary: 'waiting for CI',
    })
    await harness.runtime.pumpEffects()
    expect(harness.source.sent).toHaveLength(0)
  })

  it('interrupts the worker turn when the router stops the ticket', async () => {
    const harness = await startRuntime()
    const router = routerAgent(harness)
    const candidate = await deliverCandidate(harness, 'delete the old branch')
    const accepted = (await harness.host.executeTool(router, 'superagent_route', {
      triggerId: candidate.trigger.id,
      outcome: 'accept',
      title: 'Delete the old branch',
    })).value as { ticketId?: string }
    await harness.runtime.pumpEffects()
    const ticketId = accepted.ticketId!
    await until(() => harness.host.agents.liveAgent(`superagent-worker-${ticketId}`) !== undefined, 4_000, 'worker session')
    const worker = workerAgent(harness, ticketId)

    await harness.host.executeTool(router, 'superagent_ticket', { ticketId, action: 'stop', text: 'user changed their mind' })
    await until(() => worker.cancels.length > 0, 2_000, 'worker cancellation')
    expect(harness.store.tickets.get(ticketId)!.state).toBe('ended')
  })

  it('recovers a running assignment after a host restart', async () => {
    const harness = await startRuntime()
    const router = routerAgent(harness)
    const candidate = await deliverCandidate(harness, 'fix the flaky test')
    const accepted = (await harness.host.executeTool(router, 'superagent_route', {
      triggerId: candidate.trigger.id,
      outcome: 'accept',
      title: 'Fix the flaky test',
    })).value as { ticketId?: string }
    await harness.runtime.pumpEffects()
    const ticketId = accepted.ticketId!
    await until(() => harness.host.agents.liveAgent(`superagent-worker-${ticketId}`) !== undefined, 4_000, 'worker session')
    const firstWorker = workerAgent(harness, ticketId)
    expect(harness.store.tickets.get(ticketId)!.assignments.at(-1)!.state).toBe('running')

    // Simulate a host restart: sessions survive in persistence, live agents do not.
    await harness.runtime.stop()
    harness.host.agents.restart()

    const restarted = new Runtime(harness.host.ctx as unknown as Context, harness.config, {
      store: harness.store,
      sources: [{ id: 'telegram', source: harness.source }],
      skipLock: true,
    })
    cleanups.push(async () => {
      await restarted.stop()
    })
    await restarted.ready
    await until(() => harness.host.agents.liveAgent(`superagent-worker-${ticketId}`) !== undefined, 4_000, 'recovered worker session')
    await restarted.pumpEffects()

    const recovered = workerAgent(harness, ticketId)
    const text = recovered.allText().join('\n')
    expect(text).toContain('[superagent assignment]')
    expect(text).toContain('[recovery]')
    expect(harness.host.agents.resumed.some(entry => entry.sessionId === `superagent-worker-${ticketId}`)).toBe(true)
    expect(harness.store.tickets.get(ticketId)!.assignments.at(-1)!.state).toBe('running')
    expect(firstWorker).not.toBe(recovered) // a fresh live agent object on the same persisted session
  })

  it('enters safe mode after repeated engine failures and stops the sources', async () => {
    const harness = await startRuntime()
    const engine = harness.runtime.enginePort as unknown as { evaluateDue: () => void }
    engine.evaluateDue = () => {
      throw new Error('engine exploded')
    }
    for (let index = 0; index < 5; index++) await harness.runtime.pass('failure-test')
    await until(() => harness.source.stopped > 0, 3_000, 'sources stopped in safe mode')
    const state = harness.runtime.buildState()
    expect(state.plugin.status).toBe('degraded')
    expect(state.plugin.detail).toContain('safe mode')
    const health = state.health.find(entry => entry.name === 'runtime')
    expect(health?.state).toBe('error')
  })

  it('validates configuration without throwing', () => {
    expect(validateConfig(undefined).problem?.error).toContain('object')
    expect(validateConfig({}).problem?.error).toContain('stateDir')
    expect(validateConfig({ stateDir: 'relative' }).problem?.error).toContain('absolute')
    expect(validateConfig({ stateDir: '/tmp/x', policy: { mode: 'always' } }).problem?.error).toContain('off|observe|auto')
    expect(validateConfig({ stateDir: '/tmp/x', executor: { maxWorkers: 0 } }).problem?.error).toContain('maxWorkers')
    expect(validateConfig({ stateDir: '/tmp/x' }).config?.stateDir).toBe('/tmp/x')
  })
})
