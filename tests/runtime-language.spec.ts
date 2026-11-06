/**
 * Language configuration tests (task-18).
 *
 * The bot language is a runtime config (`language: 'zh' | 'en'`, zh default).
 * It must reach the Engine's user-facing copy, the role prompts, the Telegram
 * command replies and the setup API.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  Runtime,
  renderCommandReply,
  validateConfig,
  type RuntimeConfig,
} from '../src/app/runtime.js'
import { createMemoryStore } from '../src/app/store.js'
import { SETUP_STATE_PATH } from '../src/app/setup.js'
import { API_HEADER } from '../src/app/api.js'
import { workerSystemPrompt } from '../src/prompts/index.js'
import type { Context } from '@deepseek-ai/cordis'
import { makeTrigger } from './core-fixtures.js'
import { FakeSource, createFakeHost, until } from './runtime-host.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

interface LanguageHarness {
  runtime: Runtime
  host: ReturnType<typeof createFakeHost>
  source: FakeSource
  stateDir: string
}

async function startRuntime(language: 'zh' | 'en'): Promise<LanguageHarness> {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-lang-'))
  dirs.push(stateDir)
  const host = createFakeHost()
  const source = new FakeSource('telegram')
  const config: RuntimeConfig = {
    stateDir,
    sources: {
      telegram: { enabled: false, allowedUserIds: ['u1'] },
      github: { enabled: false },
    },
    policy: { mode: 'auto' },
    language,
    passIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    watchdog: { intervalMs: 60_000 },
  }
  const runtime = new Runtime(host.ctx as unknown as Context, config, {
    store: createMemoryStore(),
    sources: [{ id: 'telegram', source }],
    skipLock: true,
  })
  await runtime.ready
  return { runtime, host, source, stateDir }
}

/** Drive one candidate to an accepted ticket and a `ready` report, returning the user-facing text. */
async function readyMessage(harness: LanguageHarness, id: string, summary: string): Promise<string> {
  const { runtime, host, source } = harness
  const trigger = makeTrigger({ id, text: 'please deploy the thing' })
  expect(runtime.enginePort!.sources.receive(trigger)).toBe('stored')
  await runtime.pass('language-test')
  await runtime.pumpEffects()

  const router = host.agents.liveAgent('superagent-router')
  if (!router) throw new Error('router session was not created')
  const accepted = (await host.executeTool(router, 'superagent_route', {
    triggerId: trigger.id,
    outcome: 'accept',
    title: 'Deploy the thing',
  })).value as { ticketId?: string }
  const ticketId = accepted.ticketId!
  await runtime.pumpEffects()
  await until(() => host.agents.liveAgent(`superagent-worker-${ticketId}`) !== undefined, 4_000, 'worker session')

  const worker = host.agents.liveAgent(`superagent-worker-${ticketId}`)!
  await host.executeTool(worker, 'superagent_report', { kind: 'ready', summary })
  await runtime.pumpEffects()
  await until(() => source.sent.length > 0, 4_000, 'user-facing ready message')
  return source.sent[0]!.text
}

async function setupStateLanguage(harness: LanguageHarness): Promise<string> {
  const route = harness.host.webServer.route(SETUP_STATE_PATH)
  if (!route) throw new Error('setup/state route is not registered')
  const response = {
    statusCode: 0,
    body: '',
    headersSent: false,
    writeHead(status: number) {
      this.statusCode = status
      this.headersSent = true
    },
    end(text?: string) {
      this.body = text ?? ''
    },
  }
  await route.handler(
    {
      method: 'GET',
      headers: { [API_HEADER]: '1' },
      socket: { remoteAddress: '127.0.0.1' },
    } as never,
    response as never,
  )
  const parsed = JSON.parse(response.body) as { language?: string }
  return parsed.language ?? 'missing'
}

describe('language configuration (task-18)', () => {
  it('defaults to Chinese and localizes the Engine ready copy', async () => {
    const harness = await startRuntime('zh')
    try {
      expect(harness.runtime.language).toBe('zh')
      expect(await setupStateLanguage(harness)).toBe('zh')
      const text = await readyMessage(harness, 'tr_lang_zh', '部署完成')
      expect(text).toContain('已完成')
      expect(text).toContain('部署完成')
    } finally {
      await harness.runtime.stop()
    }
  })

  it('switches the Engine copy to English', async () => {
    const harness = await startRuntime('en')
    try {
      expect(harness.runtime.language).toBe('en')
      expect(await setupStateLanguage(harness)).toBe('en')
      const text = await readyMessage(harness, 'tr_lang_en', 'deployed')
      expect(text).toContain('Ready for review')
      expect(text).toContain('deployed')
      expect(text).not.toContain('已完成')
    } finally {
      await harness.runtime.stop()
    }
  })

  it('localizes Telegram command replies', () => {
    const zhStatus = renderCommandReply('status', 'zh', { state: 'ready', open: 2, sources: 'telegram:ready' })
    expect(zhStatus).toContain('正常')
    expect(zhStatus).toContain('2 个 Ticket')
    const enStatus = renderCommandReply('status', 'en', { state: 'ready', open: 2, sources: 'telegram:ready' })
    expect(enStatus).toContain('ready')
    expect(enStatus).toContain('2 ticket(s)')
    expect(renderCommandReply('pause', 'zh')).toContain('已暂停')
    expect(renderCommandReply('resume', 'en')).toContain('Resumed')
    expect(renderCommandReply('tickets', 'zh')).toContain('没有未完成的 Ticket')
    expect(renderCommandReply('stop', 'zh', { title: '修 CI' })).toContain('已停止')
    expect(renderCommandReply('retry', 'en', { title: 'Fix CI' })).toContain('Retry queued')
    expect(renderCommandReply('notFound', 'zh', { ticketId: 't_1' })).toContain('未找到')
  })

  it('validates the configured language', () => {
    expect(validateConfig({ stateDir: '/tmp/x', language: 'zh' }).problem).toBeUndefined()
    expect(validateConfig({ stateDir: '/tmp/x', language: 'en' }).problem).toBeUndefined()
    expect(validateConfig({ stateDir: '/tmp/x', language: 'fr' }).problem?.error).toContain('zh or en')
    expect(validateConfig({ stateDir: '/tmp/x' }).config?.language).toBeUndefined()
  })

  it('keeps the role prompts language-aware', () => {
    expect(workerSystemPrompt('zh')).toContain('始终使用简体中文')
    expect(workerSystemPrompt('en')).toContain('in English')
  })
})
