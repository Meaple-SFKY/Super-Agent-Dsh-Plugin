/**
 * Adapter tests for the Telegram Source: a real `node:http` fake Bot API, an
 * in-memory SourceContext, and no network access.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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
import { chunkText } from '../src/sources/telegram-api.js'
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
}

interface TelegramAnswer {
  status?: number
  headers?: Record<string, string>
  body?: unknown
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

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => server.close()))
})

async function startTelegram(handler: TelegramHandler = () => undefined): Promise<FakeTelegram> {
  const calls: FakeCall[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const match = /^\/bot[^/]+\/([A-Za-z]+)$/.exec(url.pathname)
      const method = match?.[1] ?? 'unknown'
      let body: Record<string, unknown> = {}
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        } catch {
          body = {}
        }
      }
      calls.push({ method, body })
      const answer = handler(method, body, calls.length) ?? defaultAnswer(method, body)
      if (!answer) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error_code: 404, description: 'not found' }))
        return
      }
      if (answer.pending) return
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
}

interface TestContextOptions {
  /** Override the Engine answer; `undefined` falls back to normal dedupe. */
  receive?: (trigger: Trigger) => Disposition | undefined
}

function makeContext(id = 'telegram', options: TestContextOptions = {}): TestContext {
  const kv = new Map<string, unknown>()
  const triggers: Trigger[] = []
  const health: SourceHealth[] = []
  const seen = new Set<string>()
  let counter = 0
  const logger: SourceLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
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
    stateDir: '/tmp/superagent-sources-test',
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
  return { ctx, triggers, health, kv }
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
