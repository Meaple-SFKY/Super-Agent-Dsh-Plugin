/**
 * Fake Telegram Bot API and GitHub REST servers for the end-to-end suite.
 *
 * They are real HTTP servers on 127.0.0.1 (ephemeral port) so the Sources use
 * their production transport code — `fetch`, retries, ETag/If-None-Match,
 * message splitting — without any network access. Every request is recorded so
 * tests can assert exactly what was (and was not) sent.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export interface RecordedRequest {
  method: string
  path: string
  query: string
  body: Record<string, unknown>
  headers: Record<string, string | string[] | undefined>
}

export interface FakeHttpService {
  url: string
  requests: RecordedRequest[]
  close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  })
  res.end(text)
}

/**
 * Start one fake service. `handler` returns the JSON body to send, or
 * `{ status, headers, body }` for a non-200 answer.
 */
async function startService(
  handler: (request: RecordedRequest) => unknown | { status: number; headers?: Record<string, string>; body?: unknown },
): Promise<FakeHttpService> {
  const requests: RecordedRequest[] = []
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const raw = await readBody(req)
      let body: Record<string, unknown> = {}
      if (raw.trim().length > 0) {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object') body = parsed as Record<string, unknown>
        } catch {
          body = {}
        }
      }
      const request: RecordedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.search,
        body,
        headers: req.headers,
      }
      requests.push(request)
      const answer = handler(request)
      if (answer !== null && typeof answer === 'object' && 'status' in answer) {
        const shaped = answer as { status: number; headers?: Record<string, string>; body?: unknown }
        sendJson(res, shaped.status, shaped.body, shaped.headers)
        return
      }
      sendJson(res, 200, answer)
    } catch (error) {
      try {
        sendJson(res, 500, { message: `fake service error: ${String(error)}` })
      } catch {
        // client gone
      }
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake service did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error === undefined ? resolve() : reject(error)))
      }),
  }
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

export interface TelegramMessage {
  message_id: number
  date: number
  from: { id: number; is_bot: boolean; first_name?: string; username?: string }
  chat: { id: number; type: string; title?: string }
  text?: string
  entities?: unknown[]
  reply_to_message?: unknown
}

export interface FakeTelegram extends FakeHttpService {
  /** Bot API method calls with a JSON body (sendMessage is the interesting one). */
  sent: Array<Record<string, unknown>>
  /** Queue an update for the next getUpdates long poll. */
  pushUpdate(update: TelegramUpdate): void
}

export async function startFakeTelegram(token: string): Promise<FakeTelegram> {
  let queue: TelegramUpdate[] = []
  const sent: Array<Record<string, unknown>> = []
  const service = await startService(request => {
    const match = /^\/bot([^/]+)\/([^/]+)$/.exec(request.path)
    if (match === null || match[1] !== token) return { status: 404, body: { ok: false, description: 'not found' } }
    const method = match[2]
    switch (method) {
      case 'getMe':
        return { ok: true, result: { id: 999, is_bot: true, first_name: 'SuperAgent', username: 'sa_test_bot' } }
      case 'getUpdates': {
        const updates = queue
        queue = []
        return { ok: true, result: updates }
      }
      case 'sendMessage':
        sent.push(request.body)
        return {
          ok: true,
          result: {
            message_id: 1_000 + sent.length,
            date: Math.floor(Date.now() / 1_000),
            chat: { id: request.body.chat_id, type: 'private' },
            text: request.body.text,
          },
        }
      case 'answerCallbackQuery':
        return { ok: true, result: true }
      default:
        return { ok: true, result: true }
    }
  })
  return {
    ...service,
    sent,
    pushUpdate: update => {
      queue.push(update)
    },
  }
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface GithubCommentPayload {
  id: number
  body: string
  user: { login: string; id: number; type?: string }
  created_at: string
  updated_at: string
  issue_url: string
  html_url: string
}

export interface GithubPullPayload {
  number: number
  title: string
  state: 'open' | 'closed'
  merged?: boolean
  merged_at?: string | null
  created_at: string
  updated_at: string
  user: { login: string; id: number; type?: string }
  html_url: string
  head: { ref: string; sha: string }
  base: { ref: string; sha: string }
  body?: string | null
  draft?: boolean
}

export interface FakeGithub extends FakeHttpService {
  /** Issue/PR comments POSTed by the Source (the outbound writes). */
  postedComments: Array<Record<string, unknown>>
  /** Seed one conversation comment that the next poll will return. */
  seedComment(comment: GithubCommentPayload): void
  /** Seed one pull request that the next polls list (lifecycle/bind tests). */
  seedPull(pull: GithubPullPayload): void
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

export async function startFakeGithub(
  repo = 'owner/repo',
  options: { commentsEtag?: string } = {},
): Promise<FakeGithub> {
  const now = new Date().toISOString()
  const seeded: GithubCommentPayload[] = []
  const pulls: GithubPullPayload[] = []
  const postedComments: Array<Record<string, unknown>> = []
  const etag = options.commentsEtag ?? 'W/"comments-1"'
  const service = await startService(request => {
    const path = request.path
    const is = (suffix: string): boolean => path === suffix
    const method = request.method

    if (method === 'GET' && is('/user')) {
      return { login: 'sa-agent', id: 1, type: 'User', html_url: 'https://github.com/sa-agent' }
    }
    if (method === 'GET' && is(`/repos/${repo}/issues`)) {
      return []
    }
    if (method === 'GET' && is(`/repos/${repo}/pulls`)) {
      // Newest first, like the real endpoint (`sort=updated&direction=desc`).
      return [...pulls].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    }
    if (method === 'GET' && is(`/repos/${repo}/pulls/comments`)) {
      return []
    }
    if (method === 'GET' && is(`/repos/${repo}/issues/comments`)) {
      if (request.headers['if-none-match'] === etag) {
        return { status: 304, headers: { etag }, body: undefined }
      }
      return { status: 200, headers: { etag, ...JSON_HEADERS }, body: seeded }
    }
    // Comment listing used by the idempotent createIssueComment().
    if (method === 'GET' && is(`/repos/${repo}/issues/1/comments`)) {
      return postedComments.map((body, index) => ({
        id: 700 + index,
        body: body.body,
        user: { login: 'sa-agent', id: 1, type: 'User' },
        created_at: now,
        updated_at: now,
        issue_url: `https://api.github.com/repos/${repo}/issues/1`,
        html_url: `https://github.com/${repo}/issues/1`,
      }))
    }
    if (method === 'POST' && is(`/repos/${repo}/issues/1/comments`)) {
      postedComments.push(request.body)
      return {
        id: 800 + postedComments.length,
        body: request.body.body,
        user: { login: 'sa-agent', id: 1, type: 'User' },
        created_at: now,
        updated_at: now,
        issue_url: `https://api.github.com/repos/${repo}/issues/1`,
        html_url: `https://github.com/${repo}/issues/1`,
      }
    }
    return { status: 404, body: { message: 'Not Found' } }
  })
  return {
    ...service,
    postedComments,
    seedComment: comment => {
      seeded.push(comment)
    },
    seedPull: pull => {
      pulls.push(pull)
    },
  }
}
