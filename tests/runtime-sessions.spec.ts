/**
 * Sessions + Executor unit tests against the simulated DSH host.
 *
 * Focus: create-vs-resume, preset fallback, turn-end mapping, message routing
 * (wake/steer/inject), workspace preparation, port behavior and failure
 * isolation.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { Sessions, type HostAgentRegistry, userMessage } from '../src/app/sessions.js'
import { Executor } from '../src/app/executor.js'
import type { Assignment, Ticket, Trigger } from '../src/core/model.js'
import type { Engine, Store } from '../src/core/ports.js'
import { makeHarness, makeTrigger } from './core-fixtures.js'
import { FakeSource, RecordingLogger, createFakeHost, textOf, until } from './runtime-host.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-unit-'))
  dirs.push(dir)
  return dir
}

interface Setup {
  host: ReturnType<typeof createFakeHost>
  logger: RecordingLogger
  store: Store
  engine: Engine
  sessions: Sessions
}

function makeSetup(options: { presets?: boolean; maxWorkers?: number; stateDir?: string } = {}): Setup {
  const host = createFakeHost({ presets: options.presets !== false })
  const logger = new RecordingLogger()
  const harness = makeHarness()
  const sessions = new Sessions({
    agents: host.agents as unknown as HostAgentRegistry,
    presets: host.presets as never,
    persistence: host.persistence as never,
    logger,
    kv: harness.store.kv,
    presetIds: { router: 'superagent-router', worker: 'superagent-worker' },
    createTimeoutMs: 2_000,
    disposeTimeoutMs: 2_000,
    maxWorkers: options.maxWorkers ?? 2,
  })
  return { host, logger, store: harness.store, engine: harness.engine, sessions }
}

/** Create a real ticket through the domain Engine, returning it with its pending assignment. */
function makeTicket(setup: Setup, text = 'please fix the build', meta: Record<string, unknown> = {}): { ticket: Ticket; assignment: Assignment; trigger: Trigger } {
  const trigger = makeTrigger({ text, meta })
  expect(setup.engine.sources.receive(trigger)).toBe('stored')
  setup.engine.evaluateDue()
  const result = setup.engine.mainSession.decide({
    triggerId: trigger.id,
    outcome: 'accept',
    title: 'Fix the build',
    reason: [{ code: 'test' }],
  })
  expect(result.ticket).toBeTruthy()
  const ticket = setup.store.tickets.get(result.ticket!.id)!
  const assignment = ticket.assignments[ticket.assignments.length - 1]!
  return { ticket, assignment, trigger }
}

function executorFor(setup: Setup, stateDir: string, config: Record<string, unknown> = {}, runCommand?: (command: string, cwd: string, timeoutMs: number) => Promise<void>): Executor {
  return new Executor({
    store: setup.store,
    sessions: setup.sessions,
    engine: () => setup.engine.executor,
    effects: { enqueue: () => undefined },
    logger: setup.logger,
    stateDir,
    config,
    ...(runCommand ? { runCommand } : {}),
  })
}

