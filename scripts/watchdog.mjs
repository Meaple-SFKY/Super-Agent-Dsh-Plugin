#!/usr/bin/env node
/**
 * External watchdog for a personal Superagent running inside DeepSeek Harness.
 *
 * The Host plugin already isolates engine failures from DSH boot. This script
 * covers the layer below it: the DSH process itself, which may be gone (crash,
 * macOS update, manual quit) or alive while the plugin heartbeat stopped
 * (hung engine). It checks, and when it is safe to do so, restarts DSH with
 * exponential backoff. It never reads or prints secrets.
 *
 * Run it once (the default; good for a launchd StartInterval job) or keep it
 * running with `--loop --interval 60`.
 *
 * What it checks, in order:
 *   1. The DSH process is alive (`pgrep -f <pattern>`); missing -> restart.
 *   2. `<stateDir>/superagent-status.json` (written by the guardian):
 *        - `stopped`  -> intentional kill switch; never restart.
 *        - `degraded` -> configuration/version problem; a restart cannot fix
 *                        it, so log, notify and exit 3.
 *   3. `<stateDir>/superagent-heartbeat.json` (written by the runtime while its
 *      loops run, with a final `status: "stopped"` on graceful stop):
 *        - fresh and `ready` -> healthy;
 *        - `stopped`, `paused: true` or `safeMode: true` -> intentional; never
 *          restart, even when the file is stale;
 *        - `degraded`/`error` -> the runtime asks for a recovery restart, still
 *          subject to the backoff below. The heartbeat intentionally carries
 *          no failure text; read `plugin.detail` from `/superagent/api/state`
 *          or the DSH log for the reason.
 *   4. Fallback: `<stateDir>/superagent.sqlite` mtime is fresh. An old SQLite
 *      file alone is not proof of life, so a stale heartbeat *plus* an old
 *      database is what triggers a restart.
 *
 * Backoff: after a restart the script refuses another one for an increasing
 * delay (60s, 120s, 240s, 480s, 900s) and stops restarting after
 * `--max-restarts` consecutive attempts, leaving a clear log line. A healthy
 * check for `--reset-after` seconds resets the counter.
 *
 * Exit codes (also used by SETUP.md and the launchd job):
 *   0  healthy, intentionally stopped, backing off, or `--dry-run`
 *   1  a restart was attempted or the process needs a person
 *   2  invalid configuration (state directory, arguments)
 *   3  plugin degraded; a restart will not help
 *
 * Usage:
 *   node scripts/watchdog.mjs --state-dir ~/.dsh/state/superagent
 *   node scripts/watchdog.mjs --state-dir ... --dry-run --json
 *   node scripts/watchdog.mjs --state-dir ... --loop --interval 60
 */

