/**
 * Executor adapter: launches and steers Worker sessions.
 *
 * One Assignment owns one directory (`<stateDir>/work/<ticketId>`) and one DSH
 * session (`superagent-worker-<ticketId>`). The directory is prepared with a
 * `git clone`/reuse plus an optional user-configured prepare command; every
 * external command is bounded by a timeout. The executor is the only place in
 * the runtime that starts processes.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { Assignment, Input, Ticket, TicketId, Trigger } from '../core/model.js'
import type { EffectsPort, EngineForExecutor, Store } from '../core/ports.js'
import type { Sessions } from './sessions.js'
import type { AppLogger } from './support.js'
import { errorMessage, nowIso, withTimeout } from './support.js'
import { renderAssignmentMessage, renderDeliveryMessage, renderStatusRequest } from '../prompts/index.js'

export interface ExecutorConfig {
  /** Shell command run inside the ticket directory after preparation. */
  prepare?: string
  /** Clone URL template; `{repo}` is replaced with `owner/name`. */
  cloneUrl?: string
  /** Disable cloning entirely (prepare still runs). */
  clone?: boolean
  /** Repository used when the ticket does not carry one. */
  defaultRepo?: string
  prepareTimeoutMs?: number
  gitTimeoutMs?: number
}

export interface ExecutorOptions {
  store: Store
  sessions: Sessions
  engine: () => EngineForExecutor
  effects?: EffectsPort
  logger: AppLogger
  stateDir: string
  now?: () => IsoTime
  config?: ExecutorConfig
  /** Injectable command runner (tests). Must reject on a non-zero exit. */
  runCommand?: (command: string, cwd: string, timeoutMs: number) => Promise<void>
}

type IsoTime = string

const DEFAULT_CLONE_URL = 'git@github.com:{repo}.git'

/** Strip path and shell hazards from a ticket id before using it as a directory. */
export function safeTicketSegment(ticketId: TicketId): string {
  const safe = String(ticketId).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '')
  return safe.length > 0 ? safe.slice(0, 96) : 'ticket'
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/** Default command runner: one bounded shell invocation. */
function defaultRunCommand(command: string, cwd: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command]
    execFile(
      shell,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve()
          return
        }
        const tail = `${String(stderr ?? '').slice(-1200)}\n${String(stdout ?? '').slice(-600)}`.trim()
        reject(new Error(`command failed (${error.message}): ${command}${tail ? `\n${tail}` : ''}`))
      },
    )
  })
}

export class Executor {
  private readonly options: ExecutorOptions
  private readonly logger: AppLogger
  private readonly now: () => IsoTime
  private readonly launching = new Set<string>()
  private stopped = false

  constructor(options: ExecutorOptions) {
    this.options = options
    this.logger = options.logger
    this.now = options.now ?? nowIso
  }

  /** Directory owned by a ticket; deterministic so recovery needs no state. */
  directoryFor(ticketId: TicketId): string {
    return join(this.options.stateDir, 'work', safeTicketSegment(ticketId))
  }

  // -- ExecutorPort --------------------------------------------------------