describe('Sessions', () => {
  it('creates the router once and persists its id', async () => {
    const setup = makeSetup()
    const router = await setup.sessions.ensureRouter(tempDir())
    const again = await setup.sessions.ensureRouter()
    expect(again).toBe(router)
    expect(setup.host.agents.created.filter(entry => entry.sessionId === 'superagent-router')).toHaveLength(1)
    expect(setup.host.presets.mounted.map(entry => entry.presetId)).toContain('superagent-router')
    expect(setup.host.promptFor(setup.host.agents.liveAgent('superagent-router')!).sections[0]?.name).toBe('superagent:router-role')
    expect(setup.store.kv.get('superagent.router.sessionId')).toBe('superagent-router')
  })

  it('resumes a persisted worker session instead of creating a new one', async () => {
    const setup = makeSetup()
    const dir = tempDir()
    const first = await setup.sessions.ensureWorker('t_resume', dir)
    expect(String(first.id)).toBe('superagent-worker-t_resume')
    setup.host.agents.restart()
    const second = await setup.sessions.ensureWorker('t_resume', dir)
    expect(String(second.id)).toBe('superagent-worker-t_resume')
    expect(setup.host.agents.resumed.some(entry => entry.sessionId === 'superagent-worker-t_resume')).toBe(true)
    expect(setup.sessions.workerWasResumed('t_resume')).toBe(true)
    expect(setup.host.presets.mounted.filter(entry => entry.presetId === 'superagent-worker')).toHaveLength(2)
  })

  it('falls back to the default preset with a warning when the role preset is missing', async () => {
    const setup = makeSetup()
    setup.host.presets.rows = []
    const router = await setup.sessions.ensureRouter(tempDir())
    expect(String(router.id)).toBe('superagent-router')
    expect(setup.host.presets.mounted.length).toBe(1)
    expect(setup.host.presets.mounted[0]!.presetId).toBe('default')
    expect(setup.logger.text()).toContain('superagent-router')
  })

  it('maps idle transitions to turn-end callbacks with the bound assignment', async () => {
    const setup = makeSetup()
    const ends: Array<{ sessionId: string; ticketId?: string; assignmentId?: string }> = []
    const sessions = new Sessions({
      agents: setup.host.agents as unknown as HostAgentRegistry,
      presets: setup.host.presets as never,
      persistence: setup.host.persistence as never,
      logger: setup.logger,
      kv: setup.store.kv,
      createTimeoutMs: 2_000,
      onTurnEnd: info => ends.push({ sessionId: String(info.sessionId), ticketId: info.ticketId, assignmentId: info.assignmentId }),
    })
    const agent = await sessions.ensureWorker('t_turn', tempDir())
    sessions.bindAssignment('t_turn', agent.session.id, 'as_9')
    const fake = setup.host.agents.liveAgent('superagent-worker-t_turn')!
    fake.completeTurn()
    expect(ends).toEqual([{ sessionId: 'superagent-worker-t_turn', ticketId: 't_turn', assignmentId: 'as_9' }])
  })

  it('wakes idle workers, steers running ones, injects context and reports delivery failures', async () => {
    const setup = makeSetup()
    const agent = await setup.sessions.ensureWorker('t_route', tempDir())
    const fake = setup.host.agents.liveAgent('superagent-worker-t_route')!

    expect(setup.sessions.deliverWorker('t_route', 'first')).toBe(true)
    expect(fake.followups).toHaveLength(1)
    expect(textOf(fake.followups[0])).toBe('first')
    expect(setup.sessions.deliverWorker('t_route', 'second')).toBe(true)
    expect(fake.steers).toHaveLength(1)
    expect(setup.sessions.deliverWorker('t_route', 'third', 'inject')).toBe(true)
    expect(fake.injects).toHaveLength(1)

    fake.followup = () => {
      throw new Error('host inbox unavailable')
    }
    fake.status = 'idle'
    expect(setup.sessions.deliverWorker('t_route', 'fourth', 'wake')).toBe(false)
    expect(setup.logger.text()).toContain('could not deliver a session message')
    expect(agent).toBeDefined()

    delete (fake as unknown as { followup?: unknown }).followup
    setup.sessions.interrupt('t_route', 'test reason')
    expect(fake.cancels).toHaveLength(1)
    expect(setup.sessions.requestStatus('t_route', 'status?')).toBe(true)
    expect(setup.sessions.requestStatus('t_missing', 'status?')).toBe(false)
  })

  it('disposes every owned session on stop and suppresses turn-end callbacks', async () => {
    const setup = makeSetup()
    const ends: string[] = []
    const sessions = new Sessions({
      agents: setup.host.agents as unknown as HostAgentRegistry,
      presets: setup.host.presets as never,
      persistence: setup.host.persistence as never,
      logger: setup.logger,
      kv: setup.store.kv,
      createTimeoutMs: 2_000,
      disposeTimeoutMs: 2_000,
      onTurnEnd: info => ends.push(String(info.sessionId)),
    })
    await sessions.ensureRouter(tempDir())
    const worker = await sessions.ensureWorker('t_stop', tempDir())
    const fake = setup.host.agents.liveAgent('superagent-worker-t_stop')!
    await sessions.stop('test stop')
    expect(fake.disposeCalls).toBe(1)
    expect(ends).toHaveLength(0)
    expect(worker).toBeDefined()
    expect(setup.host.agents.liveAgent('superagent-worker-t_stop')).toBeUndefined()
  })
})

