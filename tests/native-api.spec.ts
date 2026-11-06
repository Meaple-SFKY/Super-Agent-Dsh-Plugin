/**
 * `native` Source: loopback HTTP/SSE bridge for the MMAgent macOS app.
 * These tests use a real HTTP server and real files, but no DSH host.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  validateTaskAttachments,
} from '../src/sources/native.js'
import type { ChannelAddress, OutboundMessage, Trigger } from '../src/core/model.js'
import type { SourceContext } from '../src/sources/kind.js'
import { Runtime } from '../src/app/runtime.js'
import { createMemoryStore } from '../src/app/store.js'
import { createFakeHost } from './runtime-host.js'
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
    native: { version: '1.0.0', port: 0, pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z' },
    tickets: { active: [], attention: [], history: [] },
    sources: [],
    health: [],
  }
  detail: NativeTicketDetail | undefined
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
    expect(discovery.version).toBe('1.0.0')
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
