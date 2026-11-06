import { describe, expect, it } from 'vitest'

import { Effects } from '../src/app/effects.js'
import { Outbox } from '../src/app/outbox.js'
import { createMemoryStore } from '../src/app/store.js'
import type { ChannelAddress, OutboundMessage, SendOutcome } from '../src/core/model.js'
import type { SourceScopePort } from '../src/core/ports.js'
import { FakeClock, silentLogger } from './core-fixtures.js'

const CHANNEL: ChannelAddress = { source: 'telegram', thread: 'chat-1', to: 'chat-1' }

class FakeSourceScope implements SourceScopePort {
  allowed = true
  sent: OutboundMessage[] = []
  outcomes: SendOutcome[] = []
  outcomeFor: ((message: OutboundMessage) => SendOutcome) | undefined

  channelAllowed(_channel: ChannelAddress): boolean {
    return this.allowed
  }

  async send(message: OutboundMessage): Promise<SendOutcome> {
    this.sent.push(message)
    if (this.outcomeFor !== undefined) return this.outcomeFor(message)
    return this.outcomes.shift() ?? 'sent'
  }
}

function harness(options: { baseMs?: number; maxMs?: number } = {}) {
  const store = createMemoryStore()
  const clock = new FakeClock()
  const effects = new Effects({
    store,
    clock,
    logger: silentLogger,
    retry: { baseMs: options.baseMs ?? 100, maxMs: options.maxMs ?? 1_000 },
  })
  const source = new FakeSourceScope()
  const outbox = new Outbox({ store, effects, clock, sourceScope: source, logger: silentLogger })
  return { store, clock, effects, source, outbox }
}

