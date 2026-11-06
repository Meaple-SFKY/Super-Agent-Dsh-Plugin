/**
 * The Source contract.
 *
 * A Source kind is a reusable implementation; a Source instance is one
 * configuration of a kind. A Source owns its read position and bot identity,
 * decides which native events count as Triggers, translates them into Threads
 * and Channels, and performs the Channel writes the Engine queues for it.
 *
 * Sources never touch the store or the Engine's aggregates. They receive a
 * narrow `SourceContext` and hand Triggers to `receive()`.
 */

import type {
  ChannelAddress,
  IsoTime,
  OutboundMessage,
  SendOutcome,
  SourceId,
  ThreadRef,
  Trigger,
  TriggerId,
} from '../core/model.js'
import type { KeyValueStore } from '../core/ports.js'

export type SourceHealthState = 'off' | 'starting' | 'ready' | 'error'

export interface SourceLogger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export interface SourceHealth {
  name: string
  state: SourceHealthState
  detail?: string
  at?: IsoTime
}

/** What a Source kind receives when it is created. */
export interface SourceContext {
  /** Stable instance id, e.g. `telegram` or `github`. */
  readonly id: SourceId
  /** Absolute plugin state directory; Sources may keep small files here. */
  readonly stateDir: string
  now(): IsoTime
  /** Generate a collision-resistant id with the given prefix. */
  newId(prefix: string): string
  /** Offer one admitted event to the Engine. */
  receive(trigger: Trigger): 'stored' | 'duplicate' | 'filtered'
  readonly logger: SourceLogger
  /** Report one health entry; the last state wins. */
  health(entry: SourceHealth): void
  readonly kv: KeyValueStore
}

/** One running Source instance. */
export interface Source {
  readonly id: SourceId
  readonly kind: string
  start(): Promise<void>
  stop(): Promise<void>
  send(message: OutboundMessage): Promise<SendOutcome>
  /** Whether a queued write still has a live destination. */
  channelAllowed(channel: ChannelAddress): boolean
}

/** A reusable Source implementation. */
export interface SourceKind<TConfig = unknown> {
  readonly id: string
  readonly title: string
  readonly description: string
  create(config: TConfig, ctx: SourceContext): Source
}

/** Helper for Sources that build a Trigger from a native event. */
export interface TriggerDraft {
  kind: string
  at: IsoTime
  thread: ThreadRef
  correlations?: ThreadRef[]
  actor: { id: string; name?: string; bot?: boolean }
  addressed: 'mention' | 'direct' | 'none' | 'ci'
  text: string
  channel: ChannelAddress
  meta?: Record<string, unknown>
}

/** Build a complete Trigger; the Source owns thread/channel translation. */
export function makeTrigger(id: TriggerId, source: SourceId, draft: TriggerDraft): Trigger {
  return {
    id,
    source,
    kind: draft.kind,
    at: draft.at,
    thread: draft.thread,
    ...(draft.correlations ? { correlations: draft.correlations } : {}),
    actor: draft.actor,
    addressed: draft.addressed,
    text: draft.text,
    channel: draft.channel,
    meta: draft.meta ?? {},
  }
}