  /** Prepare the workspace, create/reuse the worker session, deliver the assignment. */
  async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    if (this.stopped) throw new Error('superagent executor is stopped')
    if (assignment.state === 'ended') throw new Error(`assignment ${assignment.id} already ended`)
    const guardKey = `${ticket.id}:${assignment.id}`
    if (this.launching.has(guardKey)) {
      this.logger.debug('launch already in flight; ignoring duplicate', { ticketId: ticket.id, assignmentId: assignment.id })
      return
    }
    this.launching.add(guardKey)
    try {
      const directory = this.directoryFor(ticket.id)
      const repo = this.resolveRepository(ticket)
      await this.prepareWorkspace({ ticket, directory, repo })
      const agent = await this.options.sessions.ensureWorker(ticket.id, directory)
      const sessionId = String(agent.session.id)
      this.options.sessions.bindAssignment(ticket.id, agent.session.id, assignment.id)
      const recovery = this.options.sessions.workerWasResumed(ticket.id)
      const triggers = this.originTriggers(ticket)
      const text = renderAssignmentMessage({
        ticket,
        assignment: { ...assignment, startedAt: assignment.startedAt ?? this.now() },
        directory,
        triggers,
        recovery,
        branch: `agent/${ticket.id}`,
      })
      const sent = this.options.sessions.deliverWorker(ticket.id, text, 'wake')
      if (!sent) throw new Error(`worker session ${sessionId} is not live`)
      this.options.engine().assignmentStarted({ ticketId: ticket.id, assignmentId: assignment.id, sessionId })
      this.logger.info('assignment started', {
        ticketId: ticket.id,
        assignmentId: assignment.id,
        sessionId,
        directory,
        recovery,
      })
    } finally {
      this.launching.delete(guardKey)
    }
  }

  /** Deliver new inputs to the running worker session. */
  async deliver(ticket: Ticket, assignment: Assignment, inputs: Input[]): Promise<void> {
    if (inputs.length === 0) return
    const directory = this.directoryFor(ticket.id)
    let agent = this.options.sessions.liveWorker(ticket.id)
    if (!agent) {
      agent = await this.options.sessions.ensureWorker(ticket.id, directory)
      this.options.sessions.bindAssignment(ticket.id, agent.session.id, assignment.id)
    }
    const text = renderDeliveryMessage(ticket, inputs)
    const sent = this.options.sessions.deliverWorker(ticket.id, text, 'auto')
    if (!sent) throw new Error(`could not deliver input to ticket ${ticket.id}: worker session unavailable`)
    this.options.engine().inputsDelivered(ticket.id, assignment.id, inputs.map(input => input.id))
  }

  /** Ask a live worker for a status report (synchronous by port contract). */
  requestStatus(ticket: Ticket, assignment: Assignment): boolean {
    const agent = this.options.sessions.liveWorker(ticket.id)
    if (!agent) return false
    return this.options.sessions.requestStatus(
      ticket.id,
      renderStatusRequest(ticket, assignment, 'no report within the stall window'),
    )
  }

  /** End an assignment's turn. The Engine already decided the assignment is final. */
  interrupt(ticketId: TicketId, assignmentId: string, reason: string): void {
    this.options.sessions.unbindAssignment(ticketId)
    this.options.sessions.interrupt(ticketId, reason)
    const ticket = this.options.store.tickets.get(ticketId)
    if (ticket?.ends) {
      // The ticket is over; free the session writer and directory lock.
      void this.options.sessions.disposeWorker(ticketId, `ticket ended: ${reason}`).catch(() => undefined)
    }
    this.logger.info('assignment interrupted', { ticketId, assignmentId, reason })
  }

  // -- recovery ------------------------------------------------------------

  /**
   * Restart recovery: every Assignment still marked `running` was interrupted
   * by the restart. Mark it interrupted in the Engine, then launch the
   * replacement assignment the Engine created (or enqueue a launch effect when
   * the Engine did not create one).
   */
  async recover(): Promise<{ interrupted: number; relaunched: number }> {
    let interrupted = 0
    let relaunched = 0
    for (const ticket of this.options.store.tickets.open()) {
      const running = ticket.assignments.filter(assignment => assignment.state === 'running')
      for (const assignment of running) {
        try {
          this.options.engine().assignmentInterrupted(ticket.id, assignment.id)
          interrupted += 1
        } catch (error) {
          this.logger.error('could not mark the assignment interrupted', {
            ticketId: ticket.id,
            assignmentId: assignment.id,
            error: errorMessage(error),
          })
        }
      }
      const fresh = this.options.store.tickets.get(ticket.id)
      if (!fresh || fresh.state === 'ended') continue
      const pending = fresh.assignments.filter(assignment => assignment.state === 'pending').pop()
      if (!pending) {
        if (running.length > 0) {
          this.logger.warn('interrupted assignment has no replacement; the engine did not queue a retry', {
            ticketId: ticket.id,
          })
        }
        continue
      }
      try {
        await this.launch(fresh, pending)
        relaunched += 1
      } catch (error) {
        this.logger.warn('recovery launch failed; enqueuing a durable launch effect', {
          ticketId: ticket.id,
          assignmentId: pending.id,
          error: errorMessage(error),
        })
        try {
          this.options.effects?.enqueue('launch', `launch:${ticket.id}:${pending.id}`, {
            ticketId: ticket.id,
            assignmentId: pending.id,
          })
        } catch (enqueueError) {
          this.logger.error('could not enqueue the recovery launch effect', { error: errorMessage(enqueueError) })
        }
      }
    }
    if (interrupted > 0 || relaunched > 0) this.logger.info('restart recovery complete', { interrupted, relaunched })
    return { interrupted, relaunched }
  }

  // -- workspace preparation ----------------------------------------------

  private resolveRepository(ticket: Ticket): string | undefined {
    const config = this.options.config ?? {}
    if (config.defaultRepo) return config.defaultRepo
    const trigger = this.options.store.triggers.get(ticket.origin.triggerId)
    const meta = trigger?.meta ?? {}
    for (const key of ['repository', 'repo', 'fullName', 'repoFullName']) {
      const value = meta[key]
      if (typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value)) return value
    }
    const scope = ticket.mandate.scope
    if (scope.startsWith('github:')) {
      const repo = scope.slice('github:'.length)
      if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return repo
    }
    return undefined
  }

  private originTriggers(ticket: Ticket): Trigger[] {
    const triggers: Trigger[] = []
    for (const id of ticket.origin.triggerIds) {
      const trigger = this.options.store.triggers.get(id)
      if (trigger) triggers.push(trigger)
    }
    const primary = this.options.store.triggers.get(ticket.origin.triggerId)
    if (primary && !triggers.some(trigger => trigger.id === primary.id)) triggers.push(primary)
    return triggers
  }

  private async prepareWorkspace(options: { ticket: Ticket; directory: string; repo?: string }): Promise<void> {
    const { ticket, directory, repo } = options
    const config = this.options.config ?? {}
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const cloneEnabled = config.clone !== false
    if (repo && cloneEnabled && !existsSync(join(directory, '.git'))) {
      const url = renderTemplate(config.cloneUrl ?? DEFAULT_CLONE_URL, { repo, ticket: ticket.id })
      const command = `git clone ${shellQuote(url)} ${shellQuote(directory)}`
      await this.run(command, directory, config.gitTimeoutMs ?? 180_000)
      this.logger.info('cloned the ticket repository', { ticketId: ticket.id, repo, directory })
    }
    if (config.prepare) {
      const command = renderTemplate(config.prepare, {
        dir: directory,
        ticket: ticket.id,
        repo: repo ?? '',
        branch: `agent/${ticket.id}`,
      })
      await this.run(command, directory, config.prepareTimeoutMs ?? 180_000)
      this.logger.info('ran the prepare command', { ticketId: ticket.id, directory })
    }
  }

  private async run(command: string, cwd: string, timeoutMs: number): Promise<void> {
    const runner = this.options.runCommand ?? defaultRunCommand
    await withTimeout(runner(command, cwd, timeoutMs), timeoutMs + 5_000, `prepare command in ${cwd}`)
  }

  /** Stop accepting launches and drop in-flight guards. */
  stop(): void {
    this.stopped = true
    this.launching.clear()
  }
}
