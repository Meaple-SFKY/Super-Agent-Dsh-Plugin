/**
 * Assessor adapter: puts a Candidate in front of the Router session.
 *
 * Delivery is a single inbox message (synchronous, so it fits the port), but
 * the surrounding machinery is defensive: a missing router session starts
 * recovery and fails the attempt, so the durable `assessment` effect retries
 * with backoff. Repeated failures eventually make the candidate expire in the
 * Engine, which records the `unavailable` decision — the runtime never invents
 * one itself.
 */

import type { Candidate, Policy } from '../core/model.js'
import type { EngineForMainSession } from '../core/ports.js'
import type { Sessions } from './sessions.js'
import type { AppLogger } from './support.js'
import { errorMessage } from './support.js'
import { renderCandidateMessage } from '../prompts/index.js'

/** Tool names quoted in the candidate block so the Router knows its options. */
export const ROUTER_TOOL_NAMES = [
  'superagent_read_candidate',
  'superagent_read_thread',
  'superagent_read_ticket',
  'superagent_route',
  'superagent_ticket',
  'superagent_reply',
  'superagent_pause',
]

export interface AssessorOptions {
  sessions: Sessions
  engine: () => EngineForMainSession
  policy: () => Policy
  logger: AppLogger
  tools?: string[]
}

export interface AssessorStats {
  delivered: number
  failed: number
  lastError?: string
  lastAt?: string
}

export class Assessor {
  private readonly options: AssessorOptions
  private readonly logger: AppLogger
  private readonly stats: AssessorStats = { delivered: 0, failed: 0 }

  constructor(options: AssessorOptions) {
    this.options = options
    this.logger = options.logger
  }

  /** Deliver one candidate to the Router; throws so the effect retries. */
  deliver(candidate: Candidate): void {
    const tools = this.options.tools ?? ROUTER_TOOL_NAMES
    const router = this.options.sessions.liveRouter()
    if (!router) {
      // A stopped/killed router is recoverable: start the session in the
      // background and let the durable effect retry the delivery.
      void this.options.sessions.ensureRouter().catch((error: unknown) => {
        this.logger.warn('could not start the router session for a candidate', { error: errorMessage(error) })
      })
      this.fail(new Error('router session is not live'))
    }
    try {
      const text = renderCandidateMessage(candidate, this.options.policy(), tools)
      const sent = this.options.sessions.deliverRouter(text, 'wake')
      if (!sent) throw new Error('router session rejected the candidate message')
      this.stats.delivered += 1
      this.stats.lastAt = new Date().toISOString()
      this.logger.debug('candidate delivered to the router', {
        evalId: candidate.eval.id,
        triggerId: candidate.primaryTrigger.id,
      })
    } catch (error) {
      this.fail(error)
    }
  }

  private fail(error: unknown): never {
    this.stats.failed += 1
    this.stats.lastError = errorMessage(error)
    this.stats.lastAt = new Date().toISOString()
    throw error instanceof Error ? error : new Error(errorMessage(error))
  }

  health(): AssessorStats {
    return { ...this.stats }
  }
}
