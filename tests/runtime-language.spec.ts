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
  USER_NOTICE_LIMIT,
  renderCommandReply,
  renderSafeModeNotice,
  resolveQuietMaxChars,
  sanitizeUserNotice,
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

async function startRuntime(
  language: 'zh' | 'en',
  quiet?: { maxChars?: number; minChars?: number },
): Promise<LanguageHarness> {
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
    ...(quiet ? { quiet } : {}),
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

describe('quiet message cap (task-21)', () => {
  it('only uses a positive maxChars, then minChars, then the Engine default', () => {
    expect(resolveQuietMaxChars({ maxChars: 0, minChars: 100 })).toBe(100)
    expect(resolveQuietMaxChars({ maxChars: -10, minChars: 100 })).toBe(100)
    expect(resolveQuietMaxChars({ maxChars: 0, minChars: 0 })).toBeUndefined()
    expect(resolveQuietMaxChars({})).toBeUndefined()
    expect(resolveQuietMaxChars(undefined)).toBeUndefined()
    expect(resolveQuietMaxChars({ maxChars: 42, minChars: 100 })).toBe(42)
    expect(resolveQuietMaxChars({ maxChars: Number.NaN, minChars: 80 })).toBe(80)
    expect(resolveQuietMaxChars({ maxChars: Number.POSITIVE_INFINITY, minChars: 80 })).toBe(80)
  })

  it('never produces a "…"-only result message when maxChars is 0 or missing', async () => {
    const longSummary = 'fixed the CineNest issue and opened the PR https://github.com/example/repo/pull/42 please review it when you can'
    for (const quiet of [{ maxChars: 0, minChars: 100 }, { maxChars: 0, minChars: 0 }, {}, { maxChars: -1, minChars: 100 }]) {
      const harness = await startRuntime('zh', quiet)
      try {
        const text = await readyMessage(harness, `tr_quiet_${JSON.stringify(quiet).length}_${Math.random().toString(36).slice(2, 6)}`, longSummary)
        expect(text).not.toBe('…')
        expect(text.length).toBeLessThanOrEqual(100)
        expect(text).toContain('已完成')
      } finally {
        await harness.runtime.stop()
      }
    }
  })

  it('honours a positive maxChars as the cap', async () => {
    const harness = await startRuntime('zh', { maxChars: 40, minChars: 100 })
    try {
      const text = await readyMessage(harness, 'tr_quiet_cap', 'x'.repeat(200))
      expect(text.length).toBeLessThanOrEqual(40)
      expect(text).toContain('已完成')
    } finally {
      await harness.runtime.stop()
    }
  })
})

describe('safe-mode user notice (task-24)', () => {
  const NASTY =
    'SuperAgent paused itself: effect launch failed 5 times: command failed (Command failed: /bin/sh -lc git clone git@github.com:owner/repo.git /Users/me/.dsh/state/work/t_abc)'

  it('is localized, short and free of commands/paths/error chains', () => {
    for (const language of ['zh', 'en'] as const) {
      const notice = renderSafeModeNotice(language)
      expect(notice.length).toBeLessThanOrEqual(USER_NOTICE_LIMIT)
      expect(notice).toContain('/resume')
      expect(notice).not.toMatch(/git clone|\/bin\/sh|command failed|effect launch|\/Users\/|git@github/)
      expect(notice).not.toContain('…')
    }
    expect(renderSafeModeNotice('zh')).toContain('已暂停自动处理')
    expect(renderSafeModeNotice('zh')).not.toContain('paused itself')
    expect(renderSafeModeNotice('en')).toContain('paused automatic work')
    expect(renderSafeModeNotice('en')).not.toContain('已暂停')
  })

  it('sanitizes any future notice as defense in depth', () => {
    const cleaned = sanitizeUserNotice(NASTY)
    expect(cleaned.length).toBeLessThanOrEqual(USER_NOTICE_LIMIT)
    expect(cleaned).not.toMatch(/\/bin\/sh|git clone|command failed|\/Users\/|git@github\.com/)
    expect(sanitizeUserNotice('x'.repeat(500)).length).toBeLessThanOrEqual(USER_NOTICE_LIMIT)
    expect(sanitizeUserNotice('`rm -rf /tmp/x` done')).not.toContain('rm -rf')
    expect(sanitizeUserNotice('see /Users/me/state/superagent.sqlite please')).not.toContain('/Users/me')
  })

  it('sends only the short localized notice when entering safe mode; details stay in health', async () => {
    const harness = await startRuntime('zh')
    try {
      const engine = harness.runtime.enginePort as unknown as { evaluateDue: () => void }
      engine.evaluateDue = () => {
        throw new Error('effect launch failed 5 times: command failed (Command failed: /bin/sh -lc git clone git@github.com:owner/repo.git /Users/me/state/work/t_1)')
      }
      for (let index = 0; index < 5; index++) await harness.runtime.pass('safe-mode-test')
      await until(() => harness.source.sent.length > 0, 4_000, 'safe-mode notice')

      const text = harness.source.sent[0]!.text
      expect(text).toContain('已暂停自动处理')
      expect(text.length).toBeLessThanOrEqual(USER_NOTICE_LIMIT)
      expect(text).not.toMatch(/\/bin\/sh|git clone|command failed|\/Users\/|git@github|effect launch/)

      // Details remain available to the panel/health (and the log).
      const state = harness.runtime.buildState()
      expect(state.plugin.status).toBe('degraded')
      expect(state.plugin.detail ?? '').toContain('safe mode')
      expect(state.plugin.detail ?? '').toContain('command failed')
      expect(harness.host.logger.text()).toContain('entering SAFE MODE')
    } finally {
      await harness.runtime.stop()
    }
  })
})
