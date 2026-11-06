/**
 * `.superagent-state` marker: the uninstall guard only deletes state directories
 * that carry this marker. The writer is deliberately best effort and must never
 * throw into the Host.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { STATE_MARKER_FILE, writeStateMarker } from '../src/app/watchdog.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-marker-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

describe('state marker', () => {
  it('writes a 0600 marker with the plugin id and timestamp', async () => {
    const dir = await tempDir()
    writeStateMarker(dir)

    const file = join(dir, STATE_MARKER_FILE)
    const info = await stat(file)
    expect(info.isFile()).toBe(true)
    expect(info.mode & 0o777).toBe(0o600)

    const body = JSON.parse(await readFile(file, 'utf8')) as { plugin?: string; at?: string; markerVersion?: number }
    expect(body.plugin).toBe('dsh-superagent-personal')
    expect(typeof body.at).toBe('string')
    expect(body.markerVersion).toBe(1)
  })

  it('accepts a custom plugin name and never throws on an unusable path', async () => {
    const dir = await tempDir()
    writeStateMarker(dir, 'custom-plugin')
    const body = JSON.parse(await readFile(join(dir, STATE_MARKER_FILE), 'utf8')) as { plugin?: string }
    expect(body.plugin).toBe('custom-plugin')

    expect(() => writeStateMarker('')).not.toThrow()
    expect(() => writeStateMarker('\0invalid')).not.toThrow()
  })
})
