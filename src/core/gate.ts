/**
 * The deterministic first layer of Eval: the gate and Policy revalidation.
 *
 * `docs/000-architecture.md` §4 simplifies the prototype's admission table
 * away: each Source has an `allowed` list (people), a `bots` list and its
 * repositories/chats. Strength is only:
 *
 * - `explicit`: a listed person addressed the agent (`mention`/`direct`) or
 *   followed up on a Thread that already carries a Ticket;
 * - `inferred`: a listed bot produced the event, or a proactive rule may pick
 *   it up (rules only apply in `auto` mode);
 * - `not_admitted`: everyone else, or an unaddressed event from a stranger.
 *
 * The Engine uses the result for two things: whether the candidate reaches the
 * model at all (the gate runs before the assessor) and which Mandate an accept
 * records. A person's stop withdraws a Mandate; a Policy change does not, but
 * `revalidateMandate` decides whether an ended Ticket may resume under the
 * current Policy.
 */

import type { Mandate, MandateVia, Policy, Strength, Ticket, Trigger } from './model.js'

export interface GateContext {
  /** The Thread already carries a Ticket: a person's message there is a follow-up. */
  hasTickets: boolean
}

export interface GateResult {
  strength: Strength
  via: MandateVia
  /** Reason code when the gate does not admit the Trigger. */
  reason?: string
  /** Enabled proactive rules, for an inferred accept to record. */
  rules: string[]
}

const STRENGTH_RANK: Record<Strength, number> = {
  explicit: 2,
  inferred: 1,
  not_admitted: 0,
}

function allowed(senderId: string, policy: Policy, source: string): boolean {
  const part = policy.sources[source]
  if (part === undefined) return false
  return part.allowed.some(actor => actor.id === senderId)
}

function listedBot(senderId: string, policy: Policy, source: string): boolean {
  const part = policy.sources[source]
  if (part === undefined) return false
  return (part.bots ?? []).some(actor => actor.id === senderId)
}

function enabledRules(policy: Policy): string[] {
  return policy.rules.filter(rule => rule.enabled).map(rule => rule.id)
}

/** Admit one Trigger, or explain why it is `not_admitted`. */
export function gate(trigger: Trigger, policy: Policy, context: GateContext): GateResult {
  const part = policy.sources[trigger.source]
  if (part === undefined) {
    return { strength: 'not_admitted', via: 'addressed', reason: 'source_not_configured', rules: [] }
  }
  if (trigger.actor.bot === true) {
    if (!listedBot(trigger.actor.id, policy, trigger.source)) {
      return { strength: 'not_admitted', via: 'bot', reason: 'bot_not_allowed', rules: [] }
    }
    return { strength: 'inferred', via: 'bot', rules: enabledRules(policy) }
  }
  if (allowed(trigger.actor.id, policy, trigger.source)) {
    if (trigger.addressed === 'mention' || trigger.addressed === 'direct') {
      return { strength: 'explicit', via: 'addressed', rules: [] }
    }
    if (context.hasTickets) {
      return { strength: 'explicit', via: 'followup', rules: [] }
    }
    return { strength: 'not_admitted', via: 'addressed', reason: 'not_addressed', rules: [] }
  }
  return { strength: 'not_admitted', via: 'addressed', reason: 'not_allowed', rules: [] }
}

/**
 * Pick the Trigger that gives a batch its strength: the strongest admission,
 * the most recent one on a tie. `not_admitted` is only the result when nothing
 * in the batch was admitted.
 */
export function gateBatch(
  triggers: Trigger[],
  policy: Policy,
  context: GateContext,
): { trigger: Trigger; result: GateResult } {
  let best: { trigger: Trigger; result: GateResult } | undefined
  for (const trigger of triggers) {
    const result = gate(trigger, policy, context)
    if (result.strength === 'explicit') {
      if (best === undefined || best.result.strength !== 'explicit' || trigger.at >= best.trigger.at) {
        best = { trigger, result }
      }
      continue
    }
    if (result.strength === 'inferred') {
      if (best === undefined || STRENGTH_RANK[best.result.strength] < STRENGTH_RANK.inferred) {
        best = { trigger, result }
      } else if (best.result.strength === 'inferred' && trigger.at >= best.trigger.at) {
        best = { trigger, result }
      }
    }
  }
  const fallbackTrigger = triggers[triggers.length - 1]
  if (fallbackTrigger === undefined) {
    throw new Error('gateBatch needs at least one Trigger')
  }
  return best ?? { trigger: fallbackTrigger, result: gate(fallbackTrigger, policy, context) }
}

