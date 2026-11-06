/**
 * The Outbox: the only writer of receipts and the `reply` effect.
 *
 * `queue(message)` runs inside the Engine's transaction. It stores one receipt
 * per message id and enqueues a `reply` effect whose payload carries the
 * complete message (the receipt has no text column). The effect's handler
 * sends it through the injected `SourceScopePort`:
 *
 * - `sent` → the receipt becomes `sent`;
 * - `gone` (the conversation can never receive it) or a Source that no longer
 *   listens (`channelAllowed` false) → the receipt is dropped with
 *   `channelGone` / `channelIgnored` and never queued again;
 * - `waiting` (Source off, network not ready) → retried without counting a
 *   failure;
 * - `failed` → the receipt's failure counter grows and the effect retries with
 *   backoff.
 *
 * A Ticket's messages to one conversation keep their order: a newer message
 * waits behind an earlier pending one with fewer than three failures; messages
 * of other Tickets and of no Ticket do not wait.
 */

import type { ChannelAddress, IsoTime, OutboundMessage, Receipt, SendOutcome, SourceId } from '../core/model.js'
import type { Clock, OutboxPort, SourceScopePort } from '../core/ports.js'
import type { AppStore, EffectRow } from '../core/stores.js'
import type { Effects, EffectsLogger } from './effects.js'
import { Defer } from './effects.js'
import { channelKey } from './store.js'

/** Payload of a `reply` effect, shared with Runtime's handlers if it owns them. */
export interface ReplyPayload {
  message: OutboundMessage
}

export type WithdrawReason = 'channelGone' | 'channelIgnored'

export interface WithdrawFilter {
  ticketId?: string
  source?: string
  /** Withdraw every pending message. */
  all?: boolean
  reason: WithdrawReason
}

export interface OutboxOptions {
  store: AppStore
  effects: Effects
  sourceScope: SourceScopePort
  clock?: Clock
  now?: () => IsoTime
  logger?: EffectsLogger
  /** Set false when Runtime registers the `reply` handler itself. */
  registerHandler?: boolean
}

const WAIT_RETRY_MS = 5_000

/** The Engine's Channel write port, backed by receipts + the `reply` effect. */
export class Outbox implements OutboxPort {
  private readonly store: AppStore
  private readonly effects: Effects
  private readonly sourceScope: SourceScopePort
  private readonly clock: Clock
  private readonly logger?: EffectsLogger

  constructor(options: OutboxOptions) {
    this.store = options.store
    this.effects = options.effects
    this.sourceScope = options.sourceScope
    this.clock = options.clock ?? { now: options.now ?? (() => new Date().toISOString()) }
    this.logger = options.logger
    if (options.registerHandler !== false) {
      // Per-source partition: different Sources send concurrently (up to 4),
      // while one Source keeps a single in-flight request (ordering intact).
      this.effects.handle('reply', payload => this.deliver(payload), {
        concurrency: 4,
        ordered: false,
        retry: { baseMs: 5_000, maxMs: 300_000 },
        // Per-Source ordering: never claim a message while an earlier reply of
        // the same Source is still pending; other Sources proceed in parallel.
        canRun: row => this.isHeadOfSource(row),
      })
    }
  }

  /** Store a receipt and queue its send, inside the caller's transaction. */
  queue(message: OutboundMessage): void {
    const receipt: Receipt = {
      id: message.id,
      ...(message.ticketId === undefined ? {} : { ticketId: message.ticketId }),
      purpose: message.purpose,
      channel: message.channel,
      status: 'pending',
      createdAt: message.at,
      failures: 0,
    }
    this.store.receipts.save(receipt)
    this.effects.enqueue('reply', message.id, { message } satisfies ReplyPayload)
  }

  /**
   * Claim predicate: skip a message while an earlier pending reply of the same
   * Ticket+conversation exists (mirrors {@link earlierWaiting}); other Tickets,
   * ticket-less messages and other Sources proceed in parallel.
   */
  private isHeadOfSource(row: EffectRow): boolean {
    const receipt = this.store.receipts.get(row.key)
    if (receipt === undefined || receipt.status !== 'pending' || receipt.ticketId === undefined) return true
    const key = channelKey(receipt.channel)
    for (const other of this.store.effects.all()) {
      if (other.kind !== 'reply' || other.seq >= row.seq) continue
      const earlier = this.store.receipts.get(other.key)
      if (earlier === undefined || earlier.status !== 'pending') continue
      if (earlier.ticketId !== receipt.ticketId) continue
      if (channelKey(earlier.channel) !== key) continue
      if (earlier.failures >= 3) continue
      return false
    }
    return true
  }

