/**
 * Crash-recovery and transactional-invariant tests against the REAL SQLite
 * `Store` and `Effects` implementation (no mocks, no in-memory stand-in).
 *
 * The contract under test (docs/000-architecture.md §6 and §7,
 * docs/dsh-api-notes.md §8.4):
 *  - an effect enqueued inside a command transaction is durable: after SIGKILL
 *    it is still queued exactly once and runs on restart (at-least-once);
 *  - a transaction that did not commit leaves no rows at all;
 *  - a crash *inside* a handler leaves the row in place, so the effect is
 *    retried: the documented at-least-once window (handlers must be
 *    idempotent) — never a silently lost row;
 *  - a database written by a NEWER schema is refused with a clear error and is
 *    not corrupted or downgraded;
 *  - retry/backoff state survives a restart.
 *
 * The kill points are controlled by `tests/e2e/fixtures/recovery-child.mjs`,
 * which imports the same TS sources in a child Node process. Temp state lives
 * under `os.tmpdir()` and is removed afterwards; no network, no tokens.
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { Effects, createEffects } from '../src/app/effects.js'
import { SCHEMA_VERSION, openStore, type SqliteStore } from '../src/app/store.js'
import type { Trigger } from '../src/core/model.js'
import { FakeClock, silentLogger } from './core-fixtures.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHILD = join(HERE, 'e2e', 'fixtures', 'recovery-child.mjs')
const AT = '2026-01-01T00:00:00.000Z'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-recovery-'))
  tempDirs.push(dir)
  return dir
}

function trigger(id: string): Trigger {
  return {
    id,
    source: 'telegram',
    kind: 'message',
    at: AT,
    thread: { key: 'telegram:dm:1', source: 'telegram' },
    actor: { id: '1' },
    addressed: 'direct',
    text: 'hi',
    channel: { source: 'telegram', thread: 'telegram:dm:1', to: '1' },
    meta: {},
  }
}

/** Run the crash fixture in a child process and return its termination info. */
function runChild(dir: string, mode: string): { status: number | null; signal: NodeJS.Signals | null; stderr: string } {
  const result = spawnSync(process.execPath, [CHILD, dir, mode], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  if (result.error !== undefined) throw result.error
  return { status: result.status, signal: result.signal, stderr: result.stderr ?? '' }
}

function expectKilled(info: { signal: NodeJS.Signals | null; stderr: string }): void {
  // process.kill(pid, 'SIGKILL') on itself: no exit code, killed by signal.
  expect(info.signal, info.stderr).toBe('SIGKILL')
}

function closeStore(store: SqliteStore): void {
  store.close()
}

// ---------------------------------------------------------------------------
// Durable queue across a hard crash
// ---------------------------------------------------------------------------

describe('durable effects across a hard crash', () => {
  it('keeps a committed effect exactly once and runs it after restart', async () => {
    const dir = stateDir()
    const crash = runChild(dir, 'commit-then-die')
    expectKilled(crash)

    // The transaction committed before the process died: both rows survive.
    const store = openStore({ stateDir: dir })
    expect(store.triggers.has('trigger:commit-then-die')).toBe(true)
    const rows = store.effects.all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!).toMatchObject({ kind: 'relay', key: 'crash:commit-then-die', attempts: 0 })

    // Restart: the handler runs once, the row is removed, no duplicate.
    const ran: string[] = []
    const effects = createEffects({
      store,
      logger: silentLogger, // real clock: the child's dueAt is a real timestamp
      handlers: { relay: (_payload, row) => void ran.push(row.key) },
    })
    await effects.pump()
    expect(ran).toEqual(['crash:commit-then-die'])
    expect(store.effects.all()).toHaveLength(0)

    await effects.pump() // a second pass finds nothing to do
    expect(ran).toEqual(['crash:commit-then-die'])
    closeStore(store)

    // Reopening the file does not resurrect work that already succeeded.
    const reopened = openStore({ stateDir: dir })
    expect(reopened.effects.all()).toHaveLength(0)
    expect(reopened.triggers.has('trigger:commit-then-die')).toBe(true)
    closeStore(reopened)
  })

  it('leaves no rows when the process dies before COMMIT', () => {
    const dir = stateDir()
    const crash = runChild(dir, 'mid-transaction')
    expectKilled(crash)

    const store = openStore({ stateDir: dir })
    expect(store.triggers.has('trigger:mid-transaction')).toBe(false)
    expect(store.effects.all()).toHaveLength(0)
    closeStore(store)
  })

  it('retries an effect whose handler died mid-flight (at-least-once window, no lost row)', async () => {
    const dir = stateDir()
    const crash = runChild(dir, 'handler-die')
    expectKilled(crash)

    const sendsFile = join(dir, 'sends.jsonl')
    expect(readFileSync(sendsFile, 'utf8')).toBe('send\n')

    // The row was NOT removed (the process died before the success commit):
    // the effect must be retried after restart, not lost.
    const store = openStore({ stateDir: dir })
    const pending = store.effects.all()
    expect(pending).toHaveLength(1)
    expect(pending[0]!).toMatchObject({ kind: 'relay', key: 'crash:handler-die' })

    const effects = createEffects({
      store,
      logger: silentLogger, // real clock: the child's dueAt is a real timestamp
      handlers: {
        relay: () => {
          appendFileSync(sendsFile, 'send\n')
        },
      },
    })
    await effects.pump()
    expect(store.effects.all()).toHaveLength(0)

    // Exactly the documented window: the first "send" was recorded before the
    // crash, the retry sends once more. Nothing beyond that is duplicated.
    expect(readFileSync(sendsFile, 'utf8')).toBe('send\nsend\n')
    await effects.pump()
    expect(readFileSync(sendsFile, 'utf8')).toBe('send\nsend\n')
    closeStore(store)
  })

  it('runs a clean (non-crashing) effect exactly once and persists no residue', () => {
    const dir = stateDir()
    const run = runChild(dir, 'clean-run')
    expect(run.status, run.stderr).toBe(0)
    expect(readFileSync(join(dir, 'sends.jsonl'), 'utf8')).toBe('send\n')

    const store = openStore({ stateDir: dir })
    expect(store.effects.all()).toHaveLength(0)
    closeStore(store)
  })
})

