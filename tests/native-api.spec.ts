/**
 * `native` Source: loopback HTTP/SSE bridge for the MMAgent macOS app.
 * These tests use a real HTTP server and real files, but no DSH host.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  NATIVE_API_PREFIX,
  NATIVE_DISCOVERY_FILE,
  NativeSource,
  type NativeBridge,
  type NativeState,
  type NativeTicketDetail,
  type NativeTicketListItem,
  validateTaskAttachments,
} from '../src/sources/native.js'
import type { ChannelAddress, OutboundMessage, Ticket, Trigger } from '../src/core/model.js'
import type { SourceContext } from '../src/sources/kind.js'
import { Runtime } from '../src/app/runtime.js'
import { createMemoryStore } from '../src/app/store.js'
import { FakeLlm, createFakeHost } from './runtime-host.js'
import type { Context } from '@deepseek-ai/cordis'

interface Harness {
  source: NativeSource
  ctx: FakeSourceContext
  bridge: FakeBridge
  stateDir: string
  port: number
  token: string
  base: string
  cleanup: () => Promise<void>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

class FakeSourceContext implements SourceContext {
  readonly id = 'native'
  readonly stateDir: string
  readonly logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }
  private readonly values = new Map<string, unknown>()
  readonly kv = {
    get: <T>(key: string): T | undefined => this.values.get(key) as T | undefined,
    set: <T>(key: string, value: T): void => {
      this.values.set(key, value)
    },
    delete: (key: string): void => {
      this.values.delete(key)
    },
    keys: (prefix?: string): string[] =>
      [...this.values.keys()].filter(key => (prefix === undefined ? true : key.startsWith(prefix))),
  }
  readonly healthEntries: Array<{ name: string; state: string; detail?: string }> = []
  readonly received: Trigger[] = []
  constructor(stateDir: string) {
    this.stateDir = stateDir
  }
  now(): string {
    return new Date().toISOString()
  }
  newId(prefix: string): string {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
  }
  receive(trigger: Trigger): 'stored' | 'duplicate' | 'filtered' {
    this.received.push(trigger)
    return 'stored'
  }
  health(entry: { name: string; state: string; detail?: string }): void {
    this.healthEntries.push(entry)
  }
}

class FakeBridge implements NativeBridge {
  readonly tasks: Array<{
    text: string
    clientTaskId?: string
    attachments?: Array<{ path: string; name: string; kind: 'photo' | 'document'; size: number }>
  }> = []
  readonly replies: Array<{ ticketId: string; text: string }> = []
  readonly actions: Array<{ ticketId: string; action: 'ack' | 'retry' | 'stop' }> = []
  stateValue: NativeState = {
    ok: true,
    plugin: { status: 'ready', detail: null, version: '0.1.1' },
    paused: false,
    native: { version: '1.1.0', port: 0, pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z' },
    tickets: { active: [], attention: [], history: [] },
    sources: [],
    health: [],
  }
  detail: NativeTicketDetail | undefined
  ticketQueries: Array<Record<string, unknown>> = []
  ticketPage: { items: NativeTicketListItem[]; nextBefore?: string; total: number } = {
    items: [],
    total: 0,
  }
  state(): NativeState {
    return this.stateValue
  }
  ticket(): NativeTicketDetail | undefined {
    return this.detail
  }
  async createTask(input: {
    text: string
    clientTaskId?: string
    attachments?: Array<{ path: string; name: string; kind: 'photo' | 'document'; size: number }>
  }) {
    this.tasks.push(input)
    return {
      ok: true,
      ticketId: 'tk_native_1',
      threadId: `native:task:${input.clientTaskId ?? 'new'}`,
      triggerId: 'tr_native_1',
    }
  }
  async reply(ticketId: string, text: string) {
    this.replies.push({ ticketId, text })
    return { ok: true, triggerId: 'tr_native_reply' }
  }
  async action(ticketId: string, action: 'ack' | 'retry' | 'stop') {
    this.actions.push({ ticketId, action })
    return { ok: true, result: `${action} ${ticketId}` }
  }
  async tickets(options: Record<string, unknown>) {
    this.ticketQueries.push(options)
    return { ...this.ticketPage }
  }
}

const nativeChannel: ChannelAddress = { source: 'native', thread: 'native:task:t1', to: 'native:task:t1' }
function outbound(id: string, text = 'hello'): OutboundMessage {
  return { id, ticketId: 'tk_native_1', purpose: 'result', channel: nativeChannel, text, at: '2026-01-01T00:00:00.000Z' }
}

async function startSource(options: { port?: number; bridge?: NativeBridge } = {}): Promise<Harness> {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-native-'))
  const ctx = new FakeSourceContext(stateDir)
  const bridge = (options.bridge ?? new FakeBridge()) as FakeBridge
  const source = new NativeSource(ctx, { bridge, port: options.port ?? 0 })
  await source.start()
  const discoveryPath = join(stateDir, NATIVE_DISCOVERY_FILE)
  const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as {
    version: string
    port: number
    token: string
    pid: number
    startedAt: string
  }
  const cleanup = async (): Promise<void> => {
    await source.stop()
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
  cleanups.push(cleanup)
  return {
    source,
    ctx,
    bridge,
    stateDir,
    port: discovery.port,
    token: discovery.token,
    base: `http://127.0.0.1:${discovery.port}${NATIVE_API_PREFIX}`,
    cleanup,
  }
}

function auth(token: string): Record<string, string> {
  return { 'x-mmagent-token': token, 'content-type': 'application/json' }
}

describe('native discovery + auth', () => {
  it('writes a 0600 discovery file and rejects missing/wrong tokens', async () => {
    const harness = await startSource()
    const discoveryPath = join(harness.stateDir, NATIVE_DISCOVERY_FILE)
    expect(existsSync(discoveryPath)).toBe(true)
    expect(statSync(discoveryPath).mode & 0o777).toBe(0o600)
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as Record<string, unknown>
    expect(discovery.version).toBe('1.1.0')
    expect(discovery.port).toBe(harness.port)
    expect(discovery.token).toBe(harness.token)
    expect(discovery.pid).toBe(process.pid)
    expect(String(discovery.token).length).toBe(64)

    const unauthorized = await fetch(`${harness.base}/state`)
    expect(unauthorized.status).toBe(401)
    const wrong = await fetch(`${harness.base}/state`, { headers: auth('nope') })
    expect(wrong.status).toBe(401)
    const ok = await fetch(`${harness.base}/state`, { headers: auth(harness.token) })
    expect(ok.status).toBe(200)
    expect((await ok.json()) as Record<string, unknown>).toMatchObject({ ok: true, paused: false })

    const bearer = await fetch(`${harness.base}/state`, { headers: { authorization: `Bearer ${harness.token}` } })
    expect(bearer.status).toBe(200)
  })

  it('falls back to another port when the preferred one is occupied', async () => {
    const blocker: Server = createServer((_request, response) => response.end('busy'))
    await new Promise<void>(resolve => blocker.listen({ host: '127.0.0.1', port: 0 }, resolve))
    const address = blocker.address()
    const occupied = typeof address === 'object' && address !== null ? address.port : 0
    try {
      const harness = await startSource({ port: occupied })
      expect(harness.port).not.toBe(occupied)
      const ok = await fetch(`${harness.base}/state`, { headers: auth(harness.token) })
      expect(ok.status).toBe(200)
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()))
    }
  })

  it('removes the discovery file and stops listening on stop', async () => {
    const harness = await startSource()
    const { port, token, base } = harness
    await harness.cleanup()
    expect(existsSync(join(harness.stateDir, NATIVE_DISCOVERY_FILE))).toBe(false)
    await expect(fetch(`${base}/state`, { headers: auth(token) })).rejects.toThrow()
    void port
  })
})

describe('native tasks, replies and actions', () => {
  it('creates a task through the bridge and validates the body', async () => {
    const harness = await startSource()
    const created = await fetch(`${harness.base}/tasks`, {
      method: 'POST',
      headers: auth(harness.token),
      body: JSON.stringify({ text: 'fix the build', clientTaskId: 'client-7' }),
    })
    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject({ ok: true, ticketId: 'tk_native_1', status: 'accepted' })
    expect(harness.bridge.tasks).toEqual([{ text: 'fix the build', clientTaskId: 'client-7' }])

    const invalid = await fetch(`${harness.base}/tasks`, {
      method: 'POST',
      headers: auth(harness.token),
      body: JSON.stringify({ text: '   ' }),
    })
    expect(invalid.status).toBe(400)
  })

  it('accepts up to 10 local attachments, normalizes them and rejects invalid paths', async () => {
    const harness = await startSource()
    const filesDir = mkdtempSync(join(tmpdir(), 'native-attach-'))
    const photo = join(filesDir, 'screen.png')
    const document = join(filesDir, 'notes.txt')
    writeFileSync(photo, 'pixel')
    writeFileSync(document, 'hello')

    const created = await fetch(`${harness.base}/tasks`, {
      method: 'POST',
      headers: auth(harness.token),
      body: JSON.stringify({ text: 'look at these', attachments: [photo, document] }),
    })
    expect(created.status).toBe(200)
    expect(harness.bridge.tasks[0]!.attachments).toEqual([
      { path: photo, name: 'screen.png', kind: 'photo', size: 5 },
      { path: document, name: 'notes.txt', kind: 'document', size: 5 },
    ])

    const badPath = join(filesDir, 'missing.png')
    const invalidCases: unknown[] = [
      [badPath],
      ['relative/file.txt'],
      [filesDir],
      Array.from({ length: 11 }, () => photo),
      'not-an-array',
    ]
    for (const attachments of invalidCases) {
      const response = await fetch(`${harness.base}/tasks`, {
        method: 'POST',
        headers: auth(harness.token),
        body: JSON.stringify({ text: 'still runs', attachments }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { ok: boolean; warnings?: string[] }
      expect(body.ok).toBe(true)
      expect(body.warnings?.length ?? 0).toBeGreaterThan(0)
    }
    // The task still ran; invalid attachments never reach the bridge.
    expect(harness.bridge.tasks[harness.bridge.tasks.length - 1]!.attachments ?? []).toEqual([])
  })

  it('validates the attachment helper directly (warn/ignore semantics)', () => {
    const filesDir = mkdtempSync(join(tmpdir(), 'native-attach-helper-'))
    const photo = join(filesDir, 'shot.png')
    writeFileSync(photo, 'x')
    expect(validateTaskAttachments([photo]).attachments).toEqual([
      { path: photo, name: 'shot.png', kind: 'photo', size: 1 },
    ])
    expect(validateTaskAttachments(undefined)).toEqual({ attachments: [], warnings: [] })
    const eleven = Array.from({ length: 11 }, () => photo)
    const many = validateTaskAttachments(eleven)
    expect(many.attachments).toHaveLength(10)
    expect(many.warnings.some(line => line.includes('first 10'))).toBe(true)
    const invalid = validateTaskAttachments([join(filesDir, 'missing.png'), 'rel.txt', filesDir, 42])
    expect(invalid.attachments).toEqual([])
    expect(invalid.warnings.length).toBe(4)
  })

  it('returns ticket detail and forwards replies with the ticket id', async () => {
    const harness = await startSource()
    const notFound = await fetch(`${harness.base}/tickets/tk_missing`, { headers: auth(harness.token) })
    expect(notFound.status).toBe(404)

    harness.bridge.detail = {
      id: 'tk_native_1',
      title: 'Fix build',
      state: 'open',
      stage: 'working',
      source: 'native',
      thread: nativeChannel.thread,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      inputs: [],
      reports: [],
      files: [{ path: '/tmp/report.png', kind: 'photo' }],
      attachments: [{ path: '/tmp/report.png', kind: 'photo' }],
      assignments: [],
    }
    const detail = await fetch(`${harness.base}/tickets/tk_native_1`, { headers: auth(harness.token) })
    expect(detail.status).toBe(200)
    expect((await detail.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      ticket: { id: 'tk_native_1', stage: 'working' },
    })

    const reply = await fetch(`${harness.base}/tickets/tk_native_1/reply`, {
      method: 'POST',
      headers: auth(harness.token),
      body: JSON.stringify({ text: 'please continue' }),
    })
    expect(reply.status).toBe(200)
    expect(harness.bridge.replies).toEqual([{ ticketId: 'tk_native_1', text: 'please continue' }])
  })

  it('forwards ack/retry/stop and rejects unknown actions', async () => {
    const harness = await startSource()
    for (const action of ['ack', 'retry', 'stop'] as const) {
      const response = await fetch(`${harness.base}/actions`, {
        method: 'POST',
        headers: auth(harness.token),
        body: JSON.stringify({ ticketId: 'tk_native_1', action }),
      })
      expect(response.status).toBe(200)
    }
    expect(harness.bridge.actions.map(entry => entry.action)).toEqual(['ack', 'retry', 'stop'])
    const bad = await fetch(`${harness.base}/actions`, {
      method: 'POST',
      headers: auth(harness.token),
      body: JSON.stringify({ ticketId: 'tk_native_1', action: 'explode' }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('native outbox, inbox and SSE', () => {
  it('persists outbound messages to the inbox and backfills with since', async () => {
    const harness = await startSource()
    expect(await harness.source.send(outbound('msg_1', 'first'))).toBe('sent')
    expect(await harness.source.send(outbound('msg_2', 'second'))).toBe('sent')
    expect(await harness.source.send({ ...outbound('msg_3'), channel: { ...nativeChannel, source: 'telegram' } })).toBe('failed')

    const inboxFile = join(harness.stateDir, 'native-inbox.jsonl')
    expect(existsSync(inboxFile)).toBe(true)
    const lines = readFileSync(inboxFile, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)

    const all = await fetch(`${harness.base}/messages`, { headers: auth(harness.token) })
    const allBody = (await all.json()) as { messages: Array<{ id: number; message: { text: string } }>; nextSince: number }
    expect(allBody.messages.map(entry => entry.message.text)).toEqual(['first', 'second'])
    expect(allBody.nextSince).toBe(2)

    const since = await fetch(`${harness.base}/messages?since=1`, { headers: auth(harness.token) })
    const sinceBody = (await since.json()) as { messages: Array<{ message: { text: string } }> }
    expect(sinceBody.messages.map(entry => entry.message.text)).toEqual(['second'])
  })

  it('streams a snapshot first and then message events', async () => {
    const harness = await startSource()
    const controller = new AbortController()
    const response = await fetch(`${harness.base}/events`, {
      headers: auth(harness.token),
      signal: controller.signal,
    })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const readUntil = async (needle: string, timeoutMs = 2_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs
      while (!text.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`SSE timeout waiting for ${needle}: ${text}`)
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
      }
    }
    await readUntil('event: snapshot')
    expect(text).toContain('"ok":true')

    await harness.source.send(outbound('msg_sse', 'streamed'))
    await readUntil('event: message')
    expect(text).toContain('streamed')
    // The message event carries routing/labelling fields at the top level.
    expect(text).toContain('"thread":"native:task:t1"')
    expect(text).toContain('"ticketId":"tk_native_1"')
    expect(text).toContain('"purpose":"result"')
    controller.abort()
    await reader.cancel().catch(() => undefined)
  })
})

describe('native runtime wiring', () => {
  it('registers the native Source, writes discovery, serves state and stops cleanly', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'superagent-native-rt-'))
    const host = createFakeHost()
    const store = createMemoryStore()
    const runtime = new Runtime(
      host.ctx as unknown as Context,
      {
        stateDir,
        sources: {
          telegram: { enabled: false },
          github: { enabled: false },
          native: { enabled: true, port: 0 },
        },
        policy: { mode: 'observe' },
        passIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        watchdog: { intervalMs: 60_000 },
      },
      { store, skipLock: true },
    )
    await runtime.ready
    const discoveryPath = join(stateDir, NATIVE_DISCOVERY_FILE)
    const deadline = Date.now() + 3_000
    while (!existsSync(discoveryPath) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(existsSync(discoveryPath)).toBe(true)
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { port: number; token: string }
    const base = `http://127.0.0.1:${discovery.port}${NATIVE_API_PREFIX}`
    const state = await fetch(`${base}/state`, { headers: auth(discovery.token) })
    expect(state.status).toBe(200)
    const body = (await state.json()) as { sources: Array<{ id: string; health: string }> }
    expect(body.sources.some(source => source.id === 'native' && source.health === 'ready')).toBe(true)

    const attachment = join(stateDir, 'mac-screenshot.png')
    writeFileSync(attachment, 'png-bytes')
    const task = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: auth(discovery.token),
      body: JSON.stringify({ text: 'native task from mac app', clientTaskId: 'mac-1', attachments: [attachment] }),
    })
    expect(task.status).toBe(200)
    const taskBody = (await task.json()) as { ok: boolean; threadId: string; triggerId?: string }
    expect(taskBody.ok).toBe(true)
    expect(taskBody.threadId.startsWith('native:task:')).toBe(true)
    // The trigger reached the real Engine store with the native Source identity
    // and the attachment list normalized into Trigger.meta.attachments.
    const triggers = store.read.search('native task from mac app', 5)
    expect(triggers.some(entry => entry.kind === 'trigger')).toBe(true)
    const savedTrigger = store.triggers.get(taskBody.triggerId as never)
    expect(savedTrigger?.meta.attachments).toEqual([
      { path: attachment, name: 'mac-screenshot.png', kind: 'photo', size: 9 },
    ])

    await runtime.stop()
    expect(existsSync(discoveryPath)).toBe(false)
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  })
})

describe('native setup API (task-73)', () => {
  interface SetupHarness {
    runtime: Runtime
    stateDir: string
    base: string
    token: string
    editor: { calls: Array<{ next: Record<string, unknown> }> }
    cleanup: () => Promise<void>
  }

  const telegramStub = {
    async validate(token: string) {
      if (token === 'bad') {
        throw Object.assign(new Error('Telegram token check failed: Unauthorized'), {
          name: 'TelegramTokenValidationError',
          code: 401,
        })
      }
      return { botUsername: 'native_bot', botId: 42 }
    },
  }
  const githubStub = {
    async validate(token: string) {
      if (token === 'bad') {
        throw Object.assign(new Error('GitHub token check failed: HTTP 401: Bad credentials'), {
          name: 'GithubTokenValidationError',
          status: 401,
        })
      }
      return { login: 'octocat' }
    },
    async listRepositories() {
      return [
        { fullName: 'octocat/one', private: false, pushedAt: '2026-01-01T00:00:00Z', archived: false, fork: false },
        { fullName: 'octocat/two', private: true, pushedAt: '2025-12-01T00:00:00Z', archived: false, fork: false },
      ]
    },
    async addCollaborator(_token: string, repo: string, login: string) {
      return { alreadyCollaborator: false, repo, login, permission: 'push', ok: true as const }
    },
    async acceptForRepo(_token: string, repo: string) {
      return { status: 'accepted', invitationId: 7, repo }
    },
  }

  async function startSetupRuntime(): Promise<SetupHarness> {
    const stateDir = mkdtempSync(join(tmpdir(), 'superagent-native-setup-'))
    const host = createFakeHost({ llm: new FakeLlm() })
    const editor = { calls: [] as Array<{ next: Record<string, unknown> }> }
    const runtime = new Runtime(
      host.ctx as unknown as Context,
      {
        stateDir,
        sources: {
          telegram: { enabled: false },
          github: { enabled: false },
          native: { enabled: true, port: 0 },
        },
        policy: { mode: 'observe' },
        passIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        watchdog: { intervalMs: 60_000 },
      },
      {
        store: createMemoryStore(),
        skipLock: true,
        setupDeps: {
          loadTelegramHelpers: async () => telegramStub,
          loadGithubHelpers: async () => githubStub,
          configEditor: () => ({
            async edit(_entry, change) {
              editor.calls.push({ next: change({}, {}) })
            },
          }),
          hostEntry: () => ({ id: 'native-test-entry' }),
          runSshKeygen: async (args: string[]) => {
            const index = args.indexOf('-f')
            const file = args[index + 1]!
            writeFileSync(file, '-----BEGIN PRIVATE KEY-----', { mode: 0o600 })
            writeFileSync(`${file}.pub`, 'ssh-ed25519 AAAAC3Nza native-test\n', { mode: 0o644 })
          },
        },
      },
    )
    await runtime.ready
    const discoveryPath = join(stateDir, NATIVE_DISCOVERY_FILE)
    const deadline = Date.now() + 3_000
    while (!existsSync(discoveryPath) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { port: number; token: string }
    const cleanup = async (): Promise<void> => {
      await runtime.stop()
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    }
    return {
      runtime,
      stateDir,
      editor,
      token: discovery.token,
      base: `http://127.0.0.1:${discovery.port}${NATIVE_API_PREFIX}/setup`,
      cleanup,
    }
  }

  it('requires the native token on setup endpoints', async () => {
    const harness = await startSetupRuntime()
    try {
      expect((await fetch(`${harness.base}/state`)).status).toBe(401)
      expect((await fetch(`${harness.base}/state`, { headers: auth(harness.token) })).status).toBe(200)
      expect((await fetch(`${harness.base}/nope`, { headers: auth(harness.token) })).status).toBe(404)
    } finally {
      await harness.cleanup()
    }
  })

  it('serves the safe setup state and model catalog', async () => {
    const harness = await startSetupRuntime()
    try {
      const state = await fetch(`${harness.base}/state`, { headers: auth(harness.token) })
      expect(state.status).toBe(200)
      const body = (await state.json()) as Record<string, unknown>
      expect(body).toMatchObject({ ok: true, onboardingComplete: false })
      expect((body.accounts as { native: Record<string, unknown> }).native).toMatchObject({
        enabled: true,
        configured: true,
      })
      // No secret *content* (the permissions copy legitimately mentions "token").
      expect(JSON.stringify(body)).not.toMatch(/ghp_|BEGIN PRIVATE|\d{6,}:AA/)

      const models = await fetch(`${harness.base}/models`, { headers: auth(harness.token) })
      expect(models.status).toBe(200)
      const catalog = (await models.json()) as { ok: boolean; providers: Array<{ id: string; models: unknown[] }> }
      expect(catalog.ok).toBe(true)
      expect(catalog.providers.map(provider => provider.id)).toContain('deepseek')
    } finally {
      await harness.cleanup()
    }
  })

  it('validates and saves Telegram tokens through the setup service', async () => {
    const harness = await startSetupRuntime()
    try {
      const saved = await fetch(`${harness.base}/telegram`, {
        method: 'POST',
        headers: auth(harness.token),
        body: JSON.stringify({ token: '123:abc' }),
      })
      expect(saved.status).toBe(200)
      expect(await saved.json()).toMatchObject({ ok: true, botUsername: 'native_bot' })
      const tokenFile = join(harness.stateDir, 'secrets', 'telegram-token')
      expect(readFileSync(tokenFile, 'utf8').trim()).toBe('123:abc')
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600)

      const invalid = await fetch(`${harness.base}/telegram`, {
        method: 'POST',
        headers: auth(harness.token),
        body: JSON.stringify({ token: 'bad' }),
      })
      expect(invalid.status).toBe(400)
      expect(((await invalid.json()) as Record<string, unknown>).error).toBe('invalid_token')
    } finally {
      await harness.cleanup()
    }
  })

  it('validates and saves GitHub tokens and lists repositories', async () => {
    const harness = await startSetupRuntime()
    try {
      const saved = await fetch(`${harness.base}/github`, {
        method: 'POST',
        headers: auth(harness.token),
        body: JSON.stringify({ token: 'ghp_native' }),
      })
      expect(saved.status).toBe(200)
      const body = (await saved.json()) as Record<string, unknown>
      expect(body).toMatchObject({ ok: true, login: 'octocat' })
      expect((body.repositories as unknown[]).length).toBe(2)
      expect(existsSync(join(harness.stateDir, 'secrets', 'github-token'))).toBe(true)

      const invalid = await fetch(`${harness.base}/github`, {
        method: 'POST',
        headers: auth(harness.token),
        body: JSON.stringify({ token: 'bad' }),
      })
      expect(invalid.status).toBe(400)
    } finally {
      await harness.cleanup()
    }
  })

  it('runs the operator flow (invite/accept) and stores the PAT 0600', async () => {
    const harness = await startSetupRuntime()
    try {
      mkdirSync(join(harness.stateDir, 'secrets'), { recursive: true, mode: 0o700 })
      writeFileSync(join(harness.stateDir, 'secrets', 'github-token'), 'ghp_bot', { mode: 0o600 })
      const response = await fetch(`${harness.base}/github/operator`, {
        method: 'POST',
        headers: auth(harness.token),
        body: JSON.stringify({ token: 'ghp_operator', repositories: ['octocat/one'], botLogin: 'octocat' }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as Record<string, unknown>
      expect(body.ok).toBe(true)
      expect(body.invited).toEqual([{ repo: 'octocat/one', login: 'octocat', status: 'invited' }])
      expect((body.accepted as Array<Record<string, unknown>>)[0]!.status).toBe('accepted')
      const operatorFile = join(harness.stateDir, 'secrets', 'github-operator-token')
      expect(readFileSync(operatorFile, 'utf8').trim()).toBe('ghp_operator')
      expect(statSync(operatorFile).mode & 0o777).toBe(0o600)
      expect(JSON.stringify(body)).not.toContain('ghp_operator')
      const deadline = Date.now() + 1_000
      while (harness.editor.calls.length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect((harness.editor.calls[0]!.next.sources as Record<string, unknown>).github).toMatchObject({
        operatorTokenFile: operatorFile,
      })
    } finally {
      await harness.cleanup()
    }
  })

  it('generates an SSH key pair without leaking the private key', async () => {
    const harness = await startSetupRuntime()
    try {
      const response = await fetch(`${harness.base}/github/ssh-key`, {
        method: 'POST',
        headers: auth(harness.token),
        body: '{}',
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as Record<string, unknown>
      expect(body.ok).toBe(true)
      expect(String(body.publicKey)).toContain('ssh-ed25519')
      expect(JSON.stringify(body)).not.toContain('PRIVATE KEY')
      expect(typeof body.keyFile).toBe('string')
      expect(existsSync(String(body.keyFile))).toBe(true)
      const deadline = Date.now() + 1_000
      while (harness.editor.calls.length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect((harness.editor.calls[0]!.next.executor as Record<string, unknown>).gitSshKeyFile).toBe(body.keyFile)
    } finally {
      await harness.cleanup()
    }
  })

  it('persists a config patch, marks onboarding complete and returns restarting', async () => {
    const harness = await startSetupRuntime()
    try {
      const response = await fetch(`${harness.base}/config`, {
        method: 'PUT',
        headers: auth(harness.token),
        body: JSON.stringify({ config: { sources: { native: { enabled: false } }, policy: { mode: 'auto' } } }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: true, restarting: true })
      const deadline = Date.now() + 2_000
      while (harness.editor.calls.length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(harness.editor.calls[0]!.next).toMatchObject({
        sources: { native: { enabled: false } },
        policy: { mode: 'auto' },
      })
      expect(existsSync(join(harness.stateDir, 'setup-complete.json'))).toBe(true)
      const state = await fetch(`${harness.base}/state`, { headers: auth(harness.token) })
      expect(await state.json()).toMatchObject({ onboardingComplete: true })
    } finally {
      await harness.cleanup()
    }
  })
})

describe('native ticket search + pagination (task-74)', () => {
  it('forwards query/status/source/limit/before and returns the page', async () => {
    const harness = await startSource()
    harness.bridge.ticketPage = {
      items: [{ id: 'tk_1', title: 'Fix build', state: 'ended', stage: 'ended', source: 'native', thread: 'native:task:t1', lastReport: 'ready', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }],
      nextBefore: 'cursor|tk_1',
      total: 4,
    }
    const response = await fetch(
      `${harness.base}/tickets?query=build&status=history&source=native&limit=5&before=${encodeURIComponent('2026-01-03T00:00:00.000Z|tk_9')}`,
      { headers: auth(harness.token) },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      total: 4,
      nextBefore: 'cursor|tk_1',
      items: [{ id: 'tk_1', title: 'Fix build' }],
    })
    expect(harness.bridge.ticketQueries[0]).toMatchObject({
      query: 'build',
      status: 'history',
      source: 'native',
      limit: 5,
      before: '2026-01-03T00:00:00.000Z|tk_9',
    })
  })

  it('validates status, source, limit and cursor', async () => {
    const harness = await startSource()
    for (const query of [
      'status=weird',
      'source=bad source!',
      'limit=0',
      'limit=101',
      'limit=abc',
      `before=${encodeURIComponent('no-separator')}`,
    ]) {
      const response = await fetch(`${harness.base}/tickets?${query}`, { headers: auth(harness.token) })
      expect(response.status).toBe(400)
    }
    expect(harness.bridge.ticketQueries).toHaveLength(0)
  })

  it('searches and paginates real tickets without duplicates or gaps', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'superagent-native-list-'))
    const host = createFakeHost()
    const store = createMemoryStore()
    const runtime = new Runtime(
      host.ctx as unknown as Context,
      {
        stateDir,
        sources: { telegram: { enabled: false }, github: { enabled: false }, native: { enabled: true, port: 0 } },
        policy: { mode: 'observe' },
        passIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        watchdog: { intervalMs: 60_000 },
      },
      { store, skipLock: true },
    )
    await runtime.ready
    const seed = (ticket: Ticket): void => {
      store.tickets.save(ticket)
    }
    const nativeChannel = { source: 'native', thread: 'native:task:a', to: 'native:task:a' }
    seed({
      id: 'tk_hist',
      title: 'Fix build',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
      state: 'ended',
      origin: { triggerId: 'tr_a', triggerIds: ['tr_a'] },
      mandate: {
        policyVersion: 'v',
        strength: 'explicit',
        rules: [],
        source: 'native',
        scope: 'native:dm',
        sender: { id: 'local' },
        via: 'direct',
        at: '2026-01-01T00:00:00.000Z',
      },
      ends: { at: '2026-01-03T00:00:00.000Z', by: 'main', reason: 'ready', outcome: 'ready' },
      follows: [],
      subscriptions: [],
      channels: [nativeChannel],
      inputs: [
        { id: 'in_1', kind: 'trigger', at: '2026-01-01T00:00:00.000Z', text: 'please fix build' },
      ],
      assignments: [],
      latestReport: { kind: 'ready', summary: 'tests pass', at: '2026-01-03T00:00:00.000Z' },
    } as unknown as Ticket)
    seed({
      id: 'tk_attn',
      title: 'Login bug',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      state: 'open',
      origin: { triggerId: 'tr_b', triggerIds: ['tr_b'] },
      mandate: {
        policyVersion: 'v',
        strength: 'explicit',
        rules: [],
        source: 'github',
        scope: 'github:o/r',
        sender: { id: 'gh' },
        via: 'direct',
        at: '2026-01-01T00:00:00.000Z',
      },
      follows: [],
      subscriptions: [],
      channels: [{ source: 'github', thread: 'o/r#1', to: 'o/r' }],
      inputs: [],
      assignments: [],
      latestReport: { kind: 'blocked', summary: 'need credentials', at: '2026-01-02T00:00:00.000Z' },
    } as unknown as Ticket)
    seed({
      id: 'tk_act',
      title: 'Docs',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      state: 'open',
      origin: { triggerId: 'tr_c', triggerIds: ['tr_c'] },
      mandate: {
        policyVersion: 'v',
        strength: 'explicit',
        rules: [],
        source: 'telegram',
        scope: 'telegram:dm',
        sender: { id: 'tg' },
        via: 'direct',
        at: '2026-01-01T00:00:00.000Z',
      },
      follows: [],
      subscriptions: [],
      channels: [{ source: 'telegram', thread: 'chat-1', to: 'chat-1' }],
      inputs: [],
      assignments: [],
    } as unknown as Ticket)

    const discoveryPath = join(stateDir, NATIVE_DISCOVERY_FILE)
    const deadline = Date.now() + 3_000
    while (!existsSync(discoveryPath) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as {
      port: number
      token: string
    }
    const base = `http://127.0.0.1:${discovery.port}${NATIVE_API_PREFIX}/tickets`
    try {
      const all = (await (await fetch(base, { headers: auth(discovery.token) })).json()) as {
        items: Array<{ id: string }>
        total: number
      }
      expect(all.total).toBe(3)
      expect(all.items.map(item => item.id)).toEqual(['tk_hist', 'tk_attn', 'tk_act'])

      const history = (await (await fetch(`${base}?status=history`, { headers: auth(discovery.token) })).json()) as {
        items: Array<{ id: string }>
      }
      expect(history.items.map(item => item.id)).toEqual(['tk_hist'])
      const attention = (await (await fetch(`${base}?status=attention`, { headers: auth(discovery.token) })).json()) as {
        items: Array<{ id: string }>
      }
      expect(attention.items.map(item => item.id)).toEqual(['tk_attn'])
      const active = (await (await fetch(`${base}?status=active`, { headers: auth(discovery.token) })).json()) as {
        items: Array<{ id: string }>
      }
      expect(active.items.map(item => item.id)).toEqual(['tk_act'])

      for (const [query, expected] of [
        ['tests', 'tk_hist'],
        ['credentials', 'tk_attn'],
        ['please fix', 'tk_hist'],
        ['tk_act', 'tk_act'],
      ] as const) {
        const page = (await (await fetch(`${base}?query=${encodeURIComponent(query)}`, {
          headers: auth(discovery.token),
        })).json()) as { items: Array<{ id: string }> }
        expect(page.items.map(item => item.id)).toEqual([expected])
      }
      const nativeOnly = (await (await fetch(`${base}?source=native`, { headers: auth(discovery.token) })).json()) as {
        items: Array<{ id: string }>
      }
      expect(nativeOnly.items.map(item => item.id)).toEqual(['tk_hist'])
      const empty = (await (await fetch(`${base}?query=zzz`, { headers: auth(discovery.token) })).json()) as {
        items: unknown[]
        total: number
      }
      expect(empty).toMatchObject({ items: [], total: 0 })

      // Pagination: two pages of 2/1 without duplicates or gaps.
      const first = (await (await fetch(`${base}?limit=2`, { headers: auth(discovery.token) })).json()) as {
        items: Array<{ id: string }>
        nextBefore?: string
        total: number
      }
      expect(first.items.map(item => item.id)).toEqual(['tk_hist', 'tk_attn'])
      expect(first.total).toBe(3)
      expect(first.nextBefore).toContain('|')
      const second = (await (await fetch(`${base}?limit=2&before=${encodeURIComponent(first.nextBefore!)}`, {
        headers: auth(discovery.token),
      })).json()) as { items: Array<{ id: string }> }
      expect(second.items.map(item => item.id)).toEqual(['tk_act'])
    } finally {
      await runtime.stop()
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    }
  })
})
