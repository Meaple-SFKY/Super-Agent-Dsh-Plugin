/**
 * Crash-point fixture for `tests/verify-recovery.spec.ts`.
 *
 * Runs the REAL `SqliteStore` + `Effects` implementation in a child process and
 * kills itself with SIGKILL at a controlled point, so the parent can verify
 * what survives a hard process death (no cleanup, no flush, no signal handler).
 *
 * This is plain JavaScript so the parent can spawn it with the same Node binary;
 * it imports the TypeScript sources directly (Node >= 22.18 type stripping).
 *
 *   node recovery-child.mjs <stateDir> <mode>
 *
 * modes:
 *   commit-then-die  — commit a trigger + a `relay` effect in one transaction, then SIGKILL
 *   mid-transaction  — SIGKILL inside `store.atomic()` before COMMIT
 *   handler-die      — run the effect handler (records one "send"), SIGKILL before the row is removed
 *   clean-run        — run the effect handler to completion and exit 0
 */

import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const { openStore } = await import(pathToFileURL(join(root, 'src', 'app', 'store.ts')).href)
const { createEffects } = await import(pathToFileURL(join(root, 'src', 'app', 'effects.ts')).href)

const [stateDir, mode] = process.argv.slice(2)
if (!stateDir || !mode) {
  console.error('usage: recovery-child.mjs <stateDir> <mode>')
  process.exit(2)
}

const at = new Date().toISOString()
const trigger = {
  id: `trigger:${mode}`,
  source: 'telegram',
  kind: 'message',
  at,
  thread: { key: 'telegram:dm:1', source: 'telegram' },
  actor: { id: '1', name: '@owner' },
  addressed: 'direct',
  text: 'hello from the crash fixture',
  channel: { source: 'telegram', thread: 'telegram:dm:1', to: '1' },
  meta: { fixture: true },
}

const sendsFile = join(stateDir, 'sends.jsonl')
const store = openStore({ stateDir })
const effects = createEffects({
  store,
  handlers: {
    relay: () => {
      appendFileSync(sendsFile, 'send\n')
      if (mode === 'handler-die') {
        process.kill(process.pid, 'SIGKILL')
      }
    },
  },
  retry: { baseMs: 1_000, maxMs: 60_000 },
})

switch (mode) {
  case 'commit-then-die': {
    store.atomic(() => {
      store.triggers.save(trigger)
      effects.enqueue('relay', `crash:${mode}`, { n: 1 })
    })
    process.kill(process.pid, 'SIGKILL')
    break
  }
  case 'mid-transaction': {
    store.atomic(() => {
      store.triggers.save(trigger)
      effects.enqueue('relay', `crash:${mode}`, { n: 1 })
      process.kill(process.pid, 'SIGKILL')
    })
    break
  }
  case 'handler-die':
  case 'clean-run': {
    store.atomic(() => {
      effects.enqueue('relay', `crash:${mode}`, { n: 1 })
    })
    await effects.pump()
    store.close()
    process.exit(0)
    break
  }
  default: {
    console.error(`unknown mode: ${mode}`)
    process.exit(2)
  }
}
