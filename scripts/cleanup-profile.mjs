#!/usr/bin/env node
/**
 * Remove the SuperAgent machine-configuration row from a DSH profile patch.
 *
 * The bundle manager removes the package and its manifest entry, but a profile
 * patch override row (the machine configuration the operator added) survives
 * that removal. This script removes exactly that row (plus the comment block
 * this repository writes above it) and leaves every other row untouched.
 *
 * Usage:
 *   node scripts/cleanup-profile.mjs --profile desktop [--dry-run]
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROW_ID = 'dsh-superagent-personal'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function usage() {
  return [
    'Usage: node scripts/cleanup-profile.mjs [options]',
    '',
    '  --profile <name>  DSH profile whose patch is cleaned (default: $DSH_PROFILE or "desktop")',
    '  --dsh-home <path> DSH home (default: $DSH_HOME or ~/.dsh)',
    '  --dry-run         Show what would be removed; write nothing',
    '  --help            Show this help',
  ].join('\n')
}

function parseArgs(argv) {
  const options = {
    profile: process.env.DSH_PROFILE ?? 'desktop',
    dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    dryRun: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--profile':
        options.profile = argv[++index] ?? options.profile
        break
      case '--dsh-home':
        options.dshHome = argv[++index]
        break
      case '--dry-run':
        options.dryRun = true
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

function isTargetRow(line) {
  return new RegExp(`^\\s*-\\s*id:\\s*["']?${ROW_ID}["']?\\s*$`).test(line)
}

/** A top-level loader row starts with a dash at column zero. */
function isTopLevelRow(line) {
  return /^-\s/.test(line)
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${String(error)}\n\n${usage()}\n`)
    process.exitCode = 1
    return
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }

  const profileDir = join(options.dshHome, 'profiles', options.profile)
  const patchPath = join(profileDir, 'cordis.patch.yml')

  let original
  try {
    original = await readFile(patchPath, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      process.stdout.write(`cleanup-profile: no patch at ${patchPath}; nothing to do\n`)
      return
    }
    throw error
  }

  const lines = original.split('\n')
  const index = lines.findIndex(isTargetRow)
  if (index < 0) {
    process.stdout.write(`cleanup-profile: ${ROW_ID} is not present in ${patchPath}\n`)
    return
  }

  // Include the comment block this repository writes immediately above the row.
  let start = index
  while (start > 0) {
    const previous = lines[start - 1].trim()
    if (previous === '') {
      start -= 1
      continue
    }
    if (previous.startsWith('#') && /superagent|machine configuration/i.test(previous)) {
      start -= 1
      continue
    }
    break
  }

  // The row owns the indented config block up to the next top-level row.
  let end = index + 1
  while (end < lines.length && !isTopLevelRow(lines[end])) end += 1

  const removed = lines.slice(start, end)
  const next = [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n')
  if (next === original) {
    process.stdout.write('cleanup-profile: nothing changed\n')
    return
  }
  if (options.dryRun) {
    process.stdout.write(`cleanup-profile: would remove ${removed.length} line(s) from ${patchPath}\n${removed.join('\n')}\n`)
    return
  }

  const backup = join('/tmp', `cordis.patch.yml.cleanup-${Date.now()}`)
  await copyFile(patchPath, backup)
  await writeFile(patchPath, next, { mode: 0o600 })
  process.stdout.write(`cleanup-profile: removed ${removed.length} line(s) from ${patchPath}\n`)
  process.stdout.write(`cleanup-profile: backup at ${backup}\n`)
}

await main()
