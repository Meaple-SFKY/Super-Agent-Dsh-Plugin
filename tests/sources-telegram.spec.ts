/**
 * Adapter tests for the Telegram Source: a real `node:http` fake Bot API, an
 * in-memory SourceContext, and no network access.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import type { OutboundMessage, Trigger } from '../src/core/model.js'
import type { SourceContext, SourceHealth, SourceLogger } from '../src/sources/kind.js'
import {
  createSource,
  normalizeTelegramConfig,
  parseTelegramCommand,
  type TelegramCommands,
  type TelegramConfig,
  type TelegramSource,
} from '../src/sources/telegram.js'
import {
  TelegramTokenValidationError,
  chunkTelegramHtml,
  chunkText,
  markdownToTelegramHtml,
  stripTelegramHtml,
  validateTelegramToken,
} from '../src/sources/telegram-api.js'
import type { TelegramUpdate } from '../src/sources/telegram-api.js'

// The token is fake; the fake server never checks it, and real credentials must
// never appear in this repository.
const TEST_TOKEN_ENV = 'SUPERAGENT_TELEGRAM_TOKEN'
process.env[TEST_TOKEN_ENV] = 'test-token-not-a-secret'
afterAll(() => {
  delete process.env[TEST_TOKEN_ENV]
})

// ---------------------------------------------------------------------------
// Fake Bot API
// ---------------------------------------------------------------------------

interface FakeCall {
  method: string
  body: Record<string, unknown>
  /** Raw request body (multipart uploads are not JSON). */
  raw?: string
}

interface TelegramAnswer {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  /** Raw bytes (file downloads). */
  raw?: string | Buffer
  /** Do not answer at all (used to test aborting an in-flight long poll). */
  pending?: boolean
}

type TelegramHandler = (
  method: string,
  body: Record<string, unknown>,
  callIndex: number,
) => TelegramAnswer | undefined

interface FakeTelegram {
  url: string
  calls: FakeCall[]
  callsOf(method: string): FakeCall[]
  close(): Promise<void>
}

const openServers: FakeTelegram[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => server.close()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `superagent-${prefix}-`))
  tempDirs.push(dir)
  return dir
}

