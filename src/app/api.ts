/**
 * Management HTTP API consumed by the Web panel and the watchdog.
 *
 * Contract (docs/001-interfaces.md §3):
 *   GET  /superagent/api/state   → plugin/source/ticket/health snapshot
 *   POST /superagent/api/action  → { action, ticketId? }
 *
 * The routes are raw `ctx.webServer` routes, not `/api` Remote endpoints, so
 * they implement their own fence: loopback peer only and the
 * `x-superagent-request: 1` header, which a cross-origin browser page cannot
 * send without a CORS preflight (denied by default). Everything else is 403.
 * The handlers never throw and never leak secrets.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IsoTime } from '../core/model.js'

export const API_PREFIX = '/superagent/api'
export const API_STATE_PATH = `${API_PREFIX}/state`
export const API_ACTION_PATH = `${API_PREFIX}/action`
export const API_VERSION = '0.1.0'
export const API_HEADER = 'x-superagent-request'

export interface PluginView {
  status: 'ready' | 'degraded' | 'starting' | 'stopped'
  detail: string | null
  version: string
}

export interface SourceView {
  id: string
  health: 'ready' | 'starting' | 'error' | 'off'
  detail: string | null
  at: IsoTime | null
}

export interface TicketActiveView {
  id: string
  title: string
  stage: string
  lastReport: string | null
  at: IsoTime
}

export interface TicketAttentionView {
  id: string
  title: string
  kind: 'blocked' | 'ready' | 'failed'
  question: string | null
  at: IsoTime
}

export interface ApiState {
  ok: true
  plugin: PluginView
  paused: boolean
  sources: SourceView[]
  tickets: {
    active: TicketActiveView[]
    attention: TicketAttentionView[]
  }
  health: Array<{ name: string; state: string; detail: string | null }>
}

export type ApiAction = 'pause' | 'resume' | 'retry' | 'stop' | 'check'

export interface ApiActionRequest {
  action: ApiAction
  ticketId?: string
}

export interface ApiActionValue {
  ok: boolean
  result?: string
  error?: string
}

/** What the API needs from the runtime. Kept structural to avoid an import cycle. */
export interface ApiDeps {
  state(): ApiState | Promise<ApiState>
  action(request: ApiActionRequest): ApiActionValue | Promise<ApiActionValue>
  logger?: { warn(message: string, extra?: Record<string, unknown>): void }
}

export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

const MAX_BODY_BYTES = 64 * 1024
const BODY_TIMEOUT_MS = 5_000
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress
  return typeof address === 'string' && LOOPBACK_ADDRESSES.has(address)
}

function hasApiHeader(req: IncomingMessage): boolean {
  const value = req.headers[API_HEADER]
  if (Array.isArray(value)) return value.includes('1')
  return value === '1'
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    if (res.headersSent) {
      res.end()
      return
    }
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  } catch {
    try {
      res.end()
    } catch {
      // the client is already gone
    }
  }
}

function sendForbidden(res: ServerResponse): void {
  sendJson(res, 403, { ok: false, error: 'forbidden' })
}

/** Read a bounded JSON request body. Rejects on timeout, size or invalid JSON. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    let settled = false
    const finish = (error: unknown, value?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      if (error) reject(error instanceof Error ? error : new Error(String(error)))
      else resolve(value)
    }
    const timer = setTimeout(() => {
      finish(new Error('request body timed out'))
    }, BODY_TIMEOUT_MS)
    timer.unref?.()
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        finish(new Error('request body too large'))
        return
      }
      chunks.push(buffer)
    }
    const onEnd = (): void => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) {
        finish(undefined, {})
        return
      }
      try {
        finish(undefined, JSON.parse(raw))
      } catch (error) {
        finish(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`))
      }
    }
    const onError = (error: Error): void => finish(error)
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

/** Validate the wire shape of an action request. */
export function parseActionRequest(body: unknown): ApiActionRequest {
  if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object')
  const record = body as Record<string, unknown>
  const action = record.action
  if (action !== 'pause' && action !== 'resume' && action !== 'retry' && action !== 'stop' && action !== 'check') {
    throw new Error('action must be one of pause|resume|retry|stop|check')
  }
  const ticketId = record.ticketId
  if (ticketId !== undefined && (typeof ticketId !== 'string' || ticketId.length === 0)) {
    throw new Error('ticketId must be a non-empty string')
  }
  if ((action === 'retry' || action === 'stop') && typeof ticketId !== 'string') {
    throw new Error(`action ${action} requires a ticketId`)
  }
  return { action, ...(typeof ticketId === 'string' ? { ticketId } : {}) }
}

/**
 * Register the two management routes. Returns a disposer; a missing web
 * server is reported and treated as "no panel on this profile".
 */
export function registerApi(ctx: Context, deps: ApiDeps): () => void {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (!webServer || typeof webServer.register !== 'function') {
    deps.logger?.warn('webServer service unavailable; the SuperAgent panel API is not registered')
    return () => undefined
  }
  const disposers: Array<() => void> = []
  const register = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): void => {
    try {
      disposers.push(webServer.register({ kind: 'exact', path, handler }))
    } catch (error) {
      deps.logger?.warn('could not register management route', { path, error: String(error) })
    }
  }

  register(API_STATE_PATH, async (req, res) => {
    try {
      if (!isLoopback(req) || !hasApiHeader(req)) {
        sendForbidden(res)
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const state = await deps.state()
      sendJson(res, 200, state)
    } catch (error) {
      deps.logger?.warn('state endpoint failed', { error: String(error) })
      sendJson(res, 500, { ok: false, error: 'internal error' })
    }
  })

  register(API_ACTION_PATH, async (req, res) => {
    try {
      if (!isLoopback(req) || !hasApiHeader(req)) {
        sendForbidden(res)
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let request: ApiActionRequest
      try {
        request = parseActionRequest(await readJsonBody(req))
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      const result = await deps.action(request)
      sendJson(res, 200, result)
    } catch (error) {
      deps.logger?.warn('action endpoint failed', { error: String(error) })
      sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // route disposal must never throw into the plugin teardown
      }
    }
  }
}