let messageSequence = 0

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  messageSequence += 1
  return {
    id: overrides.id ?? `msg_${messageSequence}`,
    purpose: 'answer',
    channel: CHANNEL,
    text: 'hello',
    at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('Outbox', () => {
  it('stores a receipt and a reply effect in the caller transaction', () => {
    const { store, outbox } = harness()
    const outbound = message({ id: 'msg_1', ticketId: 'tk_1' })
    outbox.queue(outbound)

    const receipt = store.receipts.get('msg_1')!
    expect(receipt.status).toBe('pending')
    expect(receipt.ticketId).toBe('tk_1')
    expect(receipt.failures).toBe(0)
    const effect = store.effects.get('reply', 'msg_1')!
    expect(effect.payload).toEqual({ message: outbound })
  })

  it('sends a pending message and marks it sent', async () => {
    const { store, source, outbox, effects } = harness()
    outbox.queue(message({ id: 'msg_1' }))
    await effects.pump()

    expect(source.sent.map(sent => sent.id)).toEqual(['msg_1'])
    const receipt = store.receipts.get('msg_1')!
    expect(receipt.status).toBe('sent')
    expect(receipt.sentAt).toBeDefined()
    expect(store.effects.all()).toEqual([])
  })

  it('drops a message whose conversation is gone', async () => {
    const { store, source, outbox, effects } = harness()
    source.outcomes = ['gone']
    outbox.queue(message({ id: 'msg_1' }))
    await effects.pump()

    const receipt = store.receipts.get('msg_1')!
    expect(receipt.status).toBe('dropped')
    expect(receipt.dropReason).toBe('channelGone')
    expect(receipt.droppedAt).toBeDefined()
    expect(store.effects.all()).toEqual([])
  })

  it('drops a message whose Channel the Source no longer listens to', async () => {
    const { store, source, outbox, effects } = harness()
    source.allowed = false
    outbox.queue(message({ id: 'msg_1' }))
    await effects.pump()

    expect(source.sent).toEqual([])
    expect(store.receipts.get('msg_1')?.status).toBe('dropped')
    expect(store.receipts.get('msg_1')?.dropReason).toBe('channelIgnored')
  })

  it('waits while the Source is not ready, without counting a failure', async () => {
    const { store, clock, source, outbox, effects } = harness({ baseMs: 100 })
    source.outcomes = ['waiting', 'sent']
    outbox.queue(message({ id: 'msg_1' }))
    await effects.pump()

    let receipt = store.receipts.get('msg_1')!
    expect(receipt.status).toBe('pending')
    expect(receipt.waitingSince).toBe(clock.now())
    expect(receipt.failures).toBe(0)
    expect(store.effects.get('reply', 'msg_1')?.attempts).toBe(0)

    clock.advance(5_100)
    await effects.pump()
    receipt = store.receipts.get('msg_1')!
    expect(receipt.status).toBe('sent')
  })

  it('counts failures and retries with backoff', async () => {
    const { store, clock, source, outbox, effects } = harness({ baseMs: 100, maxMs: 400 })
    source.outcomes = ['failed', 'sent']
    outbox.queue(message({ id: 'msg_1' }))
    await effects.pump()

    expect(store.receipts.get('msg_1')?.failures).toBe(1)
    expect(store.receipts.get('msg_1')?.status).toBe('pending')
    const row = store.effects.get('reply', 'msg_1')!
    expect(row.attempts).toBe(1)
    // Replies retry from 5 s, per the architecture's Channel-write rule.
    expect(Date.parse(row.dueAt)).toBe(Date.parse(clock.now()) + 5_000)

    clock.advance(5_000)
    await effects.pump()
    expect(store.receipts.get('msg_1')?.status).toBe('sent')
  })

  it('keeps the order of one Ticket messages in one conversation', async () => {
    const { store, clock, source, outbox, effects } = harness({ baseMs: 100 })
    source.outcomeFor = outbound => (outbound.id === 'msg_1' ? 'waiting' : 'sent')
    outbox.queue(message({ id: 'msg_1', ticketId: 'tk_1' }))
    outbox.queue(message({ id: 'msg_2', ticketId: 'tk_1' }))

    await effects.pump()
    expect(source.sent.map(sent => sent.id)).toEqual(['msg_1'])

    clock.advance(5_100)
    source.outcomeFor = () => 'sent'
    await effects.pump()
    expect(source.sent.map(sent => sent.id)).toEqual(['msg_1', 'msg_1', 'msg_2'])
    expect(store.receipts.get('msg_1')?.status).toBe('sent')
    expect(store.receipts.get('msg_2')?.status).toBe('sent')
  })

  it('keeps queue order for messages queued in the same millisecond', async () => {
    const { clock, source, outbox, effects } = harness()
    source.outcomeFor = outbound => (outbound.id === 'msg_z' ? 'waiting' : 'sent')
    outbox.queue(message({ id: 'msg_z', ticketId: 'tk_1' }))
    outbox.queue(message({ id: 'msg_a', ticketId: 'tk_1' }))

    await effects.pump()
    expect(source.sent.map(sent => sent.id)).toEqual(['msg_z'])

    clock.advance(5_100)
    source.outcomeFor = () => 'sent'
    await effects.pump()
    expect(source.sent.map(sent => sent.id)).toEqual(['msg_z', 'msg_z', 'msg_a'])
  })

  it('lets later messages pass once an earlier one failed three times', async () => {
    const { store, clock, source, outbox, effects } = harness({ baseMs: 100, maxMs: 200 })
    source.outcomeFor = outbound => (outbound.id === 'msg_1' ? 'failed' : 'sent')
    outbox.queue(message({ id: 'msg_1', ticketId: 'tk_1' }))
    outbox.queue(message({ id: 'msg_2', ticketId: 'tk_1' }))

    await effects.pump() // msg_1 fails once; msg_2 waits behind it
    clock.advance(5_000)
    await effects.pump() // msg_1 fails twice; msg_2 still waits
    expect(store.receipts.get('msg_2')?.status).toBe('pending')
    clock.advance(10_000)
    await effects.pump() // msg_1 fails three times; the arrived messages no longer wait
    expect(store.receipts.get('msg_2')?.status).toBe('sent')
    expect(store.receipts.get('msg_1')?.failures).toBe(3)
  })

  it('does not make other Tickets or ticket-less messages wait', async () => {
    const { source, outbox, effects } = harness()
    source.outcomeFor = outbound => (outbound.ticketId === 'tk_1' ? 'waiting' : 'sent')
    outbox.queue(message({ id: 'msg_1', ticketId: 'tk_1' }))
    outbox.queue(message({ id: 'msg_2', ticketId: 'tk_2' }))
    outbox.queue(message({ id: 'msg_3' }))

    await effects.pump()
    expect(source.sent.map(sent => sent.id).sort()).toEqual(['msg_1', 'msg_2', 'msg_3'])
  })

  it('withdraws pending messages with their reply effect', () => {
    const { store, outbox } = harness()
    outbox.queue(message({ id: 'msg_1', ticketId: 'tk_1' }))
    outbox.queue(message({ id: 'msg_2', ticketId: 'tk_2' }))

    expect(outbox.withdraw({ ticketId: 'tk_1', reason: 'channelGone' })).toBe(1)
    expect(store.receipts.get('msg_1')?.status).toBe('dropped')
    expect(store.receipts.get('msg_1')?.dropReason).toBe('channelGone')
    expect(store.effects.get('reply', 'msg_1')).toBeUndefined()
    expect(store.receipts.get('msg_2')?.status).toBe('pending')
  })

  it('does not send a withdrawn message', async () => {
    const { source, outbox, effects } = harness()
    outbox.queue(message({ id: 'msg_1' }))
    outbox.withdraw({ all: true, reason: 'channelIgnored' })
    await effects.pump()
    expect(source.sent).toEqual([])
  })

  it('sends a message at most once', async () => {
    const { source, outbox, effects } = harness()
    const outbound = message({ id: 'msg_1' })
    outbox.queue(outbound)
    await effects.pump()
    await outbox.deliver({ message: outbound })
    expect(source.sent).toHaveLength(1)
  })

  it('leaves the receipt pending when the send throws and retries it', async () => {
    const { store, clock, source, outbox, effects } = harness({ baseMs: 100 })
    let fail = true
    source.outcomeFor = () => {
      if (fail) throw new Error('network down')
      return 'sent'
    }
    outbox.queue(message({ id: 'msg_1' }))
    await effects.pump()

    expect(store.receipts.get('msg_1')?.failures).toBe(1)
    expect(store.receipts.get('msg_1')?.status).toBe('pending')

    fail = false
    clock.advance(5_000)
    await effects.pump()
    expect(store.receipts.get('msg_1')?.status).toBe('sent')
  })
})