import { execFile, spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

const VERSION = 1
const DEFAULT_PROCESS_PATTERN = 'DeepSeek Harness'
const DEFAULT_STALE_SECONDS = 180
const DEFAULT_GRACE_SECONDS = 120
const DEFAULT_MAX_RESTARTS = 5
const DEFAULT_RESET_AFTER_SECONDS = 1_800
const BACKOFF_SECONDS = [60, 120, 240, 480, 900]
const LOG_FILE = 'watchdog.log'
const WATCHDOG_STATUS_FILE = 'watchdog-status.json'
const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024
const STATE_FILE = 'watchdog-state.json'
const STATUS_FILE = 'superagent-status.json'
const HEARTBEAT_FILE = 'superagent-heartbeat.json'
const DATABASE_FILE = 'superagent.sqlite'

/** Parse `--key value` and `--flag` arguments with a small, explicit schema. */
function parseArgs(argv) {
  const options = {
    stateDir: process.env.SUPERAGENT_STATE_DIR ?? join(homedir(), '.dsh', 'state', 'superagent'),
    processPattern: process.env.SUPERAGENT_PROCESS_PATTERN ?? DEFAULT_PROCESS_PATTERN,
    restartCommand: undefined,
    notifyCommand: process.env.SUPERAGENT_WATCHDOG_NOTIFY,
    log: undefined,
    statusFile: undefined,
    maxLogBytes: DEFAULT_MAX_LOG_BYTES,
    staleSeconds: DEFAULT_STALE_SECONDS,
    graceSeconds: DEFAULT_GRACE_SECONDS,
    maxRestarts: DEFAULT_MAX_RESTARTS,
    resetAfterSeconds: DEFAULT_RESET_AFTER_SECONDS,
    interval: 60,
    loop: false,
    dryRun: false,
    json: false,
    help: false,
  }
  const value = (name, raw) => {
    if (raw === undefined) throw new Error(`missing value for ${name}`)
    return raw
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--state-dir':
        options.stateDir = value(arg, argv[++index])
        break
      case '--process-pattern':
        options.processPattern = value(arg, argv[++index])
        break
      case '--restart-cmd':
        options.restartCommand = value(arg, argv[++index])
        break
      case '--notify-cmd':
        options.notifyCommand = value(arg, argv[++index])
        break
      case '--log':
        options.log = value(arg, argv[++index])
        break
      case '--status-file':
        options.statusFile = value(arg, argv[++index])
        break
      case '--max-log-bytes':
        options.maxLogBytes = Number.parseInt(value(arg, argv[++index]), 10)
        break
      case '--stale-seconds':
        options.staleSeconds = Number.parseInt(value(arg, argv[++index]), 10)
        break
      case '--grace-seconds':
        options.graceSeconds = Number.parseInt(value(arg, argv[++index]), 10)
        break
      case '--max-restarts':
        options.maxRestarts = Number.parseInt(value(arg, argv[++index]), 10)
        break
      case '--reset-after-seconds':
        options.resetAfterSeconds = Number.parseInt(value(arg, argv[++index]), 10)
        break
      case '--interval':
        options.interval = Number.parseInt(value(arg, argv[++index]), 10)
        break
      case '--loop':
        options.loop = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--json':
        options.json = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function help() {  return [
    'Usage: node scripts/watchdog.mjs --state-dir <absolute path> [options]',
    '',
    'Options:',
    '  --state-dir <path>        Superagent state directory (default: $SUPERAGENT_STATE_DIR)',
    '  --process-pattern <text>  pgrep -f pattern of the DSH process (default: "DeepSeek Harness")',
    '  --restart-cmd <command>   Shell command that starts DSH (default: open -a "DeepSeek Harness")',
    '  --notify-cmd <command>    Command run with SUPERAGENT_WATCHDOG_MESSAGE on notable events',
    '  --log <path>              Watchdog log file (default: <stateDir>/watchdog.log)',
    '  --status-file <path>      Runtime status JSON (default: <stateDir>/watchdog-status.json)',
    '  --max-log-bytes <n>       Rotate the log at this size (default: 2 MiB, keep one .1 backup)',
    '  --stale-seconds <n>       Heartbeat freshness bound (default: 180)',
    '  --grace-seconds <n>       Minimum delay between restarts (default: 120)',
    '  --max-restarts <n>        Consecutive restart cap (default: 5)',
    '  --reset-after-seconds <n> Healthy time before the counter resets (default: 1800)',
    '  --loop --interval <n>     Keep running instead of a single check (seconds, default: 60)',
    '  --dry-run                 Decide and log, but never restart',
    '  --json                    Print one machine-readable result line',
    '  --help                    Print this text',
    '',
    'Secrets are never read or printed. See SETUP.md.',
  ].join('\n')
}

function isAbsolutePath(value) {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value)
}

/** Rotate the log once it exceeds `maxLogBytes`; keep one `.1` backup. */
async function rotateLogIfNeeded(path, maxLogBytes) {
  if (!Number.isFinite(maxLogBytes) || maxLogBytes <= 0) return
  try {
    const info = await stat(path)
    if (info.size < maxLogBytes) return
    await rename(path, `${path}.1`)
  } catch {
    // Missing file or a rotation race: appending still works.
  }
}

function logPath(options) {
  return options.log ?? join(options.stateDir, LOG_FILE)
}

function statusPath(options) {
  return options.statusFile ?? join(options.stateDir, WATCHDOG_STATUS_FILE)
}

/** Append one line to the watchdog log; never throw. */
async function log(options, level, message) {
  const line = `${new Date().toISOString()} ${level} pid=${process.pid} ${message}\n`
  try {
    const path = logPath(options)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await rotateLogIfNeeded(path, options.maxLogBytes)
    await appendFile(path, line, { mode: 0o600 })
  } catch {
    // No log file: fall back to stderr so launchd still records something.
  }
  if (!options.json) process.stderr.write(line)
}

/** Publish the watchdog's own state for the panel/SETUP/troubleshooting. */
async function writeWatchdogStatus(options, result) {
  try {
    const path = statusPath(options)
    const existing = (await readJson(path)) ?? {}
    const stored = (await readJson(join(options.stateDir, STATE_FILE))) ?? {}
    const now = new Date().toISOString()
    const installed = typeof existing.installed === 'boolean' ? existing.installed : undefined
    const body = {
      ...existing,
      ...(installed === undefined ? {} : { installed }),
      plugin: 'dsh-superagent-personal',
      at: now,
      checkedAt: now,
      status: result.action,
      code: result.code,
      reason: result.reason ?? null,
      pid: process.pid,
      stateDir: options.stateDir,
      log: logPath(options),
      restarts: Number.isInteger(stored.restarts) ? stored.restarts : 0,
      lastRestartAt: typeof stored.lastRestartAt === 'string' ? stored.lastRestartAt : null,
      dryRun: options.dryRun === true,
    }
    await writeJson(path, body)
  } catch {
    // Status is best effort; the log already has the decision.
  }
}

async function readJson(path) {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

async function writeJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, path)
}

function ageSeconds(iso, now = Date.now()) {
  if (typeof iso !== 'string') return undefined
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return undefined
  return Math.max(0, Math.round((now - time) / 1000))
}

function isFresh(iso, staleSeconds, now = Date.now()) {
  const age = ageSeconds(iso, now)
  return age !== undefined && age <= staleSeconds
}

/** True when a process matching `pattern` is alive. */
function processAlive(pattern) {
  return new Promise(resolve => {
    execFile('pgrep', ['-f', pattern], { timeout: 10_000 }, (error, stdout) => {
      if (error !== null) {
        // pgrep exits 1 for "no match"; any failure is treated as "not found"
        // so a missing pgrep never restarts the machine by accident.
        resolve(false)
        return
      }
      resolve(stdout.trim().length > 0)
    })
  })
}

function runCommand(command, extraEnv = {}) {
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', command], {
      env: { ...process.env, ...extraEnv },
      stdio: 'ignore',
      detached: false,
    })
    child.on('error', error => resolve({ ok: false, detail: String(error) }))
    child.on('exit', code => resolve({ ok: code === 0, detail: `exit ${code}` }))
  })
}

