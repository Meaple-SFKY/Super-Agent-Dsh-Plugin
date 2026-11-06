/**
 * Internal health registry.
 *
 * The panel (`GET /superagent/api/state`) and the watchdog read the same
 * snapshot: one entry per runtime component, one per effect kind and one per
 * Source. Entries are cheap, in-memory and last-write-wins; a failure is never
 * thrown from a health update.
 */

import type { IsoTime } from '../core/model.js'
import { nowIso, errorMessage } from './support.js'

export type HealthState = 'ready' | 'starting' | 'error' | 'off' | 'degraded'

export interface HealthEntry {
  name: string
  state: HealthState
  detail?: string
  at?: IsoTime
}

/** Aggregate plugin status shown by the panel / guardian. */
export type PluginStatus = 'ready' | 'degraded' | 'starting' | 'stopped'

export class HealthRegistry {
  private readonly entries = new Map<string, HealthEntry>()
  private readonly now: () => IsoTime

  constructor(now: () => IsoTime = nowIso) {
    this.now = now
  }

  /** Record one entry (last write wins). Never throws. */
  set(name: string, state: HealthState, detail?: string): void {
    try {
      this.entries.set(name, {
        name,
        state,
        ...(detail !== undefined ? { detail: detail.slice(0, 500) } : {}),
        at: this.now(),
      })
    } catch {
      // health reporting must never break the caller
    }
  }

  /** Record a component failure from a thrown value. */
  fail(name: string, error: unknown): void {
    this.set(name, 'error', errorMessage(error))
  }

  get(name: string): HealthEntry | undefined {
    return this.entries.get(name)
  }

  /** Ordered snapshot: runtime first, then sources, then effects, alphabetical inside groups. */
  list(): HealthEntry[] {
    const all = [...this.entries.values()]
    const rank = (entry: HealthEntry): number => {
      if (entry.name === 'runtime') return 0
      if (entry.name.startsWith('sources:')) return 1
      if (entry.name.startsWith('effects:')) return 2
      return 3
    }
    return all
      .sort((a, b) => {
        const diff = rank(a) - rank(b)
        return diff !== 0 ? diff : a.name.localeCompare(b.name)
      })
      .map(entry => ({ ...entry }))
  }

  /** Whether any component is in the error state. */
  hasErrors(): boolean {
    for (const entry of this.entries.values()) if (entry.state === 'error') return true
    return false
  }

  /** Names of the entries currently in error. */
  errorNames(): string[] {
    return [...this.entries.values()].filter(entry => entry.state === 'error').map(entry => entry.name)
  }

  clear(): void {
    this.entries.clear()
  }
}

/** Derive the coarse plugin status from the component snapshot. */
export function pluginStatus(status: 'starting' | 'ready' | 'stopped' | 'degraded', health: HealthRegistry): PluginStatus {
  if (status === 'starting') return 'starting'
  if (status === 'stopped') return 'stopped'
  if (status === 'degraded') return 'degraded'
  return health.hasErrors() ? 'degraded' : 'ready'
}
