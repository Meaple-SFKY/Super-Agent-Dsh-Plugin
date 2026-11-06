/**
 * The real Superagent engine plugin.
 *
 * Loaded dynamically from `index.ts`, so a failure here degrades the plugin
 * instead of breaking the DSH host. `start()` must be safe to call once and
 * return a handle whose `stop()` releases every resource it created.
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
    }
    github?: {
      enabled?: boolean
      tokenEnv?: string
      tokenFile?: string
      repositories?: string[]
    }
  }
  [key: string]: unknown
}

/** Start the application; implementation lands with M1–M3. */
export async function start(_ctx: Context, _config: unknown): Promise<EngineHandle> {
  // The runtime is assembled by `src/app/runtime.ts`; this placeholder keeps
  // the bundle loadable while the engine and sources are built.
  return {
    async stop(): Promise<void> {
      // Nothing allocated yet.
    },
  }
}