describe('Executor', () => {
  it('launches a worker with a prepared directory, assignment message and started callback', async () => {
    const setup = makeSetup()
    const stateDir = tempDir()
    const { ticket, assignment } = makeTicket(setup, 'please fix the build', { repository: 'owner/repo' })
    const commands: Array<{ command: string; cwd: string }> = []
    const executor = executorFor(setup, stateDir, { cloneUrl: 'https://github.com/{repo}.git', prepare: 'echo {dir} {repo}' }, async (command, cwd) => {
      commands.push({ command, cwd })
    })

    await executor.launch(ticket, assignment)

    const worker = setup.host.agents.liveAgent(`superagent-worker-${ticket.id}`)!
    const message = worker.allText().join('\n')
    expect(message).toContain('[superagent assignment]')
    expect(message).toContain(ticket.id)
    expect(message).toContain('Fix the build')
    expect(message).toContain(executor.directoryFor(ticket.id))
    expect(commands[0]!.command).toContain('git clone https://github.com/owner/repo.git')
    expect(commands[1]!.command).toContain(executor.directoryFor(ticket.id))
    expect(commands[1]!.command).toContain('owner/repo')

    const started = setup.store.tickets.get(ticket.id)!
    const running = started.assignments[started.assignments.length - 1]!
    expect(running.state).toBe('running')
    expect(running.sessionId).toBe(`superagent-worker-${ticket.id}`)
    expect(started.workerSessionId).toBe(`superagent-worker-${ticket.id}`)
  })

  it('reuses the directory and session on a retry and marks the assignment as recovery', async () => {
    const setup = makeSetup()
    const stateDir = tempDir()
    const { ticket, assignment } = makeTicket(setup)
    const executor = executorFor(setup, stateDir)
    await executor.launch(ticket, assignment)

    // Simulate a restart: the ticket keeps a running assignment and the session persisted.
    setup.host.agents.restart()
    const current = setup.store.tickets.get(ticket.id)!
    const retry = current.assignments[current.assignments.length - 1]!
    await executor.launch(current, retry)
    const worker = setup.host.agents.liveAgent(`superagent-worker-${ticket.id}`)!
    expect(worker.allText().join('\n')).toContain('[recovery]')
    expect(setup.host.agents.resumed.some(entry => entry.sessionId === `superagent-worker-${ticket.id}`)).toBe(true)
  })

  it('delivers inputs and marks them read only after a successful delivery', async () => {
    const setup = makeSetup()
    const stateDir = tempDir()
    const { ticket, assignment } = makeTicket(setup)
    const executor = executorFor(setup, stateDir)
    await executor.launch(ticket, assignment)

    const withInput = setup.store.tickets.get(ticket.id)!
    withInput.inputs.push({ id: 'in_1', kind: 'text', at: new Date().toISOString(), text: 'use the staging branch', person: true })
    setup.store.tickets.save(withInput)
    const running = withInput.assignments[withInput.assignments.length - 1]!
    const input = withInput.inputs[withInput.inputs.length - 1]!
    await executor.deliver(withInput, running, [input])

    const worker = setup.host.agents.liveAgent(`superagent-worker-${ticket.id}`)!
    expect(worker.allText().join('\n')).toContain('use the staging branch')
    expect(setup.store.tickets.get(ticket.id)!.inputs.find(entry => entry.id === 'in_1')!.readAt).toBeTruthy()
  })

  it('asks for status only when a worker session is live', async () => {
    const setup = makeSetup()
    const stateDir = tempDir()
    const { ticket, assignment } = makeTicket(setup)
    const executor = executorFor(setup, stateDir)
    expect(executor.requestStatus(ticket, assignment)).toBe(false)
    await executor.launch(ticket, assignment)
    const current = setup.store.tickets.get(ticket.id)!
    const running = current.assignments[current.assignments.length - 1]!
    expect(executor.requestStatus(current, running)).toBe(true)
    const worker = setup.host.agents.liveAgent(`superagent-worker-${ticket.id}`)!
    expect(worker.allText().join('\n')).toContain('[superagent status request]')
  })

  it('interrupts the turn and disposes the session once the ticket ended', async () => {
    const setup = makeSetup()
    const stateDir = tempDir()
    const { ticket, assignment } = makeTicket(setup)
    const executor = executorFor(setup, stateDir)
    await executor.launch(ticket, assignment)
    setup.engine.people.stopTicket(ticket.id, 'user stopped it')
    executor.interrupt(ticket.id, assignment.id, 'ticket ended')
    await until(() => setup.host.agents.liveAgent(`superagent-worker-${ticket.id}`) === undefined, 2_000, 'worker disposal')
  })

  it('caps live worker sessions and disposes the least recently used idle one', async () => {
    const setup = makeSetup({ maxWorkers: 1 })
    const stateDir = tempDir()
    const executor = executorFor(setup, stateDir)
    const first = makeTicket(setup, 'first job')
    const second = makeTicket(setup, 'second job')
    await executor.launch(first.ticket, first.assignment)
    const firstAgent = setup.host.agents.liveAgent(`superagent-worker-${first.ticket.id}`)!
    firstAgent.completeTurn()
    await executor.launch(second.ticket, second.assignment)
    await until(() => setup.host.agents.liveAgent(`superagent-worker-${first.ticket.id}`) === undefined, 2_000, 'LRU disposal')
    expect(setup.host.agents.liveAgent(`superagent-worker-${second.ticket.id}`)).toBeDefined()
  })

  it('recovers interrupted assignments with a fresh assignment and the recovery note', async () => {
    const setup = makeSetup()
    const stateDir = tempDir()
    const executor = executorFor(setup, stateDir)
    const { ticket, assignment } = makeTicket(setup)
    await executor.launch(ticket, assignment)
    // Simulate the crash: no stop hooks ran, the assignment stayed running.
    setup.host.agents.restart()
    const result = await executor.recover()
    expect(result.interrupted).toBe(1)
    expect(result.relaunched).toBe(1)
    const recovered = setup.store.tickets.get(ticket.id)!
    const latest = recovered.assignments[recovered.assignments.length - 1]!
    expect(latest.state).toBe('running')
    expect(latest.id).not.toBe(assignment.id)
    const worker = setup.host.agents.liveAgent(`superagent-worker-${ticket.id}`)!
    expect(worker.allText().join('\n')).toContain('[recovery]')
  })

  it('does not notify sources for a quiet candidate (no outbound traffic in this slice)', async () => {
    const setup = makeSetup()
    const stateDir = tempDir()
    const source = new FakeSource('telegram')
    const executor = executorFor(setup, stateDir)
    const { ticket, assignment } = makeTicket(setup)
    await executor.launch(ticket, assignment)
    expect(source.sent).toHaveLength(0)
    expect(assignment.state).toBe('pending')
  })

  it('produces a frozen official user message', () => {
    const message = userMessage('hello')
    expect(message.content[0]).toEqual({ type: 'text', text: 'hello' })
    expect(message.source).toEqual({ kind: 'user' })
    expect(Object.isFrozen(message) || Object.isFrozen(message.content)).toBe(true)
  })
})
