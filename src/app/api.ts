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
import {
  SETUP_CONFIG_PATH,
  SETUP_GITHUB_PATH,
  SETUP_MODELS_PATH,
  SETUP_OPERATOR_PATH,
  SETUP_PERMISSIONS_PATH,
  SETUP_SSH_KEY_PATH,
  SETUP_STATE_PATH,
  SETUP_TELEGRAM_PATH,
  SETUP_WATCHDOG_PATH,
  type SetupApi,
} from './setup.js'

export const API_PREFIX = '/superagent/api'
export const API_STATE_PATH = `${API_PREFIX}/state`
export const API_ACTION_PATH = `${API_PREFIX}/action`
export const API_VERSION = '0.2.1'
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
  /** Setup wizard (docs/002); absent on hosts without a web server. */
  setup?: SetupApi
  logger?: { warn(message: string, extra?: Record<string, unknown>): void }
}

export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The subset of the DSH `connection` service the fence uses. */
export interface ConnectionTrustLike {
  requestRejection?: (request: { headers: Record<string, string | string[] | undefined> }) => 401 | 403 | undefined
  allowsRemoteAuthorities?: boolean
}

export interface GuardedRouteSpec {
  path: string
  methods: string[]
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

export interface GuardedRouteRegistrar {
  /** Register one exact route behind the shared fence and track its disposer. */
  register(spec: GuardedRouteSpec): void
  /** Registered paths (diagnostics/tests). */
  paths(): string[]
  /** Dispose every registered route; idempotent. */
  dispose(): void
  /** True when the host `connection` fence is unavailable (degraded mode). */
  connectionMissing(): boolean
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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Strip a `host:port` authority down to its hostname (best effort, never throws). */
function hostnameOf(authority: string | undefined): string | undefined {
  if (typeof authority !== 'string' || authority.length === 0) return undefined
  try {
    const url = new URL(authority.includes('://') ? authority : `http://${authority}`)
    return url.hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : undefined
}

/**
 * Degraded fence used only when the host has no `connection` service:
 * loopback peer + the request header + loopback Host/Origin when supplied.
 * This is deliberately explicit (logged once) rather than silently weaker.
 */
function degradedFenceAllows(req: IncomingMessage): boolean {
  const origin = hostnameOf(headerValue(req, 'origin'))
  if (origin !== undefined && !LOOPBACK_HOSTS.has(origin)) return false
  const host = hostnameOf(headerValue(req, 'host'))
  if (host !== undefined && !LOOPBACK_HOSTS.has(host)) return false
  return true
}

/**
 * Create the one guard used by every management route.
 *
 * Fence order: loopback peer → `x-superagent-request: 1` → DSH connection
 * `requestRejection()` (Host/Origin + browser/API credential) → method → body.
 * Without `connection`, the explicit degraded policy in
 * {@link degradedFenceAllows} applies and a warning is logged once.
 */
export function registerGuardedRoute(
  ctx: Context,
  webServer: WebServerLike,
  options: { logger?: { warn(message: string, extra?: Record<string, unknown>): void } } = {},
): GuardedRouteRegistrar {
  const disposers: Array<() => void> = []
  const registered: string[] = []
  const seen = new Set<string>()
  let warnedMissingConnection = false

  const connection = (): ConnectionTrustLike | undefined => {
    const service = ctx.get('connection') as ConnectionTrustLike | undefined
    return service
  }

  const reject = (res: ServerResponse, status: number, error: string): void => {
    sendJson(res, status, { ok: false, error })
  }

  const fence = (req: IncomingMessage, res: ServerResponse): boolean => {
    const address = req.socket?.remoteAddress
    if (!address || !LOOPBACK_ADDRESSES.has(address)) {
      sendForbidden(res)
      return false
    }
    if (!hasApiHeader(req)) {
      sendForbidden(res)
      return false
    }
    const service = connection()
    if (service && typeof service.requestRejection === 'function') {
      try {
        const rejection = service.requestRejection({ headers: req.headers })
        if (rejection === 401 || rejection === 403) {
          reject(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
          return false
        }
      } catch (error) {
        options.logger?.warn('connection.requestRejection failed; rejecting the request', {
          error: String(error),
        })
        reject(res, 403, 'forbidden')
        return false
      }
    } else {
      if (!warnedMissingConnection) {
        warnedMissingConnection = true
        options.logger?.warn(
          'the DSH connection service is unavailable; management API falls back to loopback + header + loopback Host/Origin checks',
        )
      }
      if (!degradedFenceAllows(req)) {
        sendForbidden(res)
        return false
      }
    }
    return true
  }

  return {
    register(spec) {
      if (seen.has(spec.path)) {
        options.logger?.warn('management route already registered; skipping duplicate', { path: spec.path })
        return
      }
      seen.add(spec.path)
      const guard = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
          if (!fence(req, res)) return
          if (!spec.methods.includes(req.method ?? '')) {
            reject(res, 405, 'method not allowed')
            return
          }
          await spec.handler(req, res)
        } catch (error) {
          options.logger?.warn('management endpoint failed', {
            path: spec.path,
            error: error instanceof Error ? error.message : String(error),
          })
          reject(res, 500, 'internal error')
        }
      }
      try {
        disposers.push(webServer.register({ kind: 'exact', path: spec.path, handler: guard }))
        registered.push(spec.path)
      } catch (error) {
        seen.delete(spec.path)
        options.logger?.warn('could not register management route', { path: spec.path, error: String(error) })
      }
    },
    paths() {
      return [...registered]
    },
    dispose() {
      seen.clear()
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          // route disposal must never throw into the plugin teardown
        }
      }
      registered.length = 0
    },
    connectionMissing() {
      return connection() === undefined
    },
  }
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
 * Register every management route (state/action + the setup wizard routes)
 * through the one guarded registrar. Returns a disposer; a missing web server
 * is reported and treated as "no panel on this profile". All handlers are
 * wrapped so they cannot reject into the host request pipeline.
 */
export function registerApi(ctx: Context, deps: ApiDeps): () => void {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (!webServer || typeof webServer.register !== 'function') {
    deps.logger?.warn('webServer service unavailable; the SuperAgent panel API is not registered')
    return () => undefined
  }
  const routes = registerGuardedRoute(ctx, webServer, { logger: deps.logger })

  const jsonBody = async (req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> => {
    try {
      return await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: 'invalid_body',
        description: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  routes.register({
    path: API_STATE_PATH,
    methods: ['GET', 'HEAD'],
    handler: async (_req, res) => {
      const state = await deps.state()
      sendJson(res, 200, state)
    },
  })

  routes.register({
    path: API_ACTION_PATH,
    methods: ['POST'],
    handler: async (req, res) => {
      let request: ApiActionRequest
      try {
        request = parseActionRequest(await readJsonBody(req))
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      try {
        const result = await deps.action(request)
        sendJson(res, 200, result)
      } catch (error) {
        // The action contract answers failures with {ok:false,error}, not a 5xx.
        deps.logger?.warn('action failed', { error: error instanceof Error ? error.message : String(error) })
        sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  const setup = deps.setup
  if (setup) {
    routes.register({
      path: SETUP_STATE_PATH,
      methods: ['GET', 'HEAD'],
      handler: async (_req, res) => {
        const result = await setup.state()
        sendJson(res, result.status, result.body)
      },
    })

    routes.register({
      path: SETUP_PERMISSIONS_PATH,
      methods: ['GET', 'HEAD'],
      handler: async (_req, res) => {
        const result = setup.permissions()
        sendJson(res, result.status, result.body)
      },
    })

    routes.register({
      path: SETUP_MODELS_PATH,
      methods: ['GET', 'HEAD'],
      handler: async (_req, res) => {
        const result = await setup.listModels()
        sendJson(res, result.status, result.body)
      },
    })

    routes.register({
      path: SETUP_TELEGRAM_PATH,
      methods: ['POST'],
      handler: async (req, res) => {
        const body = await jsonBody(req, res)
        if (body === undefined) return
        const result = await setup.saveTelegram(body)
        sendJson(res, result.status, result.body)
      },
    })

    routes.register({
      path: SETUP_GITHUB_PATH,
      methods: ['POST'],
      handler: async (req, res) => {
        const body = await jsonBody(req, res)
        if (body === undefined) return
        const result = await setup.saveGithub(body)
        sendJson(res, result.status, result.body)
      },
    })

    routes.register({
      path: SETUP_SSH_KEY_PATH,
      methods: ['POST'],
      handler: async (_req, res) => {
        const result = await setup.generateGithubSshKey()
        const body: Record<string, unknown> = { ...result.body }
        if (body.ok === true && typeof body.keyFile === 'string') {
          body.restarting = setup.persistGitSshKey(body.keyFile)
        }
        sendJson(res, result.status, body)
      },
    })

    routes.register({
      path: SETUP_WATCHDOG_PATH,
      methods: ['GET', 'HEAD', 'POST'],
      handler: async (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const result = await setup.getWatchdog(true)
          sendJson(res, result.status, result.body)
          return
        }
        const body = await jsonBody(req, res)
        if (body === undefined) return
        const enabled = (body as Record<string, unknown>).enabled
        if (typeof enabled !== 'boolean') {
          sendJson(res, 400, { ok: false, error: 'invalid_request', description: 'body must be { enabled: boolean }' })
          return
        }
        const result = await setup.setWatchdog(enabled)
        sendJson(res, result.status, result.body)
      },
    })

    routes.register({
      path: SETUP_OPERATOR_PATH,
      methods: ['POST'],
      handler: async (req, res) => {
        const body = await jsonBody(req, res)
        if (body === undefined) return
        const result = await setup.saveOperatorToken(body)
        const payload: Record<string, unknown> = { ...result.body }
        if (payload.ok === true && typeof payload.operatorTokenFile === 'string' && payload.removed !== true) {
          payload.restarting = setup.persistOperatorTokenFile(payload.operatorTokenFile)
        }
        sendJson(res, result.status, payload)
      },
    })

    routes.register({
      path: SETUP_CONFIG_PATH,
      methods: ['PUT', 'POST'],
      handler: async (req, res) => {
        const body = await jsonBody(req, res)
        if (body === undefined) return
        const prepared = await setup.prepareConfig(body)
        if (prepared.result.body.ok !== true || prepared.patch === undefined) {
          sendJson(res, prepared.result.status, prepared.result.body)
          return
        }
        // Answer before the configEditor edit: a non-volatile config change
        // restarts this plugin fiber, which would kill an unflushed response.
        sendJson(res, 200, prepared.result.body)
        try {
          setup.commitConfigSoon(prepared.patch)
        } catch (error) {
          deps.logger?.warn('could not schedule the setup config commit', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    })
  }

  return () => routes.dispose()
}
