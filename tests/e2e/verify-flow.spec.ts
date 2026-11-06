/**
 * End-to-end verification of the assembled system against REAL protocol peers.
 *
 * Unlike `tests/runtime-e2e.spec.ts` (which uses a `FakeSource` double), this
 * suite runs the production Telegram and GitHub Sources against local fake
 * HTTP servers + the simulated DSH host, a real SQLite store and the real
 * Engine/Outbox/Effects. It asserts the externally observable behaviour the
 * user asked for:
 *
 *  1. Telegram message → candidate in the Router → accept → worker session →
 *     `ready` report → exactly ONE short outbound Telegram message; a
 *     `progress` report produces NO outbound message (quiet policy).
 *  2. GitHub mention comment → candidate → accept → worker `ready` with a PR →
 *     exactly ONE outbound issue comment (with the idempotency marker).
 *  3. `observe` mode: an inferred bot candidate is recorded as `would_accept`
 *     and nothing is launched or sent.
 *  4. A host restart resumes an interrupted Assignment from the SQLite file
 *     and the worker receives the recovery instructions.
 *
 * Everything is offline: tokens are fake strings in temp files, servers bind
 * 127.0.0.1 only, and every temp dir is removed afterwards.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import { Runtime, type RuntimeConfig } from '../../src/app/runtime.js'
import { openStore, type SqliteStore } from '../../src/app/store.js'
import { createSource as createGithubSource } from '../../src/sources/github.js'
import { createSource as createTelegramSource } from '../../src/sources/telegram.js'
import type { Source, SourceContext } from '../../src/sources/kind.js'
import { makeTrigger } from '../core-fixtures.js'
import { createFakeHost, until, type FakeAgent, type FakeHost } from '../runtime-host.js'
import {
  startFakeGithub,
  startFakeTelegram,
  type FakeGithub,
  type FakeTelegram,
  type TelegramUpdate,
} from './fake-services.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const TELEGRAM_TOKEN = '123456789:TEST-TOKEN-not-a-real-secret'
const GITHUB_TOKEN = 'ghp_TESTTOKENnotarealsecret0000000000'
const CLEANUPS: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of CLEANUPS.splice(0).reverse()) {
    try {
      await cleanup()
    } catch {
      // keep the suite green; cleanup is best effort
    }
  }
})

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface Harness {
  stateDir: string
  host: FakeHost
  store: SqliteStore
  runtime: Runtime
  telegram?: FakeTelegram
  github?: FakeGithub
  /** The real Source instances, for forcing one deterministic poll round. */
  sources: Record<string, Source>
  /** Run engine passes + the effect pump until `condition` holds. */
  settle(condition: () => boolean, label: string, timeoutMs?: number): Promise<void>
}

interface HarnessOptions {
  policyMode?: 'off' | 'observe' | 'auto'
  telegram?: { updates: TelegramUpdate[] }
  github?: { comments: Array<Parameters<FakeGithub['seedComment']>[0]> }
  githubBots?: string[]
}

function writeTokenFile(dir: string, name: string, token: string): string {
  const tokens = join(dir, 'tokens')
  mkdirSync(tokens, { recursive: true, mode: 0o700 })
  const file = join(tokens, name)
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  return file
}

