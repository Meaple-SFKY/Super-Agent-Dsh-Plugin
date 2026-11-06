/**
 * Small internal utilities shared by the application layer.
 *
 * Everything here is dependency-free (node builtins only) so the runtime,
 * executor, assessor, tools and tests can all use it without pulling in a host
 * service. Timers are always `unref()`ed: this plugin must never keep the DSH
 * process alive on its own.
 */

import type { IsoTime } from '../core/model.js'

export interface AppLogger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

/** Logger that discards everything; handy for tests and for a disabled runtime. */
export const nullLogger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/** Render any thrown value as one short line, without ever throwing. */
export function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Render any thrown value with its error code when the host service uses one. */
export function errorName(error: unknown): string {
  try {
    if (error && typeof error === 'object') {
      const name = (error as { name?: unknown }).name
      const code = (error as { code?: unknown }).code
      if (typeof code === 'string' && code.length > 0) return code
      if (typeof name === 'string' && name.length > 0) return name
    }
  } catch {
    // fall through
  }
  return 'error'
}

export function nowIso(): IsoTime {
  return new Date().toISOString()
}

/**
 * Race `promise` against a deadline. The losing original promise always keeps
 * an attached rejection handler, so a late host failure can never surface as an
 * unhandled rejection (which would be fatal for the DSH process).
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Resolve after `ms`, or reject when `signal` aborts. The timer is unref'ed. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Collapse whitespace so a value can be embedded in a single prompt line. */
export function oneLine(value: unknown, limit = 400): string {
  const text = typeof value === 'string' ? value : safeString(value)
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > limit ? `${collapsed.slice(0, Math.max(0, limit - 1))}…` : collapsed
}

/** Truncate multi-line text while keeping paragraphs readable. */
export function clampText(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1))}…`
}

/** JSON stringify that never throws (circular structures, BigInt, ...). */
export function safeString(value: unknown): string {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    try {
      return String(value)
    } catch {
      return '[unserializable]'
    }
  }
}

/** Deep-freeze a plain JSON-ish structure in place; returns the value. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

/** True when the text contains something worth sending (not blank). */
export function hasText(text: string | undefined): text is string {
  return typeof text === 'string' && text.trim().length > 0
}

/** Run `fn` and swallow (but log) any failure: for fire-and-forget callbacks. */
export function runSafely(logger: AppLogger, label: string, fn: () => void): void {
  try {
    fn()
  } catch (error) {
    logger.warn(`${label} failed`, { error: errorMessage(error) })
  }
}