/** Whether proactive (inferred) work may be accepted at all. */
export function admitsInferred(policy: Policy, rules: string[] | undefined): boolean {
  if (policy.mode !== 'auto') return false
  const enabled = new Set(enabledRules(policy))
  if (enabled.size === 0) return false
  if (rules === undefined || rules.length === 0) return false
  return rules.every(rule => enabled.has(rule))
}

/**
 * Whether an existing Mandate still holds under the current Policy. Called
 * before an ended Ticket resumes; a Policy change alone does not revoke it.
 */
export function revalidateMandate(mandate: Mandate, policy: Policy): boolean {
  const part = policy.sources[mandate.source]
  if (part === undefined) return false
  const senderAllowed =
    part.allowed.some(actor => actor.id === mandate.sender.id) ||
    (mandate.via === 'bot' && (part.bots ?? []).some(actor => actor.id === mandate.sender.id))
  if (!senderAllowed) return false
  if (mandate.strength === 'inferred') {
    if (policy.mode !== 'auto') return false
    const enabled = new Set(enabledRules(policy))
    if (mandate.rules.length === 0 || !mandate.rules.every(rule => enabled.has(rule))) return false
  }
  if (mandate.rules.length > 0) {
    const enabled = new Set(enabledRules(policy))
    if (!mandate.rules.every(rule => enabled.has(rule))) return false
  }
  return true
}

export interface TicketPolicyChange {
  ticket: Ticket
  /** Reason codes describing what changed for this Ticket. */
  changes: string[]
}

/**
 * Which live Tickets a Policy change bears on, and how. Only these get a
 * `policy` Input; a running Assignment is never cancelled by a change.
 */
export function policyEffects(tickets: Ticket[], from: Policy, to: Policy): TicketPolicyChange[] {
  const before = new Map(from.rules.map(rule => [rule.id, rule]))
  const after = new Map(to.rules.map(rule => [rule.id, rule]))
  const affected: TicketPolicyChange[] = []
  for (const ticket of tickets) {
    if (ticket.ends !== undefined) continue
    const changes: string[] = []
    const mandate = ticket.mandate
    for (const ruleId of mandate.rules) {
      const oldRule = before.get(ruleId)
      const newRule = after.get(ruleId)
      if (oldRule === undefined || newRule === undefined) {
        changes.push('rule_removed')
      } else if (
        oldRule.enabled !== newRule.enabled ||
        oldRule.instructions !== newRule.instructions ||
        oldRule.name !== newRule.name
      ) {
        changes.push('rule_changed')
      }
    }
    const oldPart = from.sources[mandate.source]
    const newPart = to.sources[mandate.source]
    if (oldPart !== undefined && newPart === undefined) {
      changes.push('source_removed')
    } else if (oldPart !== undefined && newPart !== undefined) {
      const wasAllowed = oldPart.allowed.some(actor => actor.id === mandate.sender.id)
      const isAllowed = newPart.allowed.some(actor => actor.id === mandate.sender.id)
      if (wasAllowed && !isAllowed) changes.push('sender_not_allowed')
      if (mandate.via === 'bot') {
        const wasBot = (oldPart.bots ?? []).some(actor => actor.id === mandate.sender.id)
        const isBot = (newPart.bots ?? []).some(actor => actor.id === mandate.sender.id)
        if (wasBot && !isBot) changes.push('bot_not_allowed')
      }
    }
    if (mandate.strength === 'inferred' && from.mode === 'auto' && to.mode !== 'auto') {
      changes.push('proactive_off')
    }
    if (changes.length > 0) affected.push({ ticket, changes: [...new Set(changes)] })
  }
  return affected
}