  /** Send one queued message; the `reply` effect handler. */
  async deliver(payload: unknown): Promise<void> {
    const message = readReplyPayload(payload)
    if (message === undefined) {
      this.logger?.warn('superagent reply effect without a message payload')
      return
    }
    const receipt = this.store.receipts.get(message.id)
    if (receipt === undefined || receipt.status !== 'pending') return
    if (this.earlierWaiting(receipt) !== undefined) {
      throw new Defer('behind an earlier message of the same Ticket and conversation', WAIT_RETRY_MS)
    }
    if (!this.sourceScope.channelAllowed(message.channel)) {
      this.settle(receipt, 'dropped', 'channelIgnored')
      return
    }
    let outcome: SendOutcome
    try {
      outcome = await this.sourceScope.send(message)
    } catch (error) {
      this.fail(receipt, error instanceof Error ? error.message : String(error))
      throw error instanceof Error ? error : new Error(String(error))
    }
    switch (outcome) {
      case 'sent':
        this.settle(receipt, 'sent')
        return
      case 'gone':
        this.settle(receipt, 'dropped', 'channelGone')
        return
      case 'waiting': {
        const now = this.clock.now()
        if (receipt.waitingSince === undefined) {
          receipt.waitingSince = now
          this.store.atomic(() => this.store.receipts.save({ ...receipt }))
        }
        throw new Defer('the Source cannot send yet', WAIT_RETRY_MS)
      }
      case 'failed':
        this.fail(receipt, 'the Source reported a failed send')
        throw new Error(`send of message ${message.id} failed`)
      default:
        this.fail(receipt, `unexpected send outcome ${String(outcome)}`)
        throw new Error(`unexpected send outcome for message ${message.id}`)
    }
  }

  /**
   * Drop pending messages whose destination can never receive them. Used when
   * a Source is removed or a Thread/Channel disappears.
   */
  withdraw(filter: WithdrawFilter): number {
    const pending = this.store.receipts.pending()
    const matches = pending.filter(receipt => {
      if (filter.ticketId !== undefined && receipt.ticketId !== filter.ticketId) return false
      if (filter.source !== undefined && receipt.channel.source !== filter.source) return false
      return filter.all === true || filter.ticketId !== undefined || filter.source !== undefined
    })
    if (matches.length === 0) return 0
    this.store.atomic(() => {
      for (const receipt of matches) {
        this.store.receipts.save({
          ...receipt,
          status: 'dropped',
          droppedAt: this.clock.now(),
          dropReason: filter.reason,
        })
        this.effects.remove('reply', receipt.id)
      }
    })
    return matches.length
  }

  status(id: string): Receipt | undefined {
    return this.store.receipts.get(id)
  }

  // -- internals -----------------------------------------------------------

  private earlierWaiting(receipt: Receipt): Receipt | undefined {
    // Effect rows carry the queue order, so two messages queued in the same
    // millisecond still keep their order.
    const current = this.store.effects.get('reply', receipt.id)
    if (current === undefined) return undefined
    const key = channelKey(receipt.channel)
    for (const row of this.store.effects.all()) {
      if (row.kind !== 'reply' || row.seq >= current.seq) continue
      const other = this.store.receipts.get(row.key)
      if (other === undefined || other.status !== 'pending') continue
      if (other.ticketId !== receipt.ticketId) continue
      if (channelKey(other.channel) !== key) continue
      if (other.failures >= 3) continue
      return other
    }
    return undefined
  }

  private settle(receipt: Receipt, status: 'sent' | 'dropped', reason?: string): void {
    const now = this.clock.now()
    this.store.atomic(() => {
      if (status === 'sent') {
        this.store.receipts.save({ ...receipt, status, sentAt: now })
      } else {
        this.store.receipts.save({ ...receipt, status, droppedAt: now, dropReason: reason })
      }
      // A direct `deliver()` call may run outside the effect runner.
      this.effects.remove('reply', receipt.id)
    })
  }

  private fail(receipt: Receipt, error: string): void {
    this.store.atomic(() => {
      this.store.receipts.save({ ...receipt, failures: receipt.failures + 1 })
    })
    this.logger?.warn('superagent reply failed', { id: receipt.id, error })
  }
}

function readReplyPayload(payload: unknown): OutboundMessage | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const candidate = (payload as { message?: unknown }).message
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const message = candidate as Partial<OutboundMessage>
  if (typeof message.id !== 'string' || typeof message.text !== 'string' || message.channel === undefined) return undefined
  return message as OutboundMessage
}

/** Build the Outbox for the Runtime's composition root. */
export function createOutbox(options: OutboxOptions): Outbox {
  return new Outbox(options)
}