async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-e2e-'))
  const host = createFakeHost()
  const store = openStore({ stateDir })
  const cleanups: Array<() => Promise<void> | void> = [
    () => store.close(),
    () => rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
  ]
  CLEANUPS.push(async () => {
    for (const run of cleanups.reverse()) await run()
  })

  let telegram: FakeTelegram | undefined
  let github: FakeGithub | undefined
  const sources: Array<{ id: string; source: Source }> = []
  const sourcesById: Record<string, Source> = {}
  let runtime: Runtime | undefined

  const sourceContext = (id: string): SourceContext => ({
    id,
    stateDir,
    now: () => new Date().toISOString(),
    newId: prefix => `${prefix}_${Math.random().toString(36).slice(2, 8)}`,
    receive: trigger => {
      try {
        return runtime?.enginePort?.sources.receive(trigger) ?? 'filtered'
      } catch {
        return 'filtered'
      }
    },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    health: () => undefined,
    kv: store.kv,
  })

  if (options.telegram !== undefined) {
    telegram = await startFakeTelegram(TELEGRAM_TOKEN)
    cleanups.push(() => telegram!.close())
    for (const update of options.telegram.updates) telegram.pushUpdate(update)
    const tokenFile = writeTokenFile(stateDir, 'telegram.token', TELEGRAM_TOKEN)
    const telegramSource = createTelegramSource(
      {
        apiBaseUrl: telegram.url,
        tokenFile,
        allowedUserIds: ['42'],
        pollTimeoutSeconds: 0,
        pollSeconds: 0.01,
      },
      sourceContext('telegram'),
    )
    sources.push({ id: 'telegram', source: telegramSource })
    sourcesById.telegram = telegramSource
  }

  if (options.github !== undefined) {
    github = await startFakeGithub()
    cleanups.push(() => github!.close())
    for (const comment of options.github.comments) github.seedComment(comment)
    const tokenFile = writeTokenFile(stateDir, 'github.token', GITHUB_TOKEN)
    const githubSource = createGithubSource(
      {
        apiBaseUrl: github.url,
        tokenFile,
        repositories: ['owner/repo'],
        login: 'sa-agent',
        observeComments: false,
        pollSeconds: 10,
      },
      sourceContext('github'),
    )
    sources.push({ id: 'github', source: githubSource })
    sourcesById.github = githubSource
  }

  const config: RuntimeConfig = {
    stateDir,
    sources: {
      // Keep the runtime from creating its own Sources; the policy still comes
      // from these blocks (allowlists, bot list, repositories).
      telegram: { enabled: false, allowedUserIds: ['42'] },
      github: {
        enabled: false,
        login: 'sa-agent',
        allowedLogins: ['owner'],
        repositories: ['owner/repo'],
        ...(options.githubBots ? { botLogins: options.githubBots } : {}),
      },
    },
    policy: { mode: options.policyMode ?? 'auto' },
    executor: { clone: false, maxWorkers: 2 },
    passIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    watchdog: { intervalMs: 60_000, stallMs: 60_000, escalateMs: 60_000 },
  }

  runtime = new Runtime(host.ctx as unknown as Context, config, {
    store,
    sources,
    skipLock: true,
  })
  await runtime.ready
  CLEANUPS.push(() => runtime!.stop())

  const settle = async (condition: () => boolean, label: string, timeoutMs = 6_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await runtime!.pass('e2e')
      await runtime!.pumpEffects()
      if (condition()) return
      await sleep(15)
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  return {
    stateDir,
    host,
    store,
    runtime,
    sources: sourcesById,
    ...(telegram ? { telegram } : {}),
    ...(github ? { github } : {}),
    settle,
  }
}

function routerAgent(harness: Harness): FakeAgent {
  const agent = harness.host.agents.liveAgent('superagent-router')
  if (!agent) throw new Error('router session was not created')
  return agent
}

function workerAgent(harness: Harness, ticketId: string): FakeAgent {
  const agent = harness.host.agents.liveAgent(`superagent-worker-${ticketId}`)
  if (!agent) throw new Error(`worker session for ${ticketId} was not created`)
  return agent
}

async function acceptCandidate(harness: Harness, triggerId: string, title: string): Promise<string> {
  const result = (await harness.host.executeTool(routerAgent(harness), 'superagent_route', {
    triggerId,
    outcome: 'accept',
    title,
  })).value as { ok?: boolean; ticketId?: string }
  if (!result.ok || !result.ticketId) throw new Error(`accept failed: ${JSON.stringify(result)}`)
  await harness.settle(
    () => harness.host.agents.liveAgent(`superagent-worker-${result.ticketId}`) !== undefined,
    'worker session launch',
  )
  return result.ticketId
}

