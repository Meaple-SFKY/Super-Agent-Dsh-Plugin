/**
 * Prompt assembler.
 *
 * The role prompts live in `src/prompts/*.md` (human-authored, reviewed like
 * code). At build time they are also embedded in `builtin.ts` so the bundled
 * plugin never depends on reading files from the repository. This module owns
 * loading and the small deterministic renderers that put domain objects into
 * the model's context (candidate blocks, assignment cards, ticket cards).
 *
 * Everything here is pure: no host services, no I/O beyond the one-time prompt
 * load, and no throwing when a markdown file is unavailable.
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type {
  Assignment,
  Candidate,
  Input,
  Policy,
  Report,
  ThreadSnapshot,
  Ticket,
  Trigger,
} from '../core/model.js'
import { ADMISSION, ROUTER, WORKER } from './builtin.js'
import { oneLine, clampText } from '../app/support.js'

export type PromptName = 'router' | 'admission' | 'worker'

/** Bot language: the user-facing copy language (zh is the default). */
export type Language = 'zh' | 'en'

/** Normalize a configured language value; anything unknown falls back to zh. */
export function normalizeLanguage(value: unknown): Language {
  return value === 'en' ? 'en' : 'zh'
}

/**
 * Injected at the end of every role prompt, so the English rule body stays
 * stable while the user-visible language follows the configuration.
 */
export function languageRule(language: Language): string {
  return language === 'en'
    ? [
        '## Language',
        'Always communicate with the user, write reports, ask questions and write ticket copy in English.',
        'Keep code, identifiers, commands, logs and URLs in their original form.',
        'If the user clearly writes in another language, follow the user.',
      ].join('\n')
    : [
        '## 语言',
        '始终使用简体中文与用户交流、写报告、提问和撰写工单文案。',
        '代码、标识符、命令、日志与 URL 保持原样。',
        '如果用户明显使用其他语言，跟随用户的语言。',
      ].join('\n')
}

/** Full embedded text, used when no markdown file can be read. */
const BUILTIN: Record<PromptName, string> = {
  router: ROUTER,
  admission: ADMISSION,
  worker: WORKER,
}

const cache = new Map<PromptName, string>()

/** Candidate locations for a markdown prompt, in priority order. */
function promptCandidates(name: PromptName): URL[] {
  return [
    new URL(`./${name}.md`, import.meta.url),
    new URL(`../../src/prompts/${name}.md`, import.meta.url),
    new URL(`../src/prompts/${name}.md`, import.meta.url),
  ]
}

/**
 * Resolve one markdown prompt. Candidate locations cover source execution
 * (vitest, tsx) and the bundled `lib/` layout; the embedded text is the final
 * fallback so prompt assembly can never fail at runtime.
 */
function loadMarkdown(name: PromptName): string | undefined {
  for (const candidate of promptCandidates(name)) {
    try {
      const text = readFileSync(fileURLToPath(candidate), 'utf8')
      if (text.trim().length > 0) return text
    } catch {
      // try the next location
    }
  }
  return undefined
}

/**
 * Preload every prompt once during startup, asynchronously, so the first
 * model step never performs blocking file I/O. Failures fall back to the
 * embedded text; prompt assembly can never throw.
 */
export async function preloadPrompts(): Promise<void> {
  for (const name of ['router', 'admission', 'worker'] as const) {
    if (cache.has(name)) continue
    let loaded: string | undefined
    for (const candidate of promptCandidates(name)) {
      try {
        const text = await readFile(fileURLToPath(candidate), 'utf8')
        if (text.trim().length > 0) {
          loaded = text
          break
        }
      } catch {
        // try the next location
      }
    }
    cache.set(name, loaded ?? BUILTIN[name])
  }
}

/** Load a prompt by name; the result is cached and never empty. */
export function loadPrompt(name: PromptName): string {
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  const text = loadMarkdown(name) ?? BUILTIN[name]
  cache.set(name, text)
  return text
}

/** The Router's system prompt: governance rules, the admission rubric, and the language rule. */
export function routerSystemPrompt(language: Language = 'zh'): string {
  return `${loadPrompt('router').trim()}\n\n${loadPrompt('admission').trim()}\n\n${languageRule(language)}`
}