async function startTelegram(handler: TelegramHandler = () => undefined): Promise<FakeTelegram> {
  const calls: FakeCall[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const fileMatch = /^\/file\/bot[^/]+\/(.+)$/.exec(url.pathname)
      const match = /^\/bot[^/]+\/([A-Za-z]+)$/.exec(url.pathname)
      const method = fileMatch ? 'downloadFile' : (match?.[1] ?? 'unknown')
      const raw = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined
      let body: Record<string, unknown> = fileMatch ? { filePath: decodeURIComponent(fileMatch[1]!) } : {}
      if (!fileMatch && raw) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>
        } catch {
          body = {}
        }
      }
      calls.push({ method, body, ...(raw !== undefined ? { raw } : {}) })
      const answer = handler(method, body, calls.length) ?? defaultAnswer(method, body)
      if (!answer) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error_code: 404, description: 'not found' }))
        return
      }
      if (answer.pending) return
      if (answer.raw !== undefined) {
        res.writeHead(answer.status ?? 200, { 'content-type': 'application/octet-stream', ...(answer.headers ?? {}) })
        res.end(answer.raw)
        return
      }
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...(answer.headers ?? {}) })
      res.end(JSON.stringify(answer.body ?? { ok: true, result: true }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const fake: FakeTelegram = {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    callsOf: (method: string) => calls.filter(call => call.method === method),
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
  openServers.push(fake)
  return fake
}

function defaultAnswer(method: string, body: Record<string, unknown>): TelegramAnswer | undefined {
  if (method === 'getMe') {
    return { body: { ok: true, result: { id: 999, is_bot: true, username: 'testbot' } } }
  }
  if (method === 'sendMessage') {
    return {
      body: {
        ok: true,
        result: { message_id: 1, date: 0, chat: { id: Number(body.chat_id), type: 'private' } },
      },
    }
  }
  if (method === 'getUpdates') return { body: { ok: true, result: [] } }
  if (method === 'setMyCommands') return { body: { ok: true, result: true } }
  if (method === 'sendPhoto' || method === 'sendDocument') {
    return {
      body: {
        ok: true,
        result: { message_id: 2, date: 0, chat: { id: Number(body.chat_id ?? 42), type: 'private' } },
      },
    }
  }
  if (method === 'answerCallbackQuery' || method === 'editMessageReplyMarkup') {
    return { body: { ok: true, result: true } }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// In-memory SourceContext
// ---------------------------------------------------------------------------

type Disposition = 'stored' | 'duplicate' | 'filtered' | 'failed'

interface TestContext {
  ctx: SourceContext
  triggers: Trigger[]
  health: SourceHealth[]
  kv: Map<string, unknown>
  loggerWarnings: Array<Record<string, unknown>>
}

interface TestContextOptions {
  /** Override the Engine answer; `undefined` falls back to normal dedupe. */
  receive?: (trigger: Trigger) => Disposition | undefined
  /** State directory (media downloads); defaults to a throwaway path. */
  stateDir?: string
}

function makeContext(id = 'telegram', options: TestContextOptions = {}): TestContext {
  const kv = new Map<string, unknown>()
  const triggers: Trigger[] = []
  const health: SourceHealth[] = []
  const loggerWarnings: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  let counter = 0
  const logger: SourceLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (_message: string, extra?: Record<string, unknown>) => {
      loggerWarnings.push(extra ?? {})
    },
    error: () => undefined,
  }
  const receive = (trigger: Trigger): Disposition => {
    const forced = options.receive?.(trigger)
    if (forced && forced !== 'stored') return forced
    if (seen.has(trigger.id)) return 'duplicate'
    seen.add(trigger.id)
    triggers.push(trigger)
    return 'stored'
  }
  const ctx = {
    id,
    stateDir: options.stateDir ?? '/tmp/superagent-sources-test',
    now: () => new Date().toISOString(),
    newId: (prefix: string) => `${prefix}-${(counter += 1)}`,
    receive,
    logger,
    health: (entry: SourceHealth) => {
      health.push(entry)
    },
    kv: {
      get: <T,>(key: string) => kv.get(key) as T | undefined,
      set: <T,>(key: string, value: T) => {
        kv.set(key, value)
      },
      delete: (key: string) => {
        kv.delete(key)
      },
      keys: (prefix = '') => [...kv.keys()].filter(key => key.startsWith(prefix)),
    },
  } as SourceContext
  return { ctx, triggers, health, kv, loggerWarnings }
}

function textMessage(options: {
  updateId: number
  messageId?: number
  userId?: number
  chatId?: number
  chatType?: 'private' | 'group' | 'supergroup'
  text?: string
  username?: string
  firstName?: string
  isBot?: boolean
  replyToBot?: boolean
  date?: number
}): TelegramUpdate {
  const message: Record<string, unknown> = {
    message_id: options.messageId ?? options.updateId,
    date: options.date ?? 1_730_000_000,
    from: {
      id: options.userId ?? 42,
      is_bot: options.isBot ?? false,
      first_name: options.firstName ?? 'Ann',
      ...(options.username ? { username: options.username } : {}),
    },
    chat: {
      id: options.chatId ?? options.userId ?? 42,
      type: options.chatType ?? 'private',
      ...(options.chatType && options.chatType !== 'private' ? { title: 'Ops' } : {}),
    },
    text: options.text ?? 'hello',
  }
  if (options.replyToBot) {
    message.reply_to_message = {
      message_id: 900,
      date: 1_730_000_000,
      from: { id: 999, is_bot: true, username: 'testbot' },
      chat: message.chat,
      text: 'previous',
    }
  }
  return { update_id: options.updateId, message } as TelegramUpdate
}

/** Poll until the predicate holds (bounded, for background-loop tests). */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function baseConfig(url: string, overrides: Partial<TelegramConfig> = {}): TelegramConfig {
  return { apiBaseUrl: url, allowedUserIds: ['42'], pollTimeoutSeconds: 0, ...overrides }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('telegram source: updates and translation', () => {
  it('translates an allowed private message into a direct Trigger and persists the offset', async () => {
    const fake = await startTelegram((method, body) => {
      if (method === 'getUpdates') {
        const offset = typeof body.offset === 'number' ? body.offset : 0
        return { body: { ok: true, result: offset <= 100 ? [textMessage({ updateId: 100, text: 'hello there' })] : [] } }
      }
      return undefined
    })
    const { ctx, triggers, kv } = makeContext()
    const source = createSource(baseConfig(fake.url, { replyToMessages: true }), ctx) as TelegramSource

    const result = await source.pollOnce(new AbortController().signal)

    expect(result).toMatchObject({ updates: 1, received: 1, commands: 0, filtered: 0 })
    expect(triggers).toHaveLength(1)
    const trigger = triggers[0]!
    expect(trigger.source).toBe('telegram')
    expect(trigger.kind).toBe('message')
    expect(trigger.thread.key).toBe('telegram:dm:42')
    expect(trigger.thread.source).toBe('telegram')
    expect(trigger.addressed).toBe('direct')
    expect(trigger.actor).toMatchObject({ id: '42', bot: false })
    expect(trigger.text).toBe('hello there')
    expect(trigger.channel).toMatchObject({
      source: 'telegram',
      thread: 'telegram:dm:42',
      to: '42',
      replyTo: '100',
    })
    expect(kv.get('telegram:offset')).toBe(101)
  })

  it('ignores the bot, other chats, edits, and non-allowed users but keeps the offset moving', async () => {
    const fake = await startTelegram((method, body) => {
      if (method === 'getUpdates') {
        return {
          body: {
            ok: true,
            result: [
              textMessage({ updateId: 10, userId: 7, text: 'stranger danger' }),
              textMessage({ updateId: 11, userId: 999, isBot: true, text: 'beep' }),
              textMessage({ updateId: 12, chatType: 'group', chatId: -1001, text: 'unaddressed group chatter' }),
              { update_id: 13, edited_message: textMessage({ updateId: 13 }).message },
            ],
          },
        }
      }
      void body
      return undefined
    })
    const { ctx, triggers, kv } = makeContext()
    const source = createSource(baseConfig(fake.url, { chats: ['-1001'] }), ctx) as TelegramSource

    const result = await source.pollOnce(new AbortController().signal)

    expect(result.updates).toBe(4)
    expect(result.received).toBe(0)
    expect(triggers).toHaveLength(0)
    expect(kv.get('telegram:offset')).toBe(14)
  })

  it('admits group mentions and replies to the bot, but drops unaddressed group chatter', async () => {
    const fake = await startTelegram((method, body) => {
      if (method === 'getUpdates') {
        return {
          body: {
            ok: true,
            result: [
              textMessage({ updateId: 20, chatType: 'group', chatId: -1001, text: 'lunch?' }),
              textMessage({ updateId: 21, chatType: 'group', chatId: -1001, text: '@testbot deploy it' }),
              textMessage({ updateId: 22, chatType: 'group', chatId: -1001, text: 'yes please', replyToBot: true }),
            ],
          },
        }
      }
      void body
      return undefined
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(baseConfig(fake.url, { chats: ['-1001'] }), ctx) as TelegramSource

    const result = await source.pollOnce(new AbortController().signal)

    expect(result.received).toBe(2)
    expect(result.filtered).toBe(1)
    expect(triggers.map(trigger => trigger.thread.key)).toEqual([
      'telegram:chat:-1001',
      'telegram:chat:-1001',
    ])
    expect(triggers.map(trigger => trigger.addressed)).toEqual(['mention', 'mention'])
  })

  it('skips the 24h backlog on first start unless processBacklog is on', async () => {
    const backlog = [
      textMessage({ updateId: 200, text: 'old message 1' }),
      textMessage({ updateId: 201, text: 'old message 2' }),
      textMessage({ updateId: 202, text: 'latest message' }),
    ]
    const fake = await startTelegram((method, body) => {
      if (method !== 'getUpdates') return undefined
      const offset = typeof body.offset === 'number' ? body.offset : 0
      if (offset === -1) return { body: { ok: true, result: [backlog[2]!] } }
      if (offset > 0) return { body: { ok: true, result: backlog.filter(update => update.update_id >= offset) } }
      return { body: { ok: true, result: backlog } }
    })

    const fresh = makeContext()
    const source = createSource(baseConfig(fake.url), fresh.ctx) as TelegramSource
    await source.pollOnce(new AbortController().signal)
    expect(fresh.triggers.map(trigger => trigger.text)).toEqual(['latest message'])
    expect(fresh.kv.get('telegram:offset')).toBe(203)

    const drain = makeContext()
    const draining = createSource(baseConfig(fake.url, { processBacklog: true }), drain.ctx) as TelegramSource
    await draining.pollOnce(new AbortController().signal)
    expect(drain.triggers).toHaveLength(3)
  })

  it('keeps the offset and retries the same update when Engine.receive reports failed', async () => {
    const fake = await startTelegram((method) => {
      if (method === 'getUpdates') {
        return { body: { ok: true, result: [textMessage({ updateId: 300, text: 'must survive' })] } }
      }
      return undefined
    })
    const forced: Array<'failed' | 'stored'> = ['failed', 'stored']
    const { ctx, triggers, kv } = makeContext('telegram', { receive: () => forced.shift() ?? 'stored' })
    const source = createSource(baseConfig(fake.url), ctx) as TelegramSource

    await expect(source.pollOnce(new AbortController().signal)).rejects.toThrow(/not stored/)

    // The first-run probe has no cursor yet: persist the failing update id
    // (offset is inclusive) instead of advancing past it.
    expect(kv.get('telegram:offset')).toBe(300)
    expect(triggers).toHaveLength(0)

    const second = await source.pollOnce(new AbortController().signal)
    expect(second.received).toBe(1)
    expect(triggers).toHaveLength(1)
    expect(triggers[0]!.id).toBe('telegram:msg:42:300')
    expect(kv.get('telegram:offset')).toBe(301)
  })

  it('is idempotent when a long-poll window is replayed', async () => {
    const fake = await startTelegram((method) => {
      if (method === 'getUpdates') {
        return { body: { ok: true, result: [textMessage({ updateId: 100 })] } }
      }
      return undefined
    })
    const { ctx, triggers, kv } = makeContext()
    const source = createSource(baseConfig(fake.url), ctx) as TelegramSource

    await source.pollOnce(new AbortController().signal)
    expect(triggers).toHaveLength(1)
    expect(kv.get('telegram:offset')).toBe(101)

    // Simulate a crash before the offset was flushed, then replay the same update.
    kv.set('telegram:offset', 0)
    const second = await source.pollOnce(new AbortController().signal)

    expect(second.received).toBe(1)
    expect(triggers).toHaveLength(1)
    expect(triggers[0]!.id).toBe('telegram:msg:42:100')
  })

  it('translates callback queries only when enabled', async () => {
    const callback = {
      update_id: 30,
      callback_query: {
        id: 'cb-1',
        from: { id: 42, is_bot: false, username: 'ann' },
        data: 'stop:t_9',
        message: {
          message_id: 55,
          date: 1_730_000_000,
          chat: { id: 42, type: 'private' },
          from: { id: 999, is_bot: true, username: 'testbot' },
        },
      },
    }
    const fake = await startTelegram((method) => {
      if (method === 'getUpdates') return { body: { ok: true, result: [callback] } }
      return undefined
    })
    const off = makeContext()
    const offSource = createSource(baseConfig(fake.url), off.ctx) as TelegramSource
    await offSource.pollOnce(new AbortController().signal)
    expect(off.triggers).toHaveLength(0)

    const on = makeContext()
    const onSource = createSource(baseConfig(fake.url, { observeCallbacks: true }), on.ctx) as TelegramSource
    await onSource.pollOnce(new AbortController().signal)
    expect(on.triggers).toHaveLength(1)
    expect(on.triggers[0]).toMatchObject({ kind: 'callback', addressed: 'direct', text: 'stop:t_9' })
    expect(fake.callsOf('answerCallbackQuery')).toHaveLength(1)
  })
})

describe('telegram source: local commands', () => {
  it('parses known commands, targets and arguments', () => {
    expect(parseTelegramCommand('/status')).toEqual({ name: 'status' })
    expect(parseTelegramCommand('/stop@MyBot t_1')).toEqual({ name: 'stop', target: 'mybot', argument: 't_1' })
    expect(parseTelegramCommand('/help now')).toEqual({ name: 'help', argument: 'now' })
    expect(parseTelegramCommand('hello /status')).toBeUndefined()
    expect(parseTelegramCommand('/unknown')).toBeUndefined()
  })

  it('runs commands through the injected handler and replies without creating Triggers', async () => {
    const calls: string[] = []
    const commands: TelegramCommands = {
      status: async () => {
        calls.push('status')
        return 'status ok'
      },
      pause: async () => {
        calls.push('pause')
        return 'paused'
      },
      resume: async () => {
        calls.push('resume')
        return 'resumed'
      },
      tickets: async () => {
        calls.push('tickets')
        return 'no tickets'
      },
      stopTicket: async (ticketId: string) => {
        calls.push(`stop:${ticketId}`)
        return `stopped ${ticketId}`
      },
      retryTicket: async (ticketId: string) => {
        calls.push(`retry:${ticketId}`)
        return `retried ${ticketId}`
      },
    }
    const fake = await startTelegram((method) => {
      if (method === 'getUpdates') {
        return {
          body: {
            ok: true,
            result: [
              textMessage({ updateId: 40, messageId: 40, text: '/status' }),
              textMessage({ updateId: 41, messageId: 41, text: '/help' }),
              textMessage({ updateId: 42, messageId: 42, text: '/stop t_1' }),
              textMessage({ updateId: 43, messageId: 43, text: '/stop@testbot t_2' }),
              textMessage({ updateId: 44, messageId: 44, text: '/stop' }),
              textMessage({ updateId: 45, messageId: 45, text: '/pause' }),
              textMessage({ updateId: 46, messageId: 46, text: '/resume' }),
              textMessage({ updateId: 47, messageId: 47, text: '/tickets' }),
              textMessage({ updateId: 48, messageId: 48, text: '/retry t_3' }),
              textMessage({ updateId: 49, messageId: 49, text: '/status@otherbot' }),
            ],
          },
        }
      }
      return undefined
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(baseConfig(fake.url, { commands }), ctx) as TelegramSource

    const result = await source.pollOnce(new AbortController().signal)

    expect(triggers).toHaveLength(0)
    expect(calls).toEqual(['status', 'stop:t_1', 'stop:t_2', 'pause', 'resume', 'tickets', 'retry:t_3'])
    expect(result.commands).toBe(9)
    expect(result.filtered).toBe(1)
    const replies = fake.callsOf('sendMessage').map(call => call.body.text)
    expect(replies).toContain('status ok')
    expect(replies).toContain('stopped t_1')
    expect(replies).toContain('用法：/stop <ticketId>')
  })

  it('reports an unavailable handler instead of throwing', async () => {
    const fake = await startTelegram((method) => {
      if (method === 'getUpdates') {
        return { body: { ok: true, result: [textMessage({ updateId: 60, text: '/status' })] } }
      }
      return undefined
    })
    const { ctx } = makeContext()
    const source = createSource(baseConfig(fake.url), ctx) as TelegramSource
    await source.pollOnce(new AbortController().signal)
    expect(fake.callsOf('sendMessage')[0]?.body.text).toContain('不可用')
  })
})

describe('telegram source: message splitting', () => {
  it('splits at safe boundaries without cutting a surrogate pair', () => {
    const text = `${'a'.repeat(4095)}😀${'b'.repeat(10)}`
    const chunks = chunkText(text)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every(chunk => chunk.length <= 4096)).toBe(true)
    expect(chunks[0]!.length).toBe(4095)
  })

  it('prefers a newline near the limit', () => {
    const chunks = chunkText(`${'x'.repeat(4000)}\n${'y'.repeat(4000)}`)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.length).toBe(4001)
    expect(chunks[1]).toBe('y'.repeat(4000))
  })
})

describe('telegram source: sending', () => {
  it('maps a ChannelAddress back to the chat and chunks long text at 4096 characters', async () => {
    const fake = await startTelegram()
    const { ctx } = makeContext()
    const source = createSource(baseConfig(fake.url), ctx) as TelegramSource
    const message: OutboundMessage = {
      id: 'm-1',
      purpose: 'result',
      channel: { source: 'telegram', thread: 'telegram:dm:42', to: '42' },
      text: 'x'.repeat(9000),
      at: new Date().toISOString(),
    }

    expect(await source.send(message)).toBe('sent')
    const sends = fake.callsOf('sendMessage')
    expect(sends).toHaveLength(3)
    expect(sends.map(call => String(call.body.text).length)).toEqual([4096, 4096, 808])
    expect(sends.every(call => call.body.chat_id === 42)).toBe(true)
    expect(sends.every(call => call.body.parse_mode === undefined)).toBe(true)
  })

  it('retries a 429 answer with retry_after and succeeds', async () => {
    let sendCalls = 0
    const fake = await startTelegram((method) => {
      if (method === 'sendMessage') {
        sendCalls += 1
        if (sendCalls === 1) {
          return {
            status: 429,
            body: {
              ok: false,
              error_code: 429,
              description: 'Too Many Requests: retry later',
              parameters: { retry_after: 0 },
            },
          }
        }
      }
      return undefined
    })
    const { ctx } = makeContext()
    const source = createSource(baseConfig(fake.url), ctx) as TelegramSource

    const outcome = await source.send({
      id: 'm-2',
      purpose: 'answer',
      channel: { source: 'telegram', thread: 'telegram:dm:42', to: '42' },
      text: 'hello',
      at: new Date().toISOString(),
    })

    expect(outcome).toBe('sent')
    expect(fake.callsOf('sendMessage')).toHaveLength(2)
  })

  it('reports a blocked chat as gone and refuses chats outside the allowlist', async () => {
    const fake = await startTelegram((method) => {
      if (method === 'sendMessage') {
        return { status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } }
      }
      return undefined
    })
    const { ctx } = makeContext()
    const source = createSource(baseConfig(fake.url), ctx) as TelegramSource

    expect(
      await source.send({
        id: 'm-3',
        purpose: 'notice',
        channel: { source: 'telegram', thread: 'telegram:dm:42', to: '42' },
        text: 'hi',
        at: new Date().toISOString(),
      }),
    ).toBe('gone')

    expect(
      await source.send({
        id: 'm-4',
        purpose: 'notice',
        channel: { source: 'telegram', thread: 'telegram:dm:7', to: '7' },
        text: 'hi',
        at: new Date().toISOString(),
      }),
    ).toBe('gone')
    expect(source.channelAllowed({ source: 'telegram', thread: 'telegram:dm:42', to: '42' })).toBe(true)
    expect(source.channelAllowed({ source: 'telegram', thread: 'telegram:dm:7', to: '7' })).toBe(false)
    expect(source.channelAllowed({ source: 'github', thread: 'github:o/r#1', to: 'o/r#1' })).toBe(false)
  })

  it('sends Telegram-safe HTML only when Markdown is requested', async () => {
    const fake = await startTelegram()
    const { ctx } = makeContext()
    const source = createSource(baseConfig(fake.url), ctx) as TelegramSource
    await source.send({
      id: 'm-5',
      purpose: 'result',
      channel: { source: 'telegram', thread: 'telegram:dm:42', to: '42' },
      text: '**done** & <ok> `x`',
      markdown: 'telegram',
      at: new Date().toISOString(),
    })
    const send = fake.callsOf('sendMessage')[0]!
    expect(send.body.parse_mode).toBe('HTML')
    expect(send.body.text).toBe('<b>done</b> &amp; &lt;ok&gt; <code>x</code>')
  })
})

describe('telegram source: loop resilience', () => {
  it('turns a missing token into health instead of an unhandled rejection', async () => {
    const { ctx, health } = makeContext()
    const source = createSource(
      { tokenEnv: 'SUPERAGENT_TEST_MISSING_TOKEN_XYZ', allowedUserIds: ['42'], pollTimeoutSeconds: 0 },
      ctx,
    ) as TelegramSource
    await source.start()
    await waitFor(() => health.some(entry => (entry.detail ?? '').includes('SUPERAGENT_TEST_MISSING_TOKEN_XYZ')))
    await source.stop()
    expect(source.healthState()).toBe('off')
    // The error names the variable, never a value.
    expect(health.every(entry => !(entry.detail ?? '').includes('bot-token-value'))).toBe(true)
  })

  it('stop() interrupts an in-flight long poll', async () => {
    const fake = await startTelegram((method) => {
      if (method === 'getUpdates') return { pending: true }
      return undefined
    })
    const { ctx } = makeContext()
    const source = createSource(baseConfig(fake.url, { pollSeconds: 0.01 }), ctx)
    await source.start()
    await waitFor(() => fake.callsOf('getUpdates').length > 0)
    const started = Date.now()
    await source.stop()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(fake.callsOf('getUpdates').length).toBe(1)
  })

  it('normalizes configuration safely', () => {
    const config = normalizeTelegramConfig({ allowedUserIds: [42, '43', '43'], pollSeconds: 0, pollTimeoutSeconds: 9999 })
    expect(config.allowedUserIds).toEqual(['42', '43'])
    expect(config.pollSeconds).toBeGreaterThan(0)
    expect(config.pollTimeoutSeconds).toBeLessThanOrEqual(300)
  })
})

describe('telegram token validation (stateless setup helper)', () => {
  const TOKEN = '123456789:fake-setup-token-not-a-secret'

  it('reports the bot id and username for a working token', async () => {
    const fake = await startTelegram()
    await expect(validateTelegramToken(TOKEN, { apiBaseUrl: fake.url, timeoutMs: 500 })).resolves.toEqual({
      ok: true,
      id: 999,
      username: 'testbot',
    })
  })

  it('reports a 401 without leaking the token', async () => {
    const fake = await startTelegram(method => {
      if (method === 'getMe') {
        return { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }
      }
      return undefined
    })
    let error: unknown
    try {
      await validateTelegramToken(TOKEN, { apiBaseUrl: fake.url, timeoutMs: 500 })
      expect.unreachable()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(TelegramTokenValidationError)
    expect(String(error)).toContain('Telegram error 401')
    expect(String(error)).toContain('Unauthorized')
    expect(String(error)).not.toContain(TOKEN)
  })

  it('reports a timeout without leaking the token', async () => {
    const fake = await startTelegram(method => {
      if (method === 'getMe') return { pending: true }
      return undefined
    })
    const started = Date.now()
    let error: unknown
    try {
      await validateTelegramToken(TOKEN, { apiBaseUrl: fake.url, timeoutMs: 50 })
      expect.unreachable()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(TelegramTokenValidationError)
    expect(String(error)).toMatch(/timeout/i)
    expect(String(error)).not.toContain(TOKEN)
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('rejects an empty token without calling the network', async () => {
    await expect(validateTelegramToken('   ')).rejects.toThrow(/empty/)
  })
})

// ---------------------------------------------------------------------------
// Rich text, files, inline keyboards and topics
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString()
}

describe('telegram source: rich text', () => {
  it('converts the markdown subset to Telegram-safe HTML', () => {
    const html = markdownToTelegramHtml(
      [
        '**bold** *italic* `code`',
        '- one',
        '- two',
        '[site](https://example.com/?a=1&b=2)',
        '```js',
        'const x = 1 < 2',
        '```',
        '& < >',
      ].join('\n'),
    )
    expect(html).toContain('<b>bold</b>')
    expect(html).toContain('<i>italic</i>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('• one')
    expect(html).toContain('<a href="https://example.com/?a=1&amp;b=2">site</a>')
    expect(html).toContain('<pre><code class="language-js">')
    expect(html).toContain('const x = 1 &lt; 2')
    expect(html).toContain('&amp; &lt; &gt;')
    expect(html).not.toContain('**')
  })

  it('chunks rendered HTML at 4096 without breaking tags', () => {
    const html = markdownToTelegramHtml(
      Array.from({ length: 400 }, (_value, index) => `**word${index}** and some text`).join('\n'),
    )
    const chunks = chunkTelegramHtml(html, 4096)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096)
      expect((chunk.match(/<b>/g) ?? []).length).toBe((chunk.match(/<\/b>/g) ?? []).length)
    }
    expect(stripTelegramHtml(html)).toContain('word399')
  })

  it('falls back to plain text when Telegram rejects the HTML entities', async () => {
    let sends = 0
    const fake = await startTelegram(method => {
      if (method === 'sendMessage') {
        sends += 1
        if (sends === 1) {
          return {
            status: 400,
            body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
          }
        }
      }
      return undefined
    })
    const { ctx } = makeContext()
    const source = createSource(baseConfig(fake.url), ctx) as TelegramSource

    const outcome = await source.send({
      id: 'rich-1',
      purpose: 'answer',
      channel: { source: 'telegram', thread: 'telegram:dm:42', to: '42' },
      text: '**bold** & <x>',
      markdown: 'telegram',
      at: nowIso(),
    })

    expect(outcome).toBe('sent')
    const sendsCalls = fake.callsOf('sendMessage')
    expect(sendsCalls).toHaveLength(2)
    expect(sendsCalls[0]!.body.parse_mode).toBe('HTML')
    expect(sendsCalls[0]!.body.text).toContain('<b>bold</b>')
    expect(sendsCalls[1]!.body.parse_mode).toBeUndefined()
    expect(sendsCalls[1]!.body.text).toBe('bold & <x>')
  })
})

describe('telegram source: outgoing files', () => {
  it('sends photo and document attachments with captions', async () => {
    const dir = tempDir('telegram-attach')
    const workDir = join(dir, 'work', 't_1')
    mkdirSync(workDir, { recursive: true })
    const photo = join(workDir, 'pixel.png')
    const document = join(workDir, 'report.pdf')
    writeFileSync(photo, Buffer.from([1, 2, 3, 4]))
    writeFileSync(document, '%PDF-1.4')
    const fake = await startTelegram()
    const { ctx, loggerWarnings } = makeContext('telegram', { stateDir: dir })
    const source = createSource(baseConfig(fake.url), ctx) as TelegramSource

    const outcome = await source.send({
      id: 'files-1',
      purpose: 'notice',
      channel: { source: 'telegram', thread: 'telegram:dm:42', to: '42' },
      text: 'here are the files',
      attachments: [
        { kind: 'photo', path: photo, caption: 'pixel' },
        { kind: 'document', path: document, name: 'report.pdf', caption: 'report' },
      ],
      at: nowIso(),
    })

    expect(outcome).toBe('sent')
    const photoCall = fake.callsOf('sendPhoto')[0]!
    expect(photoCall.raw).toContain('name="photo"')
    expect(photoCall.raw).toContain('pixel')
    expect(photoCall.raw).toContain('here are the files'.length > 0 ? 'caption' : '')
    const documentCall = fake.callsOf('sendDocument')[0]!
    expect(documentCall.raw).toContain('name="document"')
    expect(documentCall.raw).toContain('report.pdf')
    expect(loggerWarnings).toEqual([])
  })

  it('keeps CJK file names and their extension in the uploaded document', async () => {
    const dir = tempDir('telegram-attach-cjk')
    const workDir = join(dir, 'work', 't_2')
    mkdirSync(workDir, { recursive: true })
    const report = join(workDir, 'performance_report.md')
    writeFileSync(report, '# report')
    const fake = await startTelegram()
    const { ctx } = makeContext('telegram', { stateDir: dir })
    const source = createSource(baseConfig(fake.url), ctx) as TelegramSource

    const outcome = await source.send({
      id: 'files-cjk',
      purpose: 'notice',
      channel: { source: 'telegram', thread: 'telegram:dm:42', to: '42' },
      text: 'report attached',
      attachments: [{ kind: 'document', path: report, name: '排序算法性能分析报告.md' }],
      at: nowIso(),
    })

    expect(outcome).toBe('sent')
    const raw = fake.callsOf('sendDocument')[0]!.raw as string
    expect(raw).toContain('排序算法性能分析报告.md')
    expect(raw).not.toContain('filename="md"')
  })

  it('keeps the text message when an attachment upload fails', async () => {
    const dir = tempDir('telegram-attach-fail')
    const photo = join(dir, 'fail.png')
    writeFileSync(photo, 'not an image')
    const fake = await startTelegram(method => {
      if (method === 'sendPhoto') {
        return { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: invalid file' } }
      }
      return undefined
    })
    const { ctx, loggerWarnings } = makeContext('telegram', { stateDir: dir })
    const source = createSource(baseConfig(fake.url), ctx) as TelegramSource

    const outcome = await source.send({
      id: 'files-2',
      purpose: 'result',
      channel: { source: 'telegram', thread: 'telegram:dm:42', to: '42' },
      text: 'text still arrives',
      attachments: [{ kind: 'photo', path: photo }],
      at: nowIso(),
    })

    expect(outcome).toBe('sent')
    expect(fake.callsOf('sendMessage')).toHaveLength(1)
    expect(loggerWarnings).toHaveLength(1)
    expect(String(loggerWarnings[0]!.kind)).toBe('photo')
  })
})

describe('telegram source: incoming media', () => {
  function mediaUpdate(updateId: number, message: Record<string, unknown>): TelegramUpdate {
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 1_730_000_000,
        from: { id: 42, is_bot: false, first_name: 'Ann', username: 'ann' },
        chat: { id: 42, type: 'private' },
        ...message,
      },
    } as TelegramUpdate
  }

  it('downloads the largest photo into <stateDir>/downloads and records it in meta', async () => {
    const dir = tempDir('telegram-download')
    const fake = await startTelegram((method, body) => {
      if (method === 'getFile') {
        expect(body.file_id).toBe('large')
        return { body: { ok: true, result: { file_id: 'large', file_path: 'photos/file_42.jpg' } } }
      }
      if (method === 'downloadFile') {
        expect(body.filePath).toBe('photos/file_42.jpg')
        return { raw: 'JPEGDATA' }
      }
      if (method === 'getUpdates') {
        return {
          body: {
            ok: true,
            result: [
              mediaUpdate(400, {
                caption: 'look at this',
                photo: [
                  { file_id: 'small', width: 10, height: 10, file_size: 5 },
                  { file_id: 'large', width: 100, height: 100, file_size: 8 },
                ],
              }),
            ],
          },
        }
      }
      return undefined
    })
    const { ctx, triggers, loggerWarnings } = makeContext('telegram', { stateDir: dir })
    const source = createSource(baseConfig(fake.url), ctx) as TelegramSource

    const result = await source.pollOnce(new AbortController().signal)

    expect(result.received).toBe(1)
    expect(triggers).toHaveLength(1)
    const trigger = triggers[0]!
    expect(trigger.text).toBe('look at this')
    const attachments = trigger.meta.attachments as Array<Record<string, unknown>>
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({ kind: 'photo', name: 'photo.jpg', size: 8 })
    const path = String(attachments[0]!.path)
    expect(path.startsWith(join(dir, 'downloads'))).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('JPEGDATA')
    expect(loggerWarnings).toEqual([])
  })

  it('skips media above maxDownloadBytes but still delivers the caption', async () => {
    const dir = tempDir('telegram-limit')
    const fake = await startTelegram(method => {
      if (method === 'getUpdates') {
        return {
          body: {
            ok: true,
            result: [
              mediaUpdate(401, {
                caption: 'too big',
                document: { file_id: 'huge', file_name: 'huge.zip', file_size: 5_000 },
              }),
            ],
          },
        }
      }
      return undefined
    })
    const { ctx, triggers, loggerWarnings } = makeContext('telegram', { stateDir: dir })
    const source = createSource(baseConfig(fake.url, { maxDownloadBytes: 2_000 }), ctx) as TelegramSource

    await source.pollOnce(new AbortController().signal)

    expect(triggers).toHaveLength(1)
    expect(triggers[0]!.text).toBe('too big')
    expect(triggers[0]!.meta.attachments).toBeUndefined()
    expect(fake.callsOf('getFile')).toHaveLength(0)
    expect(loggerWarnings).toHaveLength(1)
    expect(loggerWarnings[0]!.limit).toBe(2_000)
  })

  it('sanitizes document file names and logs download failures without leaking the token', async () => {
    const dir = tempDir('telegram-doc')
    const fake = await startTelegram(method => {
      if (method === 'getUpdates') {
        return {
          body: {
            ok: true,
            result: [
              mediaUpdate(402, {
                document: { file_id: 'doc', file_name: '../evil name.pdf', file_size: 10 },
              }),
            ],
          },
        }
      }
      if (method === 'getFile') {
        return { status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: file unavailable' } }
      }
      return undefined
    })
    const { ctx, triggers, loggerWarnings } = makeContext('telegram', { stateDir: dir })
    const source = createSource(baseConfig(fake.url), ctx) as TelegramSource

    await source.pollOnce(new AbortController().signal)

    expect(triggers).toHaveLength(1)
    expect(triggers[0]!.meta.attachments).toBeUndefined()
    expect(loggerWarnings).toHaveLength(1)
    expect(String(loggerWarnings[0]!.kind)).toBe('document')
    expect(JSON.stringify(loggerWarnings)).not.toContain('test-token-not-a-secret')
  })
})

describe('telegram source: inline keyboards and advanced', () => {
  const commands: TelegramCommands = {
    status: async () => 'ok',
    pause: async () => 'paused',
    resume: async () => 'resumed',
    tickets: async () => 'none',
    stopTicket: async (ticketId: string) => `stopped ${ticketId}`,
    retryTicket: async (ticketId: string) => `retried ${ticketId}`,
  }

  it('attaches actionable buttons to attention and result messages', async () => {
    const fake = await startTelegram()
    const { ctx } = makeContext()
    const source = createSource(baseConfig(fake.url, { commands }), ctx) as TelegramSource

    await source.send({
      id: 'kb-1',
      ticketId: 't_1',
      purpose: 'attention',
      channel: { source: 'telegram', thread: 'telegram:dm:42', to: '42' },
      text: 'blocked',
      at: nowIso(),
    })

    const send = fake.callsOf('sendMessage')[0]!
    const markup = JSON.parse(String(send.body.reply_markup)) as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
    }
    expect(markup.inline_keyboard).toHaveLength(1)
    expect(markup.inline_keyboard[0]!.map(button => button.callback_data)).toEqual([
      'sa:ack:t_1',
      'sa:retry:t_1',
      'sa:stop:t_1',
    ])
  })

  it('routes sa: button callbacks to TelegramCommands and removes the keyboard', async () => {
    const retried: string[] = []
    const commandsWithRetry: TelegramCommands = {
      ...commands,
      retryTicket: async (ticketId: string) => {
        retried.push(ticketId)
        return `retried ${ticketId}`
      },
    }
    const fake = await startTelegram(method => {
      if (method === 'getUpdates') {
        return {
          body: {
            ok: true,
            result: [
              {
                update_id: 500,
                callback_query: {
                  id: 'cb-1',
                  from: { id: 42, is_bot: false, username: 'ann' },
                  data: 'sa:retry:t_1',
                  message: {
                    message_id: 9,
                    date: 1_730_000_000,
                    chat: { id: 42, type: 'private' },
                    from: { id: 999, is_bot: true, username: 'testbot' },
                  },
                },
              },
            ],
          },
        }
      }
      return undefined
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(baseConfig(fake.url, { commands: commandsWithRetry }), ctx) as TelegramSource

    const result = await source.pollOnce(new AbortController().signal)

    expect(result.commands).toBe(1)
    expect(triggers).toHaveLength(0)
    expect(retried).toEqual(['t_1'])
    expect(fake.callsOf('answerCallbackQuery')[0]!.body.text).toBe('retried t_1')
    const edit = fake.callsOf('editMessageReplyMarkup')[0]!
    expect(edit.body.message_id).toBe(9)
    expect(JSON.parse(String(edit.body.reply_markup))).toEqual({ inline_keyboard: [] })
  })

  it('registers the bot command list once', async () => {
    const fake = await startTelegram()
    const { ctx } = makeContext()
    const source = createSource(baseConfig(fake.url), ctx) as TelegramSource

    await source.pollOnce(new AbortController().signal)

    const registrations = fake.callsOf('setMyCommands')
    expect(registrations).toHaveLength(1)
    const list = registrations[0]!.body.commands as Array<{ command: string; description: string }>
    expect(list.map(item => item.command)).toEqual([
      'status',
      'pause',
      'resume',
      'tickets',
      'stop',
      'retry',
      'help',
    ])
  })

  it('reads and writes forum topic ids', async () => {
    const fake = await startTelegram(method => {
      if (method === 'getUpdates') {
        return {
          body: {
            ok: true,
            result: [
              {
                update_id: 600,
                message: {
                  message_id: 600,
                  date: 1_730_000_000,
                  is_topic_message: true,
                  message_thread_id: 77,
                  from: { id: 42, is_bot: false, first_name: 'Ann' },
                  chat: { id: -1001, type: 'supergroup', title: 'Ops' },
                  text: '@testbot deploy it',
                },
              },
            ],
          },
        }
      }
      return undefined
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(baseConfig(fake.url, { chats: ['-1001'] }), ctx) as TelegramSource

    await source.pollOnce(new AbortController().signal)

    expect(triggers).toHaveLength(1)
    const trigger = triggers[0]!
    expect(trigger.thread.key).toBe('telegram:chat:-1001:topic:77')
    expect(trigger.meta.messageThreadId).toBe(77)
    expect(trigger.channel.replyTo).toBe('600')

    await source.send({
      id: 'topic-1',
      purpose: 'notice',
      channel: trigger.channel,
      text: 'in topic',
      at: nowIso(),
    })
    const sent = fake.callsOf('sendMessage')[0]!
    expect(sent.body.message_thread_id).toBe(77)
  })
})

describe('telegram source: files and keyboards switches', () => {
  it('does not send attachments when files is false but keeps the text', async () => {
    const dir = tempDir('telegram-files-off')
    const photo = join(dir, 'pixel.png')
    writeFileSync(photo, Buffer.from([1, 2, 3]))
    const fake = await startTelegram()
    const { ctx, loggerWarnings } = makeContext('telegram', { stateDir: dir })
    const source = createSource(baseConfig(fake.url, { files: false }), ctx) as TelegramSource

    const outcome = await source.send({
      id: 'files-off-1',
      purpose: 'result',
      channel: { source: 'telegram', thread: 'telegram:dm:42', to: '42' },
      text: 'text still sent',
      attachments: [{ kind: 'photo', path: photo }],
      at: nowIso(),
    })

    expect(outcome).toBe('sent')
    expect(fake.callsOf('sendMessage')).toHaveLength(1)
    expect(fake.callsOf('sendPhoto')).toHaveLength(0)
    expect(fake.callsOf('sendDocument')).toHaveLength(0)
    expect(loggerWarnings).toEqual([])
  })

  it('does not upload an attachment-only message when files is false', async () => {
    const dir = tempDir('telegram-files-only')
    const document = join(dir, 'report.pdf')
    writeFileSync(document, '%PDF')
    const fake = await startTelegram()
    const { ctx } = makeContext('telegram', { stateDir: dir })
    const source = createSource(baseConfig(fake.url, { files: false }), ctx) as TelegramSource

    const outcome = await source.send({
      id: 'files-off-2',
      purpose: 'result',
      channel: { source: 'telegram', thread: 'telegram:dm:42', to: '42' },
      text: '',
      attachments: [{ kind: 'document', path: document }],
      at: nowIso(),
    })

    expect(outcome).toBe('sent')
    expect(fake.callsOf('sendMessage')).toHaveLength(0)
    expect(fake.callsOf('sendDocument')).toHaveLength(0)
  })

  it('does not download incoming media when files is false', async () => {
    const fake = await startTelegram(method => {
      if (method === 'getUpdates') {
        return {
          body: {
            ok: true,
            result: [
              {
                update_id: 700,
                message: {
                  message_id: 700,
                  date: 1_730_000_000,
                  from: { id: 42, is_bot: false, first_name: 'Ann' },
                  chat: { id: 42, type: 'private' },
                  caption: 'just the caption',
                  photo: [{ file_id: 'p1', width: 10, height: 10, file_size: 100 }],
                },
              },
            ],
          },
        }
      }
      return undefined
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(baseConfig(fake.url, { files: false }), ctx) as TelegramSource

    await source.pollOnce(new AbortController().signal)

    expect(triggers).toHaveLength(1)
    expect(triggers[0]!.text).toBe('just the caption')
    expect(triggers[0]!.meta.attachments).toBeUndefined()
    expect(fake.callsOf('getFile')).toHaveLength(0)
  })

  it('does not attach or handle inline keyboards when keyboards is false', async () => {
    const retried: string[] = []
    const commands: TelegramCommands = {
      status: async () => 'ok',
      pause: async () => 'paused',
      resume: async () => 'resumed',
      tickets: async () => 'none',
      stopTicket: async (ticketId: string) => `stopped ${ticketId}`,
      retryTicket: async (ticketId: string) => {
        retried.push(ticketId)
        return `retried ${ticketId}`
      },
    }
    const fake = await startTelegram(method => {
      if (method === 'getUpdates') {
        return {
          body: {
            ok: true,
            result: [
              {
                update_id: 701,
                callback_query: {
                  id: 'cb-off',
                  from: { id: 42, is_bot: false, username: 'ann' },
                  data: 'sa:retry:t_1',
                  message: {
                    message_id: 10,
                    date: 1_730_000_000,
                    chat: { id: 42, type: 'private' },
                    from: { id: 999, is_bot: true, username: 'testbot' },
                  },
                },
              },
            ],
          },
        }
      }
      return undefined
    })
    const { ctx, triggers } = makeContext()
    const source = createSource(baseConfig(fake.url, { commands, keyboards: false }), ctx) as TelegramSource

    // Outgoing attention message: no inline keyboard is attached.
    await source.send({
      id: 'kb-off-1',
      ticketId: 't_1',
      purpose: 'attention',
      channel: { source: 'telegram', thread: 'telegram:dm:42', to: '42' },
      text: 'blocked',
      at: nowIso(),
    })
    expect(fake.callsOf('sendMessage')[0]!.body.reply_markup).toBeUndefined()

    // Incoming sa: callback: ignored entirely, no command and no callback answer.
    const result = await source.pollOnce(new AbortController().signal)
    expect(result.commands).toBe(0)
    expect(triggers).toHaveLength(0)
    expect(retried).toEqual([])
    expect(fake.callsOf('answerCallbackQuery')).toHaveLength(0)
    expect(fake.callsOf('editMessageReplyMarkup')).toHaveLength(0)
  })
})

describe('telegram source: P0 attachment and replay safety', () => {
  it('refuses attachments outside stateDir work/downloads and symlinks', async () => {
    const base = tempDir('telegram-attach-guard')
    const stateDir = join(base, 'state')
    const workDir = join(stateDir, 'work', 't_1')
    mkdirSync(workDir, { recursive: true })
    mkdirSync(join(stateDir, 'downloads'), { recursive: true })
    const outsideDir = join(base, 'outside')
    mkdirSync(outsideDir, { recursive: true })
    const outside = join(outsideDir, 'secret.txt')
    writeFileSync(outside, 'top secret')
    const inside = join(workDir, 'ok.txt')
    writeFileSync(inside, 'fine')
    const link = join(workDir, 'link.txt')
    symlinkSync(outside, link)

    const fake = await startTelegram()
    const { ctx, loggerWarnings } = makeContext('telegram', { stateDir })
    const source = createSource(baseConfig(fake.url), ctx) as TelegramSource

    const outcome = await source.send({
      id: 'attach-guard-1',
      purpose: 'result',
      channel: { source: 'telegram', thread: 'telegram:dm:42', to: '42' },
      text: 'files attached',
      attachments: [
        { kind: 'document', path: outside },
        { kind: 'document', path: link },
        { kind: 'document', path: inside, name: '../evil name.txt' },
      ],
      at: nowIso(),
    })

    expect(outcome).toBe('sent')
    expect(fake.callsOf('sendDocument')).toHaveLength(1)
    expect(fake.callsOf('sendDocument')[0]!.raw).toContain('evil_name.txt')
    expect(fake.callsOf('sendDocument')[0]!.raw).not.toContain('secret')
    expect(loggerWarnings).toHaveLength(2)
  })

  it('prefixes downloads with the chat id so chats cannot overwrite each other', async () => {
    const dir = tempDir('telegram-unique')
    let downloadCount = 0
    const fake = await startTelegram((method, body) => {
      if (method === 'getUpdates') {
        return {
          body: {
            ok: true,
            result: [
              {
                update_id: 800,
                message: {
                  message_id: 500,
                  date: 1_730_000_000,
                  from: { id: 42, is_bot: false, first_name: 'Ann' },
                  chat: { id: 42, type: 'private' },
                  caption: 'dm',
                  photo: [{ file_id: 'dm-photo', width: 10, height: 10, file_size: 4 }],
                },
              },
              {
                update_id: 801,
                message: {
                  message_id: 500,
                  date: 1_730_000_000,
                  from: { id: 42, is_bot: false, first_name: 'Ann' },
                  chat: { id: -1001, type: 'supergroup', title: 'Ops' },
                  caption: '@testbot group',
                  photo: [{ file_id: 'group-photo', width: 10, height: 10, file_size: 4 }],
                },
              },
            ],
          },
        }
      }
      if (method === 'getFile') {
        const id = String(body.file_id)
        return { body: { ok: true, result: { file_id: id, file_path: `photos/${id}.jpg` } } }
      }
      if (method === 'downloadFile') {
        downloadCount += 1
        return { raw: `DATA-${downloadCount}` }
      }
      return undefined
    })
    const { ctx, triggers } = makeContext('telegram', { stateDir: dir })
    const source = createSource(baseConfig(fake.url, { chats: ['-1001'] }), ctx) as TelegramSource

    await source.pollOnce(new AbortController().signal)

    expect(triggers).toHaveLength(2)
    const paths = triggers.map(trigger => {
      const attachments = trigger.meta.attachments as Array<Record<string, unknown>>
      return String(attachments[0]!.path)
    })
    expect(paths[0]).toContain('42-500-')
    expect(paths[1]).toContain('-1001-500-')
    expect(paths[0]).not.toBe(paths[1])
    expect(new Set(paths).size).toBe(2)
  })

  it('does not replay a command twice when the offset was not persisted', async () => {
    let pauses = 0
    const commands: TelegramCommands = {
      status: async () => 'ok',
      pause: async () => {
        pauses += 1
        return 'paused'
      },
      resume: async () => 'resumed',
      tickets: async () => 'none',
      stopTicket: async (ticketId: string) => `stopped ${ticketId}`,
      retryTicket: async (ticketId: string) => `retried ${ticketId}`,
    }
    const fake = await startTelegram(method => {
      if (method === 'getUpdates') {
        return { body: { ok: true, result: [textMessage({ updateId: 900, messageId: 900, text: '/pause' })] } }
      }
      return undefined
    })
    const { ctx, kv } = makeContext()
    const source = createSource(baseConfig(fake.url, { commands }), ctx) as TelegramSource

    await source.pollOnce(new AbortController().signal)
    expect(pauses).toBe(1)

    // Simulate a crash before the offset write: the same update is replayed.
    kv.set('telegram:offset', 0)
    await source.pollOnce(new AbortController().signal)
    expect(pauses).toBe(1)
  })

  it('does not replay a sa: callback twice when the offset was not persisted', async () => {
    const retried: string[] = []
    const commands: TelegramCommands = {
      status: async () => 'ok',
      pause: async () => 'paused',
      resume: async () => 'resumed',
      tickets: async () => 'none',
      stopTicket: async (ticketId: string) => `stopped ${ticketId}`,
      retryTicket: async (ticketId: string) => {
        retried.push(ticketId)
        return 'retried'
      },
    }
    const fake = await startTelegram(method => {
      if (method === 'getUpdates') {
        return {
          body: {
            ok: true,
            result: [
              {
                update_id: 901,
                callback_query: {
                  id: 'cb-replay',
                  from: { id: 42, is_bot: false, username: 'ann' },
                  data: 'sa:retry:t_1',
                  message: {
                    message_id: 11,
                    date: 1_730_000_000,
                    chat: { id: 42, type: 'private' },
                    from: { id: 999, is_bot: true, username: 'testbot' },
                  },
                },
              },
            ],
          },
        }
      }
      return undefined
    })
    const { ctx, kv, triggers } = makeContext()
    const source = createSource(baseConfig(fake.url, { commands }), ctx) as TelegramSource

    await source.pollOnce(new AbortController().signal)
    expect(retried).toEqual(['t_1'])
    expect(fake.callsOf('answerCallbackQuery')).toHaveLength(1)

    kv.set('telegram:offset', 0)
    await source.pollOnce(new AbortController().signal)
    expect(retried).toEqual(['t_1'])
    expect(fake.callsOf('answerCallbackQuery')).toHaveLength(1)
    expect(triggers).toHaveLength(0)
  })
})