function addTelegramMessage(text: string, options: { id?: number; userId?: number; chatId?: number } = {}) {
  return {
    update_id: 5_000 + (options.id ?? 1),
    message: {
      message_id: options.id ?? 1,
      date: Math.floor(Date.now() / 1_000),
      from: { id: options.userId ?? 42, is_bot: false, first_name: 'Owner' },
      chat: { id: options.chatId ?? 42, type: 'private' },
      text,
    },
  }
}

function githubComment(body: string, options: { id?: number; login?: string } = {}) {
  const at = new Date().toISOString()
  return {
    id: options.id ?? 900,
    body,
    user: { login: options.login ?? 'owner', id: 2, type: options.login === undefined ? 'User' : 'Bot' },
    created_at: at,
    updated_at: at,
    issue_url: 'https://api.github.com/repos/owner/repo/issues/1',
    html_url: 'https://github.com/owner/repo/issues/1#issuecomment-900',
  }
}

// ---------------------------------------------------------------------------
// Telegram: message → candidate → accept → worker → one quiet-aware reply
// ---------------------------------------------------------------------------

describe('telegram end to end (real source + fake Bot API)', () => {
  it('accepts a message, stays quiet for progress and sends exactly one ready message', async () => {
    const harness = await startHarness({ telegram: { updates: [addTelegramMessage('please fix the failing test')] } })

    // The real long-poll loop stored the message as a Trigger in the Thread.
    await until(
      () => harness.store.read.threadTriggers('telegram:dm:42').length > 0,
      6_000,
      'telegram trigger stored',
    )
    const trigger = harness.store.read.threadTriggers('telegram:dm:42')[0]!
    expect(trigger.source).toBe('telegram')
    expect(trigger.addressed).toBe('direct')
    expect(trigger.actor.id).toBe('42')

    // Engine pass + assessment effect deliver the structured candidate.
    await harness.settle(
      () => routerAgent(harness).allText().join('\n').includes('[superagent candidate]'),
      'candidate delivered to the router',
    )
    const candidateText = routerAgent(harness).allText().join('\n')
    expect(candidateText).toContain(trigger.id)
    expect(candidateText).toContain('please fix the failing test')

    const ticketId = await acceptCandidate(harness, trigger.id, 'Fix the failing test')
    const worker = workerAgent(harness, ticketId)
    expect(worker.allText().join('\n')).toContain('[superagent assignment]')

    // Quiet policy: a progress report is recorded and produces NO outbound write.
    const progress = (await harness.host.executeTool(worker, 'superagent_report', {
      kind: 'progress',
      summary: 'the failing test is reproduced',
    })).value as { ok?: boolean }
    expect(progress.ok).toBe(true)
    await harness.runtime.pumpEffects()
    expect(harness.telegram!.sent).toHaveLength(0)

    // ready wakes the user with exactly one short message.
    await harness.host.executeTool(worker, 'superagent_report', {
      kind: 'ready',
      summary: 'fix committed and PR opened',
      prUrl: 'https://github.com/owner/repo/pull/7',
    })
    await harness.settle(() => harness.telegram!.sent.length > 0, 'ready attention message')

    expect(harness.telegram!.sent).toHaveLength(1)
    const sent = harness.telegram!.sent[0]!
    expect(String(sent.text)).toContain('fix committed and PR opened')
    expect(String(sent.text)).toContain('pull/7')
    expect(String(sent.text).length).toBeLessThanOrEqual(200)
    expect(sent.chat_id).toBe(42)

    // A further pump/round must not duplicate the message.
    await harness.runtime.pumpEffects()
    await sleep(60)
    expect(harness.telegram!.sent).toHaveLength(1)

    // The ticket is terminal and carries the report.
    const ticket = harness.store.tickets.get(ticketId)!
    expect(ticket.latestReport?.kind).toBe('ready')
    expect(ticket.latestReport?.pullRequest?.number).toBe(7)
  })

  it('turns a blocked report into one attention message and no progress noise', async () => {
    const harness = await startHarness({ telegram: { updates: [addTelegramMessage('migrate the database')] } })
    await until(() => harness.store.read.threadTriggers('telegram:dm:42').length > 0, 6_000, 'telegram trigger stored')
    const trigger = harness.store.read.threadTriggers('telegram:dm:42')[0]!
    await harness.settle(() => routerAgent(harness).allText().join('\n').includes('[superagent candidate]'), 'candidate')

    const ticketId = await acceptCandidate(harness, trigger.id, 'Migrate the database')
    const worker = workerAgent(harness, ticketId)
    await harness.host.executeTool(worker, 'superagent_report', {
      kind: 'blocked',
      summary: 'need a decision',
      question: 'Should I drop the legacy column?',
    })
    await harness.settle(() => harness.telegram!.sent.length > 0, 'blocked attention message')
    expect(harness.telegram!.sent).toHaveLength(1)
    expect(String(harness.telegram!.sent[0]!.text)).toContain('Should I drop the legacy column?')
    expect(harness.store.tickets.get(ticketId)!.waitingForPerson).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// GitHub: mention comment → candidate → accept → one outbound issue comment
// ---------------------------------------------------------------------------

describe('github end to end (real source + fake REST API)', () => {
  it('accepts a mention comment and posts exactly one PR-ready comment', async () => {
    const harness = await startHarness({
      github: { comments: [githubComment('@sa-agent please fix the build')] },
    })

    await until(
      () => harness.store.read.threadTriggers('github:owner/repo#1').length > 0,
      6_000,
      'github comment trigger stored',
    )
    const trigger = harness.store.read.threadTriggers('github:owner/repo#1')[0]!
    expect(trigger.source).toBe('github')
    expect(trigger.addressed).toBe('mention')
    expect(trigger.actor.id).toBe('owner')

    await harness.settle(() => routerAgent(harness).allText().join('\n').includes('[superagent candidate]'), 'candidate')
    const ticketId = await acceptCandidate(harness, trigger.id, 'Fix the build')
    const worker = workerAgent(harness, ticketId)

    // progress: no outbound GitHub write
    await harness.host.executeTool(worker, 'superagent_report', { kind: 'progress', summary: 'working on it' })
    await harness.runtime.pumpEffects()
    expect(harness.github!.postedComments).toHaveLength(0)

    await harness.host.executeTool(worker, 'superagent_report', {
      kind: 'ready',
      summary: 'build fixed',
      prUrl: 'https://github.com/owner/repo/pull/12',
    })
    await harness.settle(() => harness.github!.postedComments.length > 0, 'outbound issue comment')

    expect(harness.github!.postedComments).toHaveLength(1)
    const body = String(harness.github!.postedComments[0]!.body)
    expect(body).toContain('build fixed')
    expect(body).toContain('pull/12')
    // Idempotency marker makes a crash-and-retry safe on the GitHub side.
    expect(body).toContain('<!-- superagent:msg_')
    expect(harness.github!.postedComments).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Observe mode
// ---------------------------------------------------------------------------

describe('observe mode', () => {
  it('records would_accept for an inferred bot candidate without a ticket or a message', async () => {
    const harness = await startHarness({ policyMode: 'observe', githubBots: ['ci-bot[bot]'] })
    const trigger = makeTrigger({
      id: 'tr_observe_1',
      source: 'github',
      threadKey: 'github:owner/repo#2',
      kind: 'comment',
      addressed: 'none',
      actorId: 'ci-bot[bot]',
      bot: true,
      text: 'CI failed on main',
      meta: { repo: 'owner/repo', number: 2 },
    })
    trigger.channel = { source: 'github', thread: trigger.thread.key, to: 'owner/repo#2' }

    expect(harness.runtime.enginePort!.sources.receive(trigger)).toBe('stored')
    await harness.settle(
      () => routerAgent(harness).allText().join('\n').includes('[superagent candidate]'),
      'observe candidate',
    )
    const result = (await harness.host.executeTool(routerAgent(harness), 'superagent_route', {
      triggerId: trigger.id,
      outcome: 'accept',
      title: 'Investigate CI',
    })).value as { ok?: boolean; decisionId?: string; outcome?: string; ticketId?: string }

    expect(result.ok).toBe(true)
    expect(result.outcome).toBe('ignore')
    expect(result.ticketId).toBeUndefined()
    expect(harness.store.tickets.open()).toHaveLength(0)
    // Nothing was sent on any channel and no worker was started.
    expect(harness.host.agents.liveAgent('superagent-worker-')).toBeUndefined()
    expect(harness.github?.postedComments ?? []).toHaveLength(0)

    const decision = harness.store.decisions.get(result.decisionId ?? '')!
    expect(decision.outcome).toBe('ignore')
    expect(decision.reason.map(reason => reason.code)).toContain('would_accept')
  })
})

// ---------------------------------------------------------------------------
// Restart recovery through the real SQLite file
// ---------------------------------------------------------------------------

describe('restart recovery', () => {
  it('resumes an interrupted assignment from the SQLite file with recovery instructions', async () => {
    const harness = await startHarness()
    const trigger = makeTrigger({
      id: 'tr_restart_1',
      source: 'telegram',
      threadKey: 'telegram:dm:42',
      addressed: 'direct',
      actorId: '42',
      text: 'fix the flaky test',
      meta: {},
    })
    trigger.channel = { source: 'telegram', thread: 'telegram:dm:42', to: '42' }
    expect(harness.runtime.enginePort!.sources.receive(trigger)).toBe('stored')
    await harness.settle(
      () => routerAgent(harness).allText().join('\n').includes('[superagent candidate]'),
      'restart candidate',
    )
    const ticketId = await acceptCandidate(harness, trigger.id, 'Fix the flaky test')
    expect(harness.store.tickets.get(ticketId)!.assignments.at(-1)!.state).toBe('running')
    const originalWorker = workerAgent(harness, ticketId)

    // Host restart: stop the runtime, close the store, drop live agents but
    // keep session persistence — then start a fresh Runtime on the same file.
    await harness.runtime.stop()
    harness.store.close()
    harness.host.agents.restart()

    const reopened = openStore({ stateDir: harness.stateDir })
    CLEANUPS.push(() => reopened.close())
    const restarted = new Runtime(harness.host.ctx as unknown as Context, {
      stateDir: harness.stateDir,
      sources: {
        telegram: { enabled: false, allowedUserIds: ['42'] },
        github: { enabled: false, login: 'sa-agent', allowedLogins: ['owner'], repositories: ['owner/repo'] },
      },
      policy: { mode: 'auto' },
      executor: { clone: false, maxWorkers: 2 },
      passIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      watchdog: { intervalMs: 60_000, stallMs: 60_000, escalateMs: 60_000 },
    }, { store: reopened, sources: [], skipLock: true })
    CLEANUPS.push(() => restarted.stop())
    await restarted.ready

    // afterStart() runs recovery detached; wait for the relaunched worker.
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      await restarted.pass('restart')
      await restarted.pumpEffects()
      if (harness.host.agents.liveAgent(`superagent-worker-${ticketId}`) !== undefined) break
      await sleep(20)
    }
    await restarted.pumpEffects()

    const recovered = workerAgent(harness, ticketId)
    expect(recovered).not.toBe(originalWorker)
    const text = recovered.allText().join('\n')
    expect(text).toContain('[superagent assignment]')
    expect(text).toContain('[recovery]')

    // The interrupted assignment was ended and a new one is running.
    const ticket = reopened.tickets.get(ticketId)!
    expect(ticket.assignments.at(-1)!.state).toBe('running')
    expect(harness.host.agents.resumed.some(entry => entry.sessionId === `superagent-worker-${ticketId}`)).toBe(true)
    expect(harness.host.agents.created.some(entry => entry.sessionId === 'superagent-router')).toBe(true)
  })
})