/** The Worker's system prompt (plus the language rule). */
export function workerSystemPrompt(language: Language = 'zh'): string {
  return `${loadPrompt('worker').trim()}\n\n${languageRule(language)}`
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function timeShort(iso: string | undefined): string {
  if (!iso) return '?'
  return iso.length >= 16 ? iso.slice(0, 16).replace('T', ' ') : iso
}

function actorLine(trigger: Trigger): string {
  const name = trigger.actor.name ? `${trigger.actor.name} ` : ''
  return `${name}(${trigger.actor.id})${trigger.actor.bot ? ' bot' : ''}`
}

/** One trigger rendered as a compact, single-line evidence row. */
export function renderTriggerLine(trigger: Trigger, options: { textLimit?: number } = {}): string {
  const limit = options.textLimit ?? 500
  return [
    `- ${trigger.id}`,
    `source=${trigger.source}`,
    `kind=${trigger.kind}`,
    `at=${timeShort(trigger.at)}`,
    `addressed=${trigger.addressed}`,
    `actor=${actorLine(trigger)}`,
    `text=${JSON.stringify(clampText(trigger.text, limit))}`,
  ].join(' ')
}

/** A short ticket card usable by tools and the executor. */
export function renderTicketCard(ticket: Ticket): string {
  const lines: string[] = []
  lines.push(`ticket: ${ticket.id}`)
  lines.push(`title: ${oneLine(ticket.title, 200)}`)
  lines.push(`state: ${ticket.state}${ticket.ends ? ` (ended: ${ticket.ends.outcome})` : ''}`)
  lines.push(`created: ${timeShort(ticket.createdAt)}  updated: ${timeShort(ticket.updatedAt)}`)
  lines.push(
    `mandate: ${ticket.mandate.strength} via ${ticket.mandate.via} from ${ticket.mandate.sender.name ?? ticket.mandate.sender.id}` +
      ` on ${ticket.mandate.source} scope=${ticket.mandate.scope} policy=${ticket.mandate.policyVersion}`,
  )
  if (ticket.mandate.rules.length > 0) lines.push(`rules: ${ticket.mandate.rules.join(', ')}`)
  if (ticket.follows.length > 0) {
    lines.push(
      `follows: ${ticket.follows
        .map(follow => `${follow.key}${follow.own ? ' (own)' : ''}${follow.closed ? ` [closed ${follow.closed.outcome}]` : ''}`)
        .join(', ')}`,
    )
  }
  const assignment = ticket.assignments[ticket.assignments.length - 1]
  if (assignment) {
    lines.push(
      `assignment: ${assignment.id} state=${assignment.state} started=${timeShort(assignment.startedAt)}` +
        `${assignment.directory ? ` dir=${assignment.directory}` : ''}`,
    )
  }
  if (ticket.latestReport) {
    lines.push(
      `latest report: ${ticket.latestReport.kind} at ${timeShort(ticket.latestReport.at)}: ${oneLine(ticket.latestReport.summary, 300)}`,
    )
  }
  if (ticket.waitingForPerson) lines.push('waiting for person: yes')
  return lines.join('\n')
}

/** Compact thread view: newest trigger last, bounded window. */
export function renderThreadWindow(snapshot: ThreadSnapshot | undefined, limit = 12): string {
  if (!snapshot) return '(thread not found)'
  const triggers = snapshot.triggers.slice(-limit)
  const lines = [
    `thread: ${snapshot.thread.key} source=${snapshot.thread.source}` +
      `${snapshot.thread.label ? ` label=${JSON.stringify(oneLine(snapshot.thread.label, 120))}` : ''}`,
    `queued=${snapshot.thread.queued.length} eval=${snapshot.thread.eval ? snapshot.thread.eval.id : 'none'} expired=${snapshot.thread.expired}`,
    'window (oldest first):',
  ]
  if (triggers.length === 0) lines.push('- (no triggers)')
  else for (const trigger of triggers) lines.push(renderTriggerLine(trigger))
  if (snapshot.tickets.length > 0) {
    lines.push('tickets on this thread:')
    for (const ticket of snapshot.tickets) {
      lines.push(`- ${ticket.id} state=${ticket.state} ${oneLine(ticket.title, 120)}`)
    }
  }
  return lines.join('\n')
}

function policyLines(policy: Policy): string[] {
  const rules = policy.rules.filter(rule => rule.enabled)
  return [
    `policy: version=${policy.version} mode=${policy.mode} paused=${policy.paused ? 'yes' : 'no'}`,
    rules.length > 0
      ? `rules: ${rules.map(rule => `${rule.id}=${oneLine(rule.name, 60)}`).join('; ')}`
      : 'rules: none',
  ]
}

/**
 * The compact structured candidate block delivered to the Router session.
 * Every id needed by `superagent_route` / the read tools is present exactly
 * once, so the Router never has to guess or re-derive context.
 */
export function renderCandidateMessage(candidate: Candidate, policy: Policy, tools: string[]): string {
  const { primaryTrigger, triggers, thread, eval: run, relatedTickets } = candidate
  const lines: string[] = []
  lines.push('[superagent candidate]')
  lines.push(
    `eval: ${run.id} trigger: ${primaryTrigger.id} started: ${timeShort(run.startedAt)} expiries: ${run.expiries}`,
  )
  lines.push(
    `source: ${primaryTrigger.source} kind: ${primaryTrigger.kind} addressed: ${primaryTrigger.addressed}` +
      ` actor: ${actorLine(primaryTrigger)} at: ${timeShort(primaryTrigger.at)}`,
  )
  lines.push(...policyLines(policy))
  lines.push(`thread: ${thread.thread.key}${thread.thread.label ? ` (${oneLine(thread.thread.label, 100)})` : ''}`)
  lines.push(`primary text: ${JSON.stringify(clampText(primaryTrigger.text, 1200))}`)
  lines.push(`batch (${triggers.length} trigger(s), oldest first):`)
  for (const trigger of triggers) lines.push(renderTriggerLine(trigger))
  if (primaryTrigger.correlations && primaryTrigger.correlations.length > 0) {
    lines.push(`correlated threads: ${primaryTrigger.correlations.map(ref => ref.key).join(', ')}`)
  }
  lines.push(`thread window (previous ${Math.min(thread.triggers.length, 8)}):`)
  const previous = thread.triggers.filter(trigger => trigger.id !== primaryTrigger.id).slice(-8)
  if (previous.length === 0) lines.push('- (nothing earlier)')
  else for (const trigger of previous) lines.push(renderTriggerLine(trigger, { textLimit: 240 }))
  lines.push(`related tickets (${relatedTickets.length} of ${candidate.ticketsTotal}):`)
  if (relatedTickets.length === 0) lines.push('- none')
  else {
    for (const ticket of relatedTickets) {
      lines.push(
        `- ${ticket.id} state=${ticket.state} ${JSON.stringify(oneLine(ticket.title, 120))}` +
          `${ticket.latestReport ? ` last=${ticket.latestReport.kind}` : ''}`,
      )
    }
  }
  lines.push(`allowed tools: ${tools.join(', ')}`)
  lines.push('decide with exactly one superagent_route call; use read tools only when the block is insufficient.')
  return lines.join('\n')
}

export interface AssignmentRenderOptions {
  ticket: Ticket
  assignment: Assignment
  directory: string
  triggers: Trigger[]
  inputs?: Input[]
  /** True when the session resumed an interrupted assignment. */
  recovery?: boolean
  branch?: string
}

/** The assignment message that starts (or resumes) a worker turn. */
export function renderAssignmentMessage(options: AssignmentRenderOptions): string {
  const { ticket, assignment, directory, triggers, inputs = [], recovery = false, branch } = options
  const lines: string[] = []
  lines.push('[superagent assignment]')
  lines.push(renderTicketCard(ticket))
  lines.push(`assignment: ${assignment.id} started: ${timeShort(assignment.startedAt)}`)
  lines.push(`directory: ${directory}`)
  if (branch) lines.push(`branch: ${branch}`)
  const repo = ticket.mandate.scope.startsWith('github:') ? ticket.mandate.scope.slice('github:'.length) : undefined
  lines.push(
    repo
      ? `repository: ${repo}`
      : 'repository: none — if this ticket asks you to create one, use superagent_github action=create_repository first (see the New repository section)',
  )
  lines.push('requested outcome (acceptance criteria):')
  lines.push(`- deliver: ${oneLine(ticket.title, 200)}`)
  lines.push(
    `- work only inside the directory above; commit on branch ${branch ?? `agent/${ticket.id}`}; open or update a pull request`,
  )
  lines.push('- relevant tests/linters pass, or the reason they cannot run is recorded in the report')
  lines.push('- report ready with the exact branch/commit/PR reference; report blocked with exactly one question')
  lines.push('first triggers:')
  if (triggers.length === 0) lines.push('- (no trigger payload attached)')
  else for (const trigger of triggers.slice(-6)) lines.push(renderTriggerLine(trigger))
  if (inputs.length > 0) {
    lines.push('new input delivered with this assignment:')
    for (const input of inputs.slice(-6)) {
      lines.push(`- ${input.id} kind=${input.kind} at=${timeShort(input.at)} ${JSON.stringify(clampText(input.text ?? '', 500))}`)
    }
  }
  if (ticket.latestReport) {
    lines.push(
      `last report: ${ticket.latestReport.kind} at ${timeShort(ticket.latestReport.at)}: ${oneLine(ticket.latestReport.summary, 300)}`,
    )
  }
  if (recovery) {
    lines.push('[recovery]')
    lines.push('This assignment was interrupted (host restart, stall or session loss). Do not restart from scratch:')
    lines.push('1. check the working directory, branch and PR state;')
    lines.push('2. continue from the last verified artefact;')
    lines.push('3. report progress only if the state was unclear, otherwise continue to the next real milestone.')
  }
  lines.push('report with superagent_report. A turn must not end without a report; blocked/ready/failed wake the user.')
  return lines.join('\n')
}

/** Message injected when new inputs (triggers, policy, person text) arrive. */
export function renderDeliveryMessage(ticket: Ticket, inputs: Input[]): string {
  const lines: string[] = ['[superagent input]']
  lines.push(`ticket: ${ticket.id} ${JSON.stringify(oneLine(ticket.title, 160))}`)
  for (const input of inputs) {
    const who = input.person ? 'person' : 'system'
    lines.push(`- ${input.id} kind=${input.kind} from=${who} at=${timeShort(input.at)} ${JSON.stringify(clampText(input.text ?? '', 800))}`)
  }
  lines.push('Apply this input to the current assignment. Acknowledge it with superagent_ack once you act on it.')
  return lines.join('\n')
}

/** Ask a running worker for a status report (watchdog / Router request). */
export function renderStatusRequest(ticket: Ticket, assignment: Assignment, reason: string): string {
  return [
    '[superagent status request]',
    `ticket: ${ticket.id} ${JSON.stringify(oneLine(ticket.title, 160))}`,
    `assignment: ${assignment.id} running since ${timeShort(assignment.startedAt)}`,
    `reason: ${reason}`,
    'Reply with superagent_report now: progress if work is underway, waiting if blocked on something external,',
    'blocked with exactly one question if a person must decide, ready/failed otherwise. Do not explain in chat.',
  ].join('\n')
}

/** Ask a worker to stop (ticket stop / policy change / failure isolation). */
export function renderStopMessage(ticket: Ticket, reason: string): string {
  return [
    '[superagent stop]',
    `ticket: ${ticket.id} ${JSON.stringify(oneLine(ticket.title, 160))}`,
    `reason: ${reason}`,
    'Stop working immediately. Finish the current atomic action, leave the workspace in a consistent state,',
    'and do not start anything new. The Router has ended this ticket.',
  ].join('\n')
}

/** Human-facing summary of a report; used for attention messages and the panel. */
export function reportSummary(report: Report): string {
  const parts = [oneLine(report.summary, 300)]
  if (report.kind === 'blocked' && report.question) parts.push(`Question: ${oneLine(report.question, 300)}`)
  if (report.pullRequest) parts.push(`PR: ${report.pullRequest.url}`)
  return parts.join(' ')
}
