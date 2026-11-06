/**
 * The real Superagent engine plugin entry.
 *
 * Loaded dynamically from `index.ts` (the guardian), so a failure here
 * degrades the plugin instead of breaking the DSH host. `start()` composes the
 * runtime, waits for it to be *ready or degraded* and returns a handle whose
 * `stop()` releases every resource it created.
 */

import type { Context } from '@deepseek-ai/cordis'

export interface EngineHandle {
  stop(): Promise<void>
}

/**
 * Validate the plugin configuration. Kept dependency-free on purpose: the
 * guardian calls it before any heavy import, so invalid configuration is
 * reported without loading the engine.
 */
export interface EngineConfig {
  stateDir: string
  enabled?: boolean
  sources?: {
    telegram?: {
      enabled?: boolean
      tokenEnv?: string
      tokenFile?: string
      allowedUserIds?: string[]
      chats?: string[]
    }
    github?: {
      enabled?: boolean
      tokenEnv?: string
      tokenFile?: string
      repositories?: string[]
      login?: string
      allowedLogins?: string[]
    }
  }
  policy?: { mode?: 'off' | 'observe' | 'auto'; rules?: Array<{ id: string; name: string; enabled?: boolean; instructions: string }> }
  executor?: { model?: string; maxWorkers?: number; prepare?: string }
  quiet?: { minChars?: number; quietHours?: { from: string; to: string } }
  [key: string]: unknown
}

/**
 * Start the application.
 *
 * A runtime that cannot reach `ready` (missing DSH services, invalid state
 * directory, unreadable store, ...) is stopped and reported as a thrown error,
 * so the guardian records `degraded` instead of a false `ready`. Component
 * failures after startup are handled by the runtime itself (health + safe mode)
 * and never throw out of this function. The error text is redacted and never
 * contains credentials.
 */
export async function start(ctx: Context, config: unknown): Promise<EngineHandle> {
  const { startRuntime, redactDetail } = await import('./app/runtime.js')
  const handle = await startRuntime(ctx, config)
  if (handle.runtime.status !== 'ready') {
    const status = handle.runtime.status
    const detail = handle.runtime.detail
    // Release the store, the state-directory lock, timers and any live agent
    // before surfacing the failure: the guardian must not leave resources behind.
    await handle.stop()
    throw new Error(
      `SuperAgent runtime did not start (${status})${detail ? `: ${redactDetail(detail)}` : ''}`,
    )
  }
  return {
    stop: () => handle.stop(),
  }
}