function defaultRestartCommand() {
  if (process.platform === 'darwin') return 'open -a "DeepSeek Harness"'
  return 'dsh web'
}

async function notify(options, message) {
  if (typeof options.notifyCommand !== 'string' || options.notifyCommand.length === 0) return
  const result = await runCommand(options.notifyCommand, { SUPERAGENT_WATCHDOG_MESSAGE: message })
  if (!result.ok) await log(options, 'warn', `notify command failed: ${result.detail}`)
}

function backoffDelaySeconds(consecutiveRestarts, options) {
  if (consecutiveRestarts <= 0) return 0
  const base = BACKOFF_SECONDS[Math.min(consecutiveRestarts - 1, BACKOFF_SECONDS.length - 1)]
  return Math.max(base, options.graceSeconds)
}

/**
 * One check. Returns `{ code, action, reason }`; performs a restart unless
 * `--dry-run`. Never throws: every unexpected failure becomes a log line and a
 * code 1 result.
 */
async function check(options) {
  if (!isAbsolutePath(options.stateDir)) {
    await log(options, 'error', 'state directory must be an absolute path')
    return { code: 2, action: 'invalid-config', reason: 'stateDir must be absolute' }
  }

  const status = await readJson(join(options.stateDir, STATUS_FILE))
  const heartbeat =
    (await readJson(join(options.stateDir, HEARTBEAT_FILE))) ??
    (await readJson(join(options.stateDir, 'heartbeat.json')))
  const stored = (await readJson(join(options.stateDir, STATE_FILE))) ?? {}

  const alive = await processAlive(options.processPattern)
  const heartbeatFresh = heartbeat !== undefined && isFresh(heartbeat.at, options.staleSeconds)
  let databaseFresh = false
  try {
    const info = await stat(join(options.stateDir, DATABASE_FILE))
    databaseFresh = (Date.now() - info.mtimeMs) / 1000 <= options.staleSeconds
  } catch {
    databaseFresh = false
  }
  const heartbeatStatus = typeof heartbeat?.status === 'string' ? heartbeat.status : undefined
  const runtimeDegraded = heartbeatStatus === 'degraded' || heartbeatStatus === 'error'
  const intentional =
    (status !== undefined && status.status === 'stopped') ||
    heartbeatStatus === 'stopped' ||
    (heartbeat !== undefined && (heartbeat.paused === true || heartbeat.safeMode === true))

  // The runtime writes a final heartbeat with status "stopped" on graceful
  // stop, and its paused/safeMode flags mean "do not touch". Honor them even
  // when the heartbeat is stale, so an intentional stop cannot become a
  // restart loop.
  if (alive && intentional) {
    const reason =
      heartbeatStatus === 'stopped' || (status !== undefined && status.status === 'stopped')
        ? 'plugin stopped intentionally'
        : 'plugin paused or in safe mode'
    await log(options, 'info', `${reason}; not restarting`)
    return { code: 0, action: 'intentional-stop', reason }
  }

  // A healthy check resets a restart counter once the process has been stable.
  // A fresh heartbeat that reports degraded/error is not healthy: it is the
  // runtime asking for a recovery restart (subject to backoff).
  if (alive && !runtimeDegraded && (heartbeatFresh || databaseFresh)) {
    if ((stored.restarts ?? 0) > 0) {
      const sinceRestart = ageSeconds(stored.lastRestartAt)
      if (sinceRestart === undefined || sinceRestart >= options.resetAfterSeconds) {
        await writeJson(join(options.stateDir, STATE_FILE), {
          restarts: 0,
          lastRestartAt: null,
          lastHealthyAt: new Date().toISOString(),
        })
        await log(options, 'info', 'healthy; restart counter reset')
      }
    }
    return { code: 0, action: 'healthy', reason: heartbeatFresh ? 'heartbeat fresh' : 'database activity fresh' }
  }

  if (!alive) {
    return restart(options, stored, 'DSH process is not running')
  }

  // The guardian's degraded status is a boot configuration/version problem; a
  // DSH restart cannot fix it, so only report it.
  if (status !== undefined && status.status === 'degraded') {
    const detail = typeof status.detail === 'string' ? status.detail : 'unknown'
    await log(options, 'error', `plugin degraded (${detail}); a restart will not fix it, fix the configuration instead`)
    await notify(options, `Superagent degraded: ${detail}. A restart will not fix it; check the DSH log and stateDir.`)
    return { code: 3, action: 'degraded', reason: detail }
  }

  if (runtimeDegraded) {
    // The heartbeat deliberately carries no failure text (it could contain
    // model/store error strings). Point at the safe sources instead of reading
    // a field that does not exist.
    return restart(
      options,
      stored,
      `runtime heartbeat reports ${heartbeatStatus}; check the DSH log and /superagent/api/state (plugin.detail) for the reason`,
    )
  }

  if (heartbeatFresh || databaseFresh) {
    return { code: 0, action: 'healthy', reason: 'fresh activity' }
  }

  const detail =
    heartbeat === undefined
      ? `no heartbeat and no SQLite activity within ${options.staleSeconds}s`
      : `heartbeat is ${ageSeconds(heartbeat.at) ?? '?'}s old (bound ${options.staleSeconds}s)`
  return restart(options, stored, detail)
}

