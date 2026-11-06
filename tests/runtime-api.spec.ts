/**
 * Management API tests: wire shape, fence, method/body validation and error
 * handling. The panel and the watchdog consume exactly this contract.
 */

import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import {
  API_ACTION_PATH,
  API_HEADER,
  API_STATE_PATH,
  registerApi,
  parseActionRequest,
  type ApiActionRequest,
  type ApiDeps,
  type ApiState,
} from '../src/app/api.js'
import type { Context } from '@deepseek-ai/cordis'
import { FakeWebServer } from './runtime-host.js'

class FakeRequest extends EventEmitter {
  method: string
  headers: Record<string, string>
  socket: { remoteAddress: string }

  constructor(options: { method?: string; headers?: Record<string, string>; address?: string } = {}) {
    super()
    this.method = options.method ?? 'GET'
    this.headers = options.headers ?? {}
    this.socket = { remoteAddress: options.address ?? '127.0.0.1' }
  }

  feed(body?: string): void {
    if (body !== undefined) this.emit('data', Buffer.from(body))
    this.emit('end')
  }
}

class FakeResponse {
  statusCode = 200
  headers: Record<string, string> = {}
  body = ''
  headersSent = false

  writeHead(status: number, headers: Record<string, string> = {}): void {
    this.statusCode = status
    this.headers = headers
    this.headersSent = true
  }

  end(text?: string): void {
    this.body = text ?? ''
  }

  json<T = unknown>(): T {
    return JSON.parse(this.body) as T
  }
}

const fakeState: ApiState = {
  ok: true,
  plugin: { status: 'ready', detail: null, version: '0.1.0' },
  paused: false,
  sources: [{ id: 'telegram', health: 'ready', detail: null, at: '2026-01-01T00:00:00.000Z' }],
  tickets: {
    active: [{ id: 't_1', title: 'Fix CI', stage: 'working', lastReport: 'progress', at: '2026-01-01T00:00:00.000Z' }],
    attention: [{ id: 't_2', title: 'Waiting', kind: 'blocked', question: 'Proceed?', at: '2026-01-01T00:00:00.000Z' }],
  },
  health: [{ name: 'runtime', state: 'ready', detail: null }],
}

function makeApi(overrides: Partial<ApiDeps> = {}): { deps: ApiDeps; actions: ApiActionRequest[]; web: FakeWebServer; dispose: () => void } {
  const web = new FakeWebServer()
  const actions: ApiActionRequest[] = []
  const deps: ApiDeps = {
    state: () => fakeState,
    action: request => {
      actions.push(request)
      if (request.action === 'check') return { ok: true, result: 'checked' }
      if (request.action === 'retry') return { ok: true, result: `retry queued for ${request.ticketId}` }
      if (request.action === 'stop' && request.ticketId === 't_boom') throw new Error('boom')
      return { ok: true, result: request.action }
    },
    ...overrides,
  }
  const ctx = {
    get(name: string) {
      return name === 'webServer' ? web : undefined
    },
  } as unknown as Context
  const dispose = registerApi(ctx, deps)
  return { deps, actions, web, dispose }
}

describe('management API', () => {
  it('registers both exact routes and removes them on dispose', () => {
    const api = makeApi()
    expect(api.web.route(API_STATE_PATH)).toBeDefined()
    expect(api.web.route(API_ACTION_PATH)).toBeDefined()
    api.dispose()
    expect(api.web.route(API_STATE_PATH)).toBeUndefined()
  })

  it('serves the state snapshot and enforces the loopback + header fence', async () => {
    const api = makeApi()
    const route = api.web.route(API_STATE_PATH)!

    const forbidden = new FakeResponse()
    await route.handler(new FakeRequest(), forbidden)
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json<{ ok: boolean }>().ok).toBe(false)

    const remote = new FakeResponse()
    await route.handler(new FakeRequest({ headers: { [API_HEADER]: '1' }, address: '10.0.0.4' }), remote)
    expect(remote.statusCode).toBe(403)

    const ok = new FakeResponse()
    await route.handler(new FakeRequest({ headers: { [API_HEADER]: '1' } }), ok)
    expect(ok.statusCode).toBe(200)
    expect(ok.json<ApiState>()).toEqual(fakeState)

    const wrongMethod = new FakeResponse()
    await route.handler(new FakeRequest({ method: 'POST', headers: { [API_HEADER]: '1' } }), wrongMethod)
    expect(wrongMethod.statusCode).toBe(405)
  })

  it('accepts a valid action and rejects malformed requests', async () => {
    const api = makeApi()
    const route = api.web.route(API_ACTION_PATH)!

    const pause = new FakeRequest({ method: 'POST', headers: { [API_HEADER]: '1' } })
    const pauseResponse = new FakeResponse()
    const promise = route.handler(pause, pauseResponse)
    pause.feed('{"action":"pause"}')
    await promise
    expect(pauseResponse.statusCode).toBe(200)
    expect(pauseResponse.json()).toEqual({ ok: true, result: 'pause' })

    const retryMissingTicket = new FakeRequest({ method: 'POST', headers: { [API_HEADER]: '1' } })
    const retryResponse = new FakeResponse()
    const retryPromise = route.handler(retryMissingTicket, retryResponse)
    retryMissingTicket.feed('{"action":"retry"}')
    await retryPromise
    expect(retryResponse.statusCode).toBe(400)
    expect(retryResponse.json<{ error: string }>().error).toContain('ticketId')

    const invalid = new FakeRequest({ method: 'POST', headers: { [API_HEADER]: '1' } })
    const invalidResponse = new FakeResponse()
    const invalidPromise = route.handler(invalid, invalidResponse)
    invalid.feed('not json')
    await invalidPromise
    expect(invalidResponse.statusCode).toBe(400)

    const wrongMethod = new FakeRequest({ method: 'GET', headers: { [API_HEADER]: '1' } })
    const wrongMethodResponse = new FakeResponse()
    await route.handler(wrongMethod, wrongMethodResponse)
    expect(wrongMethodResponse.statusCode).toBe(405)

    const actions = api.actions
    expect(actions.map(entry => entry.action)).toContain('pause')
  })

  it('turns an action failure into an ok:false response instead of a 500', async () => {
    const api = makeApi()
    const route = api.web.route(API_ACTION_PATH)!
    const request = new FakeRequest({ method: 'POST', headers: { [API_HEADER]: '1' } })
    const response = new FakeResponse()
    const promise = route.handler(request, response)
    request.feed('{"action":"stop","ticketId":"t_boom"}')
    await promise
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: false, error: 'boom' })
  })

  it('validates action bodies', () => {
    expect(() => parseActionRequest(null)).toThrow('object')
    expect(() => parseActionRequest({ action: 'bogus' })).toThrow('pause|resume|retry|stop|check')
    expect(() => parseActionRequest({ action: 'pause', ticketId: 3 })).toThrow('ticketId')
    expect(parseActionRequest({ action: 'retry', ticketId: 't_1' })).toEqual({ action: 'retry', ticketId: 't_1' })
    expect(parseActionRequest({ action: 'check' })).toEqual({ action: 'check' })
  })
})