// ---------------------------------------------------------------------------
// Transactional invariants
// ---------------------------------------------------------------------------

describe('transactional invariants of the real store', () => {
  it('rolls back every write of a command that throws', () => {
    const dir = stateDir()
    const store = openStore({ stateDir: dir })
    const effects = createEffects({ store, clock: new FakeClock(AT), logger: silentLogger })

    expect(() =>
      store.atomic(() => {
        store.triggers.save(trigger('t_rollback'))
        effects.enqueue('relay', 'k_rollback', { n: 1 })
        throw new Error('command failed after enqueue')
      }),
    ).toThrow('command failed after enqueue')

    expect(store.triggers.has('t_rollback')).toBe(false)
    expect(store.effects.all()).toHaveLength(0)
    closeStore(store)

    // The rollback is durable, not just visible in the live connection.
    const reopened = openStore({ stateDir: dir })
    expect(reopened.triggers.has('t_rollback')).toBe(false)
    expect(reopened.effects.all()).toHaveLength(0)
    closeStore(reopened)
  })

  it('coalesces one row per kind+key and keeps its queue position', () => {
    const dir = stateDir()
    const store = openStore({ stateDir: dir })
    const effects = createEffects({ store, clock: new FakeClock(AT), logger: silentLogger })

    store.atomic(() => {
      effects.enqueue('relay', 'same-key', { n: 1 })
      effects.enqueue('relay', 'same-key', { n: 2 })
    })
    const rows = store.effects.all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toEqual({ n: 2 })
    const seq = rows[0]?.seq
    expect(seq).toBeGreaterThan(0)

    // Re-enqueue keeps the original seq; the payload is replaced.
    effects.enqueue('relay', 'same-key', { n: 3 })
    const updated = store.effects.get('relay', 'same-key')
    expect(updated?.seq).toBe(seq)
    expect(updated?.payload).toEqual({ n: 3 })
    closeStore(store)
  })

  it('keeps failure/backoff state across a restart, then succeeds', async () => {
    const dir = stateDir()
    const clock = new FakeClock(AT)
    const store = openStore({ stateDir: dir })
    const failing = createEffects({
      store,
      clock,
      logger: silentLogger,
      retry: { baseMs: 1_000, maxMs: 60_000 },
      handlers: {
        relay: () => {
          throw new Error('network down')
        },
      },
    })
    store.atomic(() => failing.enqueue('relay', 'k_backoff', { n: 1 }))
    await failing.pump()

    const failed = store.effects.get('relay', 'k_backoff')
    expect(failed?.attempts).toBe(1)
    expect(failed?.lastError).toContain('network down')
    expect(Date.parse(failed!.dueAt)).toBeGreaterThan(Date.parse(AT))
    closeStore(store)

    // Restart: the row and its attempt counter survive; a due-time in the
    // future keeps the pass from running early.
    const reopened = openStore({ stateDir: dir })
    const persisted = reopened.effects.get('relay', 'k_backoff')
    expect(persisted?.attempts).toBe(1)

    const early = createEffects({
      store: reopened,
      clock: new FakeClock(AT), // still before dueAt
      logger: silentLogger,
      handlers: { relay: () => undefined },
    })
    await early.pump()
    expect(reopened.effects.get('relay', 'k_backoff')).toBeDefined()

    // Once due, the retry succeeds and clears the row.
    const ran: string[] = []
    const later = createEffects({
      store: reopened,
      clock: { now: () => '2026-01-02T00:00:00.000Z' },
      logger: silentLogger,
      handlers: { relay: () => void ran.push('ran') },
    })
    await later.pump()
    expect(ran).toEqual(['ran'])
    expect(reopened.effects.all()).toHaveLength(0)
    closeStore(reopened)
  })

  it('drains an in-flight handler before stopping', async () => {
    const dir = stateDir()
    const store = openStore({ stateDir: dir })
    let finished = false
    let started = false
    const effects = new Effects({
      store,
      clock: new FakeClock(AT),
      logger: silentLogger,
      handlers: {
        relay: async () => {
          started = true
          await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
          finished = true
        },
      },
    })
    effects.enqueue('relay', 'k_drain', { n: 1 })
    const pumping = effects.pump()
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
    expect(started).toBe(true)

    await effects.stop()
    await pumping
    expect(finished).toBe(true)
    expect(store.effects.all()).toHaveLength(0)
    closeStore(store)
  })
})

