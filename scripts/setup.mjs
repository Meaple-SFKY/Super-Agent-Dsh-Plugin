#!/usr/bin/env node
/**
 * Interactive setup for dsh-superagent-personal.
 *
 * It checks the machine prerequisites and prepares what can be prepared
 * without guessing: the state directory, the profile's machine configuration
 * (opt-in with `--write-patch`), and the presence of the two secrets. It never
 * installs the bundle into a profile (that is the user's decision, through
 * DeepSeek Harness or the command it prints), never restarts DSH, and never
 * reads, prints or writes a secret value.
 *
 * Usage:
 *   node scripts/setup.mjs --profile superagent
 *   node scripts/setup.mjs --profile superagent --state-dir ~/.dsh/state/superagent --write-patch
 *   node scripts/setup.mjs --profile superagent --check-only
 *
 * Exit codes: 0 ready (missing secrets are warnings), 1 a prerequisite failed.
 */

import { access, chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TELEGRAM_ENV = 'SUPERAGENT_TELEGRAM_TOKEN'
const GITHUB_ENV = 'SUPERAGENT_GITHUB_TOKEN'
// All generated secrets and keys live under the plugin's own state directory,
// so removing the state directory removes every credential too.
const SECRETS_DIRNAME = 'secrets'

const results = []
const ok = message => results.push({ level: 'ok', message })
const warn = message => results.push({ level: 'warn', message })
const fail = message => results.push({ level: 'fail', message })

function parseArgs(argv) {
  const options = {
    profile: process.env.DSH_PROFILE ?? 'superagent',
    dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    stateDir: process.env.SUPERAGENT_STATE_DIR ?? undefined,
    writePatch: false,
    checkOnly: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--profile':
        options.profile = argv[++index] ?? options.profile
        break
      case '--dsh-home':
        options.dshHome = argv[++index] ?? options.dshHome
        break
      case '--state-dir':
        options.stateDir = argv[++index]
        break
      case '--write-patch':
        options.writePatch = true
        break
      case '--check-only':
        options.checkOnly = true
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

function help() {
  return [
    'Usage: node scripts/setup.mjs [options]',
    '',
    '  --profile <name>     DSH profile to configure (default: $DSH_PROFILE or "superagent")',
    '  --dsh-home <path>    DSH home directory (default: $DSH_HOME or ~/.dsh)',
    '  --state-dir <path>   Superagent state directory (default: <dsh-home>/state/superagent)',
    '  --write-patch        Create/append the machine configuration row in the profile patch',
    '  --check-only         Only check prerequisites; write nothing',
    '  --help               Show this help',
    '',
    'Secrets are only detected, never read or printed. See SETUP.md.',
  ].join('\n')
}

function shortPath(path) {
  const home = homedir()
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function report() {
  for (const result of results) {
    const mark = result.level === 'ok' ? '[ok]  ' : result.level === 'warn' ? '[warn]' : '[fail]'
    process.stdout.write(`${mark} ${result.message}\n`)
  }
}

async function canWrite(directory) {
  const probe = join(directory, `.setup-probe-${process.pid}`)
  try {
    await writeFile(probe, 'probe', { mode: 0o600 })
    await unlink(probe)
    return true
  } catch {
    return false
  }
}

async function fileMode(path) {
  try {
    const info = await stat(path)
    return info.mode & 0o777
  } catch {
    return undefined
  }
}

async function checkSecret(label, envName, filePath) {
  const fromEnv = (process.env[envName] ?? '').trim().length > 0
  let fromFile = false
  const mode = await fileMode(filePath)
  if (mode !== undefined) {
    fromFile = true
    if ((mode & 0o077) !== 0o0) {
      warn(`${label}: ${shortPath(filePath)} is readable by group/others (mode ${mode.toString(8)}); run: chmod 600 ${shortPath(filePath)}`)
    }
  }
  if (fromEnv) ok(`${label}: found in environment ${envName}`)
  else if (fromFile) ok(`${label}: found in token file ${shortPath(filePath)}`)
  else {
    warn(`${label}: missing (set ${envName}, or write the token to ${shortPath(filePath)} with mode 600)`)
  }
}

function configBlock(stateDir) {
  return [
    '# Added by scripts/setup.mjs: machine configuration for dsh-superagent-personal.',
    '# Fill in the sources below; see examples/profile.cordis.patch.yml and SETUP.md.',
    '# Secrets are referenced by name (tokenEnv/tokenFile), never written here.',
    '- id: dsh-superagent-personal',
    '  config:',
    '    enabled: true',
    `    stateDir: ${JSON.stringify(stateDir)}`,
    '    sources:',
    '      telegram:',
    '        enabled: false',
    `        tokenEnv: ${TELEGRAM_ENV}`,
    '        allowedUserIds: []',
    '      github:',
    '        enabled: false',
    `        tokenEnv: ${GITHUB_ENV}`,
    '        repositories: []',
    '    policy:',
    '      mode: observe',
    '',
  ].join('\n')
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${String(error)}\n\n${help()}\n`)
    process.exitCode = 1
    return
  }
  if (options.help) {
    process.stdout.write(`${help()}\n`)
    return
  }

  const stateDir = options.stateDir ?? join(options.dshHome, 'state', 'superagent')
  const profileDir = join(options.dshHome, 'profiles', options.profile)
  const patchPath = join(profileDir, 'cordis.patch.yml')

  process.stdout.write(`Superagent setup\n  repository: ${ROOT}\n  profile:    ${options.profile} (${shortPath(profileDir)})\n  state dir:  ${shortPath(stateDir)}\n\n`)

  // -- state directory ------------------------------------------------------
  if (!isAbsolute(stateDir)) {
    fail('stateDir must be an absolute path')
  } else {
    try {
      await mkdir(stateDir, { recursive: true, mode: 0o700 })
      try {
        await chmod(stateDir, 0o700)
      } catch {
        // Best effort on filesystems that do not support it.
      }
      if (await canWrite(stateDir)) {
        ok(`state dir: ${shortPath(stateDir)} exists and is writable`)
        const rel = relative(ROOT, stateDir)
        if (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)) {
          warn('state dir is inside the repository; add it to .gitignore or choose a directory outside the checkout')
        }
      } else {
        fail(`state dir: ${shortPath(stateDir)} is not writable`)
      }
    } catch (error) {
      fail(`state dir: cannot create ${shortPath(stateDir)} (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  // -- bundle build ---------------------------------------------------------
  try {
    await access(join(ROOT, 'lib', 'index.js'))
    ok('bundle build: lib/index.js exists')
  } catch {
    warn('bundle build: lib/index.js is missing; run ./scripts/pnpmw check (or ./scripts/pnpmw build) first')
  }
  try {
    await access(join(ROOT, 'cordis.patch.yml'))
    ok('bundle patch: cordis.patch.yml exists')
  } catch {
    fail('bundle patch: cordis.patch.yml is missing; the checkout is incomplete')
  }

  // -- profile --------------------------------------------------------------
  let profileExists = false
  try {
    const info = await stat(profileDir)
    profileExists = info.isDirectory()
  } catch {
    profileExists = false
  }
  if (!profileExists) {
    fail(
      `profile: ${shortPath(profileDir)} does not exist. Create it once with: dsh ${options.profile} --from-default-profile web --dump-config > /dev/null`,
    )
  } else {
    ok(`profile: ${shortPath(profileDir)} exists`)
  }

  // -- machine configuration ------------------------------------------------
  if (!options.checkOnly && profileExists) {
    let existing
    try {
      existing = await readFile(patchPath, 'utf8')
    } catch {
      existing = undefined
    }
    if (existing !== undefined && existing.includes('id: dsh-superagent-personal')) {
      ok(`configuration: ${shortPath(patchPath)} already has the dsh-superagent-personal row`)
    } else if (!options.writePatch) {
      warn(
        `configuration: add the machine configuration row to ${shortPath(patchPath)} (see examples/profile.cordis.patch.yml), or re-run with --write-patch`,
      )
    } else if (existing === undefined) {
      await mkdir(profileDir, { recursive: true })
      const header =
        '# Your patch layer for this dsh profile, applied after every bundle layer.\n' +
        '# A top-level YAML array of loader patch entries; `!!js` expressions allowed.\n\n'
      await writeFile(patchPath, header + configBlock(stateDir), { mode: 0o600 })
      ok(`configuration: created ${shortPath(patchPath)} with the machine configuration row`)
    } else {
      const suffix = existing.endsWith('\n') ? '' : '\n'
      await writeFile(patchPath, `${existing}${suffix}\n${configBlock(stateDir)}`, { mode: 0o600 })
      ok(`configuration: appended the machine configuration row to ${shortPath(patchPath)}`)
    }
  } else if (options.checkOnly) {
    ok('configuration: --check-only, no files written')
  }

  // -- secrets (presence only; values are never read) -----------------------
  const secretsDir = join(stateDir, SECRETS_DIRNAME)
  await mkdir(secretsDir, { recursive: true, mode: 0o700 }).catch(() => {})
  await checkSecret('Telegram bot token', TELEGRAM_ENV, join(secretsDir, 'telegram-token'))
  await checkSecret('GitHub token', GITHUB_ENV, join(secretsDir, 'github-token'))

  // -- summary --------------------------------------------------------------
  report()

  const failed = results.filter(result => result.level === 'fail').length
  process.stdout.write('\nNext steps\n')
  process.stdout.write(`  1. Build:  ./scripts/pnpmw install && ./scripts/pnpmw check\n`)
  process.stdout.write(`  2. Install the bundle into the profile (once):\n`)
  process.stdout.write(`       dsh plugin --profile ${options.profile} add "link:${ROOT}"\n`)
  process.stdout.write(`     or install the unpacked directory from the Plugin Manager.\n`)
  process.stdout.write(`  3. Fill in sources/policy in ${shortPath(patchPath)}; keep policy.mode: observe at first.\n`)
  process.stdout.write(`  4. Restart DeepSeek Harness, open the Superagent panel, and send /status to your bot.\n`)
  process.stdout.write(`  5. When candidates look right, switch policy.mode to auto.\n`)
  process.stdout.write(`  6. Install the watchdog: ./scripts/install-launchd.sh --state-dir ${shortPath(stateDir)}\n`)
  process.stdout.write(`\nSecrets stay in ${shortPath(join(stateDir, SECRETS_DIRNAME))} (mode 600, inside the plugin state directory) or in environment variables; never in the repo or chat.\n`)

  process.exitCode = failed > 0 ? 1 : 0
}

await main()
