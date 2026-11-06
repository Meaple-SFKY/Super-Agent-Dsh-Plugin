/**
 * Black-box tests for the packaging scripts: uninstall purge guardrails,
 * LaunchAgent rendering, and watchdog log rotation / status output.
 *
 * Every case uses a private HOME/DSH_HOME under the OS temp dir; nothing here
 * touches a real profile, LaunchAgent or state directory.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const dirs: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-scripts-'))
  dirs.push(dir)
  return dir
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

async function run(command: string, args: string[], env: Record<string, string>, cwd = root): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      env: { ...process.env, ...env },
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

describe('uninstall --purge-state guardrails', () => {
  it('refuses to purge the home directory even with --force', async () => {
    const sandbox = await tempRoot()
    const home = join(sandbox, 'home')
    await mkdir(home, { recursive: true })
    const result = await run('sh', [join(root, 'scripts', 'uninstall.sh'), '--state-dir', home, '--purge-state', '--force', '--keep-profile-config'], {
      HOME: home,
      DSH_HOME: join(sandbox, 'dsh'),
    })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/protected directory|blacklist/i)
    expect(await exists(home)).toBe(true)
  })

  it('accepts the state marker and deletes the state directory', async () => {
    const sandbox = await tempRoot()
    const home = join(sandbox, 'home')
    await mkdir(home, { recursive: true })
    const stateDir = join(sandbox, 'state', 'superagent')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, '.superagent-state'), JSON.stringify({ plugin: 'dsh-superagent-personal', at: 'x' }))
    await writeFile(join(stateDir, 'superagent.sqlite'), '')
    const result = await run('sh', [join(root, 'scripts', 'uninstall.sh'), '--state-dir', stateDir, '--purge-state', '--keep-profile-config'], {
      HOME: home,
      DSH_HOME: join(sandbox, 'dsh'),
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('state marker found')
    expect(await exists(stateDir)).toBe(false)
  })

  it('refuses a legacy state directory without a marker, then allows it with --force', async () => {
    const sandbox = await tempRoot()
    const home = join(sandbox, 'home')
    await mkdir(home, { recursive: true })
    const stateDir = join(sandbox, 'legacy-state')
    await mkdir(join(stateDir, 'secrets'), { recursive: true })
    await writeFile(join(stateDir, 'secrets', 'telegram-token'), 'token')
    const env = { HOME: home, DSH_HOME: join(sandbox, 'dsh') }
    const refused = await run('sh', [join(root, 'scripts', 'uninstall.sh'), '--state-dir', stateDir, '--purge-state', '--keep-profile-config'], env)
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toMatch(/marker|--force/i)
    expect(await exists(stateDir)).toBe(true)

    const forced = await run(
      'sh',
      [join(root, 'scripts', 'uninstall.sh'), '--state-dir', stateDir, '--purge-state', '--force', '--keep-profile-config'],
      env,
    )
    expect(forced.code).toBe(0)
    expect(await exists(stateDir)).toBe(false)
  })

  it('shows the purge plan and deletes nothing in --dry-run', async () => {
    const sandbox = await tempRoot()
    const home = join(sandbox, 'home')
    await mkdir(home, { recursive: true })
    const stateDir = join(sandbox, 'state')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, '.superagent-state'), JSON.stringify({ plugin: 'dsh-superagent-personal' }))
    await writeFile(join(stateDir, 'superagent.sqlite'), '')
    const result = await run(
      'sh',
      [join(root, 'scripts', 'uninstall.sh'), '--state-dir', stateDir, '--purge-state', '--dry-run', '--keep-profile-config'],
      { HOME: home, DSH_HOME: join(sandbox, 'dsh') },
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('purge plan')
    expect(result.stdout).toContain('no files were deleted')
    expect(await exists(stateDir)).toBe(true)
  })
})

describe('install-launchd rendering', () => {
  it('uses the absolute node path passed with --node and runs a dry self-check', async () => {
    const sandbox = await tempRoot()
    const home = join(sandbox, 'home')
    await mkdir(home, { recursive: true })
    const stateDir = join(sandbox, 'state')
    const nodePath = process.execPath
    const result = await run(
      'sh',
      [join(root, 'scripts', 'install-launchd.sh'), '--dry-run', '--state-dir', stateDir, '--node', nodePath],
      { HOME: home, DSH_HOME: join(sandbox, 'dsh') },
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`<string>${nodePath}</string>`)
    expect(result.stdout).toContain(`<string>${join(root, 'scripts', 'watchdog.mjs')}</string>`)
    expect(result.stderr).toContain('self-check would run')
    expect(await exists(join(home, 'Library', 'LaunchAgents', 'com.sfky.superagent.watchdog.plist'))).toBe(false)
  })

  it('rejects a relative node path', async () => {
    const sandbox = await tempRoot()
    const home = join(sandbox, 'home')
    await mkdir(home, { recursive: true })
    const result = await run(
      'sh',
      [join(root, 'scripts', 'install-launchd.sh'), '--dry-run', '--state-dir', join(sandbox, 'state'), '--node', 'node'],
      { HOME: home, DSH_HOME: join(sandbox, 'dsh') },
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/absolute path/i)
  })
})

describe('watchdog status and log rotation', () => {
  it('rotates a large log, keeps one backup, and writes watchdog-status.json', async () => {
    const sandbox = await tempRoot()
    const stateDir = join(sandbox, 'state')
    await mkdir(stateDir, { recursive: true })
    const logPath = join(stateDir, 'watchdog.log')
    await writeFile(logPath, 'old line\n'.repeat(200))
    const result = await run(
      process.execPath,
      [
        join(root, 'scripts', 'watchdog.mjs'),
        '--state-dir',
        stateDir,
        '--process-pattern',
        'definitely-not-running-superagent-scripts-test',
        '--dry-run',
        '--json',
        '--max-log-bytes',
        '200',
      ],
      { HOME: join(sandbox, 'home') },
    )
    expect(result.code).toBe(0)
    expect(await exists(`${logPath}.1`)).toBe(true)
    const rotated = await readFile(`${logPath}.1`, 'utf8')
    expect(rotated).toContain('old line')
    const current = await readFile(logPath, 'utf8')
    expect(Buffer.byteLength(current)).toBeLessThan(400)

    const statusPath = join(stateDir, 'watchdog-status.json')
    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
    expect(status.plugin).toBe('dsh-superagent-personal')
    expect(typeof status.status).toBe('string')
    expect(status.status).toBe('would-restart')
    expect(status.installed).toBeUndefined()
    expect(typeof status.at).toBe('string')
    expect(typeof status.checkedAt).toBe('string')
    expect(status.dryRun).toBe(true)
    expect(status.stateDir).toBe(stateDir)
  })

  it('honours --status-file and --log overrides for a one-shot check', async () => {
    const sandbox = await tempRoot()
    const stateDir = join(sandbox, 'state')
    await mkdir(stateDir, { recursive: true })
    const statusPath = join(sandbox, 'custom-status.json')
    const logPath = join(sandbox, 'custom.log')
    const result = await run(
      process.execPath,
      [
        join(root, 'scripts', 'watchdog.mjs'),
        '--state-dir',
        stateDir,
        '--process-pattern',
        'definitely-not-running-superagent-scripts-test',
        '--dry-run',
        '--json',
        '--status-file',
        statusPath,
        '--log',
        logPath,
      ],
      { HOME: join(sandbox, 'home') },
    )
    expect(result.code).toBe(0)
    expect(await exists(logPath)).toBe(true)
    expect(await exists(statusPath)).toBe(true)
    expect(await exists(join(stateDir, 'watchdog-status.json'))).toBe(false)
  })
})

