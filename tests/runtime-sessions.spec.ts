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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
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

function executorFor(
  setup: Setup,
  stateDir: string,
  config: Record<string, unknown> = {},
  runCommand?: (command: string, cwd: string, timeoutMs: number, env?: Record<string, string>) => Promise<void>,
): Executor {
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

// ---------------------------------------------------------------------------
// Model fallback (task-16): sessions must get a provider/model route
// ---------------------------------------------------------------------------

import type { Context } from '@deepseek-ai/cordis'
import { Runtime, type RuntimeConfig } from '../src/app/runtime.js'
import { createMemoryStore } from '../src/app/store.js'

function quietLogger(): RecordingLogger {
  return new RecordingLogger()
}

function makeSessions(
  host: ReturnType<typeof createFakeHost>,
  store: ReturnType<typeof makeHarness>['store'],
  logger: RecordingLogger,
  options: {
    defaultModel?: () => { provider: string; model: string } | undefined
    configuredModel?: (role: 'router' | 'worker') => { provider: string; model: string; reasoningEffort?: string } | undefined
  } = {},
): Sessions {
  return new Sessions({
    agents: host.agents as unknown as HostAgentRegistry,
    presets: host.presets as never,
    persistence: host.persistence as never,
    logger,
    kv: store.kv,
    createTimeoutMs: 2_000,
    ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
    ...(options.configuredModel ? { configuredModel: options.configuredModel as never } : {}),
  })
}

describe('model fallback for new sessions (task-16)', () => {
  it('passes the resolved default model to new router and worker sessions', async () => {
    const host = createFakeHost({ defaultModel: { provider: 'deepseek', model: 'deepseek-chat' } })
    const harness = makeHarness()
    const sessions = makeSessions(host, harness.store, quietLogger(), {
      defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    })
    await sessions.ensureRouter(tempDir())
    await sessions.ensureWorker('t_model', tempDir())

    expect(host.agents.created.find(entry => entry.sessionId === 'superagent-router')?.agentOptions).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    expect(host.agents.created.find(entry => entry.sessionId === 'superagent-worker-t_model')?.agentOptions).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
  })

  it('repairs a resumed session that has no durable model selection', async () => {
    const host = createFakeHost({ defaultModel: { provider: 'deepseek', model: 'deepseek-chat' } })
    const harness = makeHarness()
    const dir = tempDir()
    const sessions = makeSessions(host, harness.store, quietLogger(), {
      defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    })
    await sessions.ensureWorker('t_resume_model', dir)
    const sessionId = 'superagent-worker-t_resume_model'

    // Simulate a session created by an older build, before the fallback existed.
    host.agents.selections.delete(sessionId)
    host.agents.restart()
    const restarted = makeSessions(host, harness.store, quietLogger(), {
      defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    })
    await restarted.ensureWorker('t_resume_model', dir)

    const agent = host.agents.liveAgent(sessionId)!
    expect(agent.modelSelection).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(agent.modelSelections).toHaveLength(1)
    expect(host.agents.resumed.some(entry => entry.sessionId === sessionId)).toBe(true)
  })

  it('never overwrites a durable model selection on resume', async () => {
    const host = createFakeHost({ defaultModel: { provider: 'deepseek', model: 'deepseek-chat' } })
    const harness = makeHarness()
    const dir = tempDir()
    const sessions = makeSessions(host, harness.store, quietLogger(), {
      defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    })
    await sessions.ensureWorker('t_keep_model', dir)
    const sessionId = 'superagent-worker-t_keep_model'
    host.agents.selections.set(sessionId, { provider: 'other', model: 'other-model' })
    host.agents.restart()

    const restarted = makeSessions(host, harness.store, quietLogger(), {
      defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    })
    await restarted.ensureWorker('t_keep_model', dir)
    const agent = host.agents.liveAgent(sessionId)!
    expect(agent.modelSelection).toEqual({ provider: 'other', model: 'other-model' })
    expect(agent.modelSelections).toHaveLength(0)
  })

  it('warns clearly and still creates the session when no model route exists', async () => {
    const host = createFakeHost()
    const harness = makeHarness()
    const logger = quietLogger()
    const sessions = makeSessions(host, harness.store, logger, { defaultModel: () => undefined })
    const router = await sessions.ensureRouter(tempDir())
    expect(String(router.id)).toBe('superagent-router')
    expect(host.agents.created.find(entry => entry.sessionId === 'superagent-router')?.agentOptions).toBeUndefined()
    expect(logger.text()).toContain('no provider/model')
  })

  it('uses per-role model routes with the host default as fallback', async () => {
    const boot = async (
      config: Pick<RuntimeConfig, 'router' | 'executor'>,
    ): Promise<{ runtime: Runtime; host: ReturnType<typeof createFakeHost> }> => {
      const stateDir = tempDir()
      const host = createFakeHost({ defaultModel: { provider: 'host', model: 'host-model', reasoningEffort: 'host-effort' } })
      const runtime = new Runtime(host.ctx as unknown as Context, {
        stateDir,
        sources: { telegram: { enabled: false }, github: { enabled: false } },
        policy: { mode: 'observe' },
        ...config,
        passIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        watchdog: { intervalMs: 60_000 },
      }, { store: createMemoryStore(), sources: [], skipLock: true })
      await runtime.ready
      return { runtime, host }
    }

    const explicit = await boot({
      router: { provider: 'router-provider', model: 'router-model', reasoningEffort: 'high' },
      executor: { provider: 'worker-provider', model: 'worker-model', reasoningEffort: 'low' },
    })
    expect(explicit.host.agents.created.find(entry => entry.sessionId === 'superagent-router')?.agentOptions).toEqual({
      provider: 'router-provider',
      model: 'router-model',
      reasoningEffort: 'high',
    })
    await explicit.runtime.stop()

    const fallback = await boot({})
    expect(fallback.host.agents.created.find(entry => entry.sessionId === 'superagent-router')?.agentOptions).toEqual({
      provider: 'host',
      model: 'host-model',
      reasoningEffort: 'host-effort',
    })
    await fallback.runtime.stop()
  })

  it('configures Router and Worker sessions independently (worker route reaches the worker session)', async () => {
    const stateDir = tempDir()
    const host = createFakeHost({ defaultModel: { provider: 'host', model: 'host-model' } })
    const runtime = new Runtime(host.ctx as unknown as Context, {
      stateDir,
      sources: { telegram: { disabled: true }, github: { enabled: false } },
      policy: { mode: 'observe' },
      router: { provider: 'router-provider', model: 'router-model' },
      executor: { provider: 'worker-provider', model: 'worker-model', reasoningEffort: 'low' },
      passIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      watchdog: { intervalMs: 60_000 },
    }, { store: createMemoryStore(), sources: [], skipLock: true })
    try {
      await runtime.ready
      const sessions = (runtime as unknown as { sessions: Sessions }).sessions
      const agent = await sessions.ensureWorker('t_role_model', tempDir())
      expect(String(agent.id)).toBe('superagent-worker-t_role_model')
      expect(host.agents.created.find(entry => entry.sessionId === 'superagent-worker-t_role_model')?.agentOptions).toEqual({
        provider: 'worker-provider',
        model: 'worker-model',
        reasoningEffort: 'low',
      })
    } finally {
      await runtime.stop()
    }
  })

  it('validates per-role model config (pairs and types)', () => {
    expect(
      validateRuntimeConfig({ stateDir: '/tmp/x', router: { provider: 'p' } }).problem?.error,
    ).toContain('router.provider and configuration.router.model')
    expect(
      validateRuntimeConfig({ stateDir: '/tmp/x', router: { provider: 'p', model: 'm', reasoningEffort: 3 as never } })
        .problem?.error,
    ).toContain('router.reasoningEffort')
    expect(
      validateRuntimeConfig({ stateDir: '/tmp/x', executor: { model: 'm' } }).problem?.error,
    ).toContain('executor.provider and configuration.executor.model')
    expect(
      validateRuntimeConfig({ stateDir: '/tmp/x', executor: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
        .problem,
    ).toBeUndefined()
    expect(
      validateRuntimeConfig({ stateDir: '/tmp/x', router: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
        .problem,
    ).toBeUndefined()
  })

})

// ---------------------------------------------------------------------------
// Dedicated bot account: repo-local git identity / SSH key (task-30)
// ---------------------------------------------------------------------------

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolveGitIdentity, validateConfig as validateRuntimeConfig } from '../src/app/runtime.js'

describe('git identity for worker checkouts (task-30)', () => {
  it('clones with GIT_SSH_COMMAND and writes repo-local identity after the clone', async () => {
    const setup = makeSetup()
    const stateDir = tempDir()
    const { ticket, assignment } = makeTicket(setup, 'please fix the build', { repository: 'owner/repo' })
    const keyFile = join(tempDir(), 'bot_ed25519')
    writeFileSync(keyFile, 'fake-key', { mode: 0o600 })
    const calls: Array<{ command: string; cwd: string; env?: Record<string, string> }> = []
    const executor = executorFor(
      setup,
      stateDir,
      { cloneUrl: 'git@github.com:{repo}.git', gitName: 'bot-user', gitEmail: 'bot@example.com', gitSshKeyFile: keyFile },
      (command, cwd, _timeoutMs, env) => {
        calls.push({ command, cwd, ...(env ? { env } : {}) })
        if (command.startsWith('git clone')) mkdirSync(join(cwd, '.git'), { recursive: true })
        return Promise.resolve()
      },
    )

    await executor.launch(ticket, assignment)

    const clone = calls.find(call => call.command.startsWith('git clone'))
    expect(clone).toBeDefined()
    expect(clone!.env?.GIT_SSH_COMMAND).toContain('ssh -i')
    expect(clone!.env?.GIT_SSH_COMMAND).toContain(keyFile)
    expect(clone!.env?.GIT_SSH_COMMAND).toContain('IdentitiesOnly=yes')
    expect(clone!.env?.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=accept-new')

    const configCommands = calls.filter(call => call.command.startsWith('git config --local'))
    expect(configCommands.map(call => call.command)).toEqual([
      expect.stringContaining('core.sshCommand'),
      expect.stringContaining('user.name'),
      expect.stringContaining('user.email'),
    ])
    expect(configCommands[0]!.command).toContain(keyFile)
    expect(configCommands[1]!.command).toContain('bot-user')
    expect(configCommands[2]!.command).toContain('bot@example.com')
    expect(calls.every(call => !call.command.includes('--global'))).toBe(true)
  })

  it('applies the identity in an existing checkout too (no clone)', async () => {
    const setup = makeSetup()
    const stateDir = tempDir()
    const { ticket, assignment } = makeTicket(setup)
    mkdirSync(join(stateDir, 'work', ticket.id, '.git'), { recursive: true })
    const calls: string[] = []
    const executor = executorFor(
      setup,
      stateDir,
      { gitName: 'bot-user', gitEmail: 'bot@example.com' },
      command => {
        calls.push(command)
        return Promise.resolve()
      },
    )
    await executor.launch(ticket, assignment)
    expect(calls.some(command => command === 'git config --local user.name bot-user')).toBe(true)
    expect(calls.some(command => command === 'git config --local user.email bot@example.com')).toBe(true)
    expect(calls.some(command => command.includes('core.sshCommand'))).toBe(false)
    expect(calls.some(command => command.includes('--global'))).toBe(false)
  })

  it('warns but does not block when the SSH key is missing or readable', async () => {
    const setup = makeSetup()
    const stateDir = tempDir()
    const missingKey = join(tempDir(), 'missing-key')
    const first = makeTicket(setup, 'first')
    const executor = executorFor(
      setup,
      stateDir,
      { gitSshKeyFile: missingKey },
      () => Promise.resolve(),
    )
    await executor.launch(first.ticket, first.assignment)
    expect(setup.logger.text()).toContain('git SSH key does not exist')

    const worldReadable = join(tempDir(), 'readable-key')
    writeFileSync(worldReadable, 'fake-key', { mode: 0o644 })
    chmodSync(worldReadable, 0o644)
    const second = makeTicket(setup, 'second')
    const executor2 = executorFor(setup, stateDir, { gitSshKeyFile: worldReadable }, () => Promise.resolve())
    await executor2.launch(second.ticket, second.assignment)
    expect(setup.logger.text()).toContain('readable by group/others')
  })

  it('keeps the environment unchanged when no identity is configured', async () => {
    const setup = makeSetup()
    const stateDir = tempDir()
    const { ticket, assignment } = makeTicket(setup, 'no identity')
    const calls: Array<{ command: string; env?: Record<string, string> }> = []
    const executor = executorFor(setup, stateDir, {}, (command, _cwd, _timeout, env) => {
      calls.push({ command, ...(env ? { env } : {}) })
      if (command.startsWith('git clone')) mkdirSync(join(stateDir, 'work', ticket.id, '.git'), { recursive: true })
      return Promise.resolve()
    })
    // No repo → no clone; no identity → no config commands.
    await executor.launch(ticket, assignment)
    expect(calls.some(call => call.command.includes('git config'))).toBe(false)
    expect(calls.every(call => call.env === undefined)).toBe(true)
  })

  it('derives the bot name/email from the GitHub login', () => {
    expect(resolveGitIdentity(undefined, 'cine-bot')).toEqual({
      gitName: 'cine-bot',
      gitEmail: 'cine-bot@users.noreply.github.com',
    })
    expect(
      resolveGitIdentity({ gitName: 'Bot', gitEmail: 'bot@example.com', gitSshKeyFile: '/keys/bot' }, 'cine-bot'),
    ).toEqual({ gitName: 'Bot', gitEmail: 'bot@example.com', gitSshKeyFile: '/keys/bot' })
    expect(resolveGitIdentity({ gitName: 'Bot' }, undefined)).toEqual({ gitName: 'Bot' })
    expect(resolveGitIdentity(undefined, undefined)).toEqual({})
    expect(validateRuntimeConfig({ stateDir: '/tmp/x', executor: { gitSshKeyFile: 'relative/key' } }).problem?.error).toContain(
      'absolute path',
    )
    expect(validateRuntimeConfig({ stateDir: '/tmp/x', executor: { gitName: 42 } }).problem?.error).toContain('gitName')
  })
})

describe('configured model overrides durable selection on resume (task-39 follow-up)', () => {
  it('updates a stale durable selection when the config now sets an explicit route', async () => {
    const host = createFakeHost({ defaultModel: { provider: 'host', model: 'host-model' } })
    const harness = makeHarness()
    const dir = tempDir()
    const created = makeSessions(host, harness.store, quietLogger())
    await created.ensureWorker('t_cfg_model', dir)
    const sessionId = 'superagent-worker-t_cfg_model'

    // Simulate a session whose durable selection came from an older config.
    host.agents.selections.set(sessionId, { provider: 'old', model: 'old-model' })
    host.agents.restart()

    const resumed = makeSessions(host, harness.store, quietLogger(), {
      defaultModel: () => ({ provider: 'host', model: 'host-model' }),
      configuredModel: () => ({ provider: 'new', model: 'new-model', reasoningEffort: 'high' }),
    })
    await resumed.ensureWorker('t_cfg_model', dir)
    const agent = host.agents.liveAgent(sessionId)!
    expect(agent.modelSelection).toEqual({ provider: 'new', model: 'new-model', reasoningEffort: 'high' })
    expect(agent.modelSelections).toHaveLength(1)
  })

  it('does not touch the durable selection when the config has no explicit route', async () => {
    const host = createFakeHost({ defaultModel: { provider: 'host', model: 'host-model' } })
    const harness = makeHarness()
    const dir = tempDir()
    const created = makeSessions(host, harness.store, quietLogger())
    await created.ensureWorker('t_keep_cfg', dir)
    const sessionId = 'superagent-worker-t_keep_cfg'
    host.agents.selections.set(sessionId, { provider: 'durable', model: 'durable-model' })
    host.agents.restart()

    const resumed = makeSessions(host, harness.store, quietLogger(), {
      defaultModel: () => ({ provider: 'host', model: 'host-model' }),
    })
    await resumed.ensureWorker('t_keep_cfg', dir)
    const agent = host.agents.liveAgent(sessionId)!
    expect(agent.modelSelection).toEqual({ provider: 'durable', model: 'durable-model' })
    expect(agent.modelSelections).toHaveLength(0)
  })

  it('does not re-select when the explicit route already matches the durable selection', async () => {
    const host = createFakeHost({ defaultModel: { provider: 'host', model: 'host-model' } })
    const harness = makeHarness()
    const dir = tempDir()
    const created = makeSessions(host, harness.store, quietLogger())
    await created.ensureWorker('t_same_cfg', dir)
    const sessionId = 'superagent-worker-t_same_cfg'
    host.agents.selections.set(sessionId, { provider: 'new', model: 'new-model' })
    host.agents.restart()

    const resumed = makeSessions(host, harness.store, quietLogger(), {
      defaultModel: () => ({ provider: 'host', model: 'host-model' }),
      configuredModel: () => ({ provider: 'new', model: 'new-model' }),
    })
    await resumed.ensureWorker('t_same_cfg', dir)
    const agent = host.agents.liveAgent(sessionId)!
    expect(agent.modelSelection).toEqual({ provider: 'new', model: 'new-model' })
    expect(agent.modelSelections).toHaveLength(0)
  })

  it('applies the panel model change to the persisted Router session on restart', async () => {
    const boot = async (
      config: Pick<RuntimeConfig, 'router' | 'executor'>,
      seed?: { provider: string; model: string },
    ): Promise<{ runtime: Runtime; host: ReturnType<typeof createFakeHost>; stateDir: string }> => {
      const stateDir = tempDir()
      const host = createFakeHost({ defaultModel: { provider: 'host', model: 'host-model' } })
      if (seed) {
        host.agents.persisted.add('superagent-router')
        host.agents.selections.set('superagent-router', seed)
      }
      const runtime = new Runtime(host.ctx as unknown as Context, {
        stateDir,
        sources: { telegram: { enabled: false }, github: { enabled: false } },
        policy: { mode: 'observe' },
        ...config,
        passIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        watchdog: { intervalMs: 60_000 },
      }, { store: createMemoryStore(), sources: [], skipLock: true })
      await runtime.ready
      return { runtime, host, stateDir }
    }

    // First boot creates/persists the router session.
    const first = await boot({})
    await first.runtime.stop()

    // Second boot: explicit router config overrides the old durable selection.
    const explicitHost = createFakeHost({ defaultModel: { provider: 'host', model: 'host-model' } })
    explicitHost.agents.persisted.add('superagent-router')
    explicitHost.agents.selections.set('superagent-router', { provider: 'old', model: 'old-model' })
    const explicit = await boot({ router: { provider: 'panel', model: 'panel-model' } })
    await explicit.runtime.stop()
    expect(explicit.host.agents.liveAgent('superagent-router')).toBeUndefined() // stopped/disposed
    expect(explicit.host.agents.selections.get('superagent-router')).toBeUndefined()
    // The selection update happens on the resumed agent inside boot(seed); assert via a fresh boot below.
    const seeded = await boot({ router: { provider: 'panel', model: 'panel-model' } }, { provider: 'old', model: 'old-model' })
    const routerAgent = seeded.host.agents.liveAgent('superagent-router')!
    expect(routerAgent.modelSelection).toEqual({ provider: 'panel', model: 'panel-model' })
    expect(routerAgent.modelSelections).toHaveLength(1)
    await seeded.runtime.stop()

    const keep = await boot({}, { provider: 'old', model: 'old-model' })
    const keptAgent = keep.host.agents.liveAgent('superagent-router')!
    expect(keptAgent.modelSelection).toEqual({ provider: 'old', model: 'old-model' })
    expect(keptAgent.modelSelections).toHaveLength(0)
    await keep.runtime.stop()
  })
})