async function restart(options, stored, reason) {
  const restarts = Number.isInteger(stored.restarts) ? stored.restarts : 0
  const lastRestartAt = typeof stored.lastRestartAt === 'string' ? stored.lastRestartAt : undefined
  const sinceLast = ageSeconds(lastRestartAt)

  if (restarts >= options.maxRestarts) {
    await log(
      options,
      'error',
      `${reason}; ${restarts} consecutive restarts already attempted, stopping automatic recovery. Fix DSH or the Superagent configuration, then run with --dry-run to verify.`,
    )
    await notify(options, `Superagent watchdog: ${restarts} restarts failed; automatic recovery stopped. ${reason}`)
    return { code: 1, action: 'gave-up', reason }
  }

  const delay = backoffDelaySeconds(restarts, options)
  if (sinceLast !== undefined && sinceLast < delay) {
    await log(options, 'info', `${reason}; backing off for ${delay - sinceLast}s before another restart`)
    return { code: 0, action: 'backoff', reason }
  }

  const command = options.restartCommand ?? defaultRestartCommand()
  if (options.dryRun) {
    await log(options, 'warn', `${reason}; dry-run: would restart with "${command}"`)
    return { code: 0, action: 'would-restart', reason }
  }

  await log(options, 'warn', `${reason}; restarting DSH with "${command}" (attempt ${restarts + 1}/${options.maxRestarts})`)
  const result = await runCommand(command)
  await writeJson(join(options.stateDir, STATE_FILE), {
    restarts: restarts + 1,
    lastRestartAt: new Date().toISOString(),
    lastReason: reason,
    lastCommand: command,
    lastResult: result.detail,
  })
  if (!result.ok) {
    await log(options, 'error', `restart command failed: ${result.detail}`)
    await notify(options, `Superagent watchdog: restart command failed (${result.detail}). ${reason}`)
    return { code: 1, action: 'restart-failed', reason }
  }
  await notify(options, `Superagent watchdog: restarted DSH (${reason}).`)
  return { code: 1, action: 'restarted', reason }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${String(error)}\n\n${help()}\n`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    process.stdout.write(`${help()}\n`)
    return
  }
  for (const key of ['staleSeconds', 'graceSeconds', 'maxRestarts', 'resetAfterSeconds', 'interval', 'maxLogBytes']) {
    if (!Number.isInteger(options[key]) || options[key] < 0) {
      process.stderr.write(`invalid numeric option: --${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}\n`)
      process.exitCode = 2
      return
    }
  }
  if (!isAbsolutePath(options.stateDir)) {
    // Logging needs a directory; report on stderr before any log attempt.
    process.stderr.write('watchdog: --state-dir must be an absolute path\n')
    process.exitCode = 2
    return
  }

  const runOnce = async () => {
    try {
      const result = await check(options)
      await writeWatchdogStatus(options, result)
      if (options.json) process.stdout.write(`${JSON.stringify({ ...result, at: new Date().toISOString() })}\n`)
      process.exitCode = result.code
      return result
    } catch (error) {
      await log(options, 'error', `watchdog check failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      const result = { code: 1, action: 'error', reason: String(error) }
      await writeWatchdogStatus(options, result)
      process.exitCode = 1
      return result
    }
  }

  if (!options.loop) {
    await runOnce()
    return
  }

  await log(options, 'info', `watchdog ${VERSION} started (interval ${options.interval}s, dry-run=${options.dryRun})`)
  await writeWatchdogStatus(options, {
    action: 'started',
    code: 0,
    reason: `loop interval ${options.interval}s`,
  })
  let stopped = false
  const stop = () => {
    stopped = true
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  while (!stopped) {
    await runOnce()
    const intervalMs = Math.max(5, options.interval) * 1_000
    await new Promise(resolve => {
      // Kept referenced on purpose: an unref'd timer would let the loop exit.
      setTimeout(resolve, intervalMs)
    })
  }
  await log(options, 'info', 'watchdog stopped')
}

await main()