// ---------------------------------------------------------------------------
// Schema compatibility
// ---------------------------------------------------------------------------

describe('schema compatibility', () => {
  it('refuses a newer database with a clear error and does not corrupt it', async () => {
    const dir = stateDir()
    // A future build wrote schema 99 and some data.
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(join(dir, 'superagent.sqlite'))
    raw.exec(`
      CREATE TABLE superagent_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO superagent_meta (name, value) VALUES ('schema_version', '99');
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO kv (key, value) VALUES ('precious', '"keep me"');
    `)
    raw.close()

    expect(() => openStore({ stateDir: dir })).toThrow(/newer than supported schema/i)

    // The file is still readable and untouched: same schema version, same data.
    const check = new DatabaseSync(join(dir, 'superagent.sqlite'))
    const version = check.prepare("SELECT value FROM superagent_meta WHERE name = 'schema_version'").get() as {
      value?: string
    }
    expect(version.value).toBe('99')
    const precious = check.prepare('SELECT value FROM kv WHERE key = ?').get('precious') as { value?: string }
    expect(precious.value).toBe('"keep me"')
    const integrity = check.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
    expect(integrity.integrity_check).toBe('ok')
    check.close()
  })

  it('stamps a fresh database with the supported schema version', async () => {
    const dir = stateDir()
    const store = openStore({ stateDir: dir })
    closeStore(store)

    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(join(dir, 'superagent.sqlite'))
    const row = raw.prepare("SELECT value FROM superagent_meta WHERE name = 'schema_version'").get() as {
      value?: string
    }
    expect(row.value).toBe(String(SCHEMA_VERSION))
    raw.close()
  })

  it('reopening an existing file is idempotent and keeps its rows', () => {
    const dir = stateDir()
    const store = openStore({ stateDir: dir })
    store.atomic(() => store.triggers.save(trigger('t_keep')))
    closeStore(store)

    const again = openStore({ stateDir: dir })
    expect(again.triggers.has('t_keep')).toBe(true)
    // And a third open must not throw either.
    closeStore(again)
    const third = openStore({ stateDir: dir })
    closeStore(third)
  })
})
