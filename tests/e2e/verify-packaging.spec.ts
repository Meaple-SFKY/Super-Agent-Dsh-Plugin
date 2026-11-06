/**
 * Packaging smoke: the static wiring an installation depends on.
 *
 * These are cheap cross-artifact checks that a rename or a moved file breaks
 * immediately, before the (Lead-performed) real `plugin_manager install_bundle`:
 *
 *  - every `package.json` entry point resolves to a built file;
 *  - `dsh.bundle.patch` and `dsh.client` are shaped like the Host expects;
 *  - `engines.dsh` agrees with the guardian's own `SUPPORTED_DSH`;
 *  - `cordis.patch.yml` declares the plugin row and the two preset ids the
 *    runtime selects, and `examples/profile.cordis.patch.yml` overrides the
 *    same plugin id;
 *  - the client module id equals the package name;
 *  - the assets the manifest lists exist.
 *
 * The real install (into a profile, with the Host's own version gate) is a
 * manual step documented in docs/verification.md.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface PackageJson {
  name: string
  main: string
  types: string
  exports: Record<string, unknown>
  dsh: {
    bundle?: { patch?: string }
    client?: { platform?: string; immediately?: boolean; inject?: string[]; external?: string[] }
    manifestVersion?: number
  }
  engines: { node?: string; dsh?: string }
  files: string[]
}

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(join(ROOT, relative), 'utf8')) as T
}

function readText(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/** Collect the file paths a `files`/`exports` value points at. */
function exportTargets(exports: PackageJson['exports']): string[] {
  const targets: string[] = []
  for (const value of Object.values(exports)) {
    if (typeof value === 'string') targets.push(value)
    else if (value !== null && typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        if (typeof nested === 'string') targets.push(nested)
      }
    }
  }
  return targets
}

const pkg = readJson<PackageJson>('package.json')

describe('package.json wiring', () => {
  it('is a Host bundle with a patch and a client entry', () => {
    expect(pkg.dsh.bundle?.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh.client?.platform).toBe('web')
    expect(pkg.dsh.manifestVersion).toBe(1)
    expect(existsSync(join(ROOT, 'cordis.patch.yml'))).toBe(true)
  })

  it('points every export at a built file', () => {
    expect(pkg.main).toBe('lib/index.js')
    expect(existsSync(join(ROOT, pkg.main))).toBe(true)
    expect(existsSync(join(ROOT, pkg.types))).toBe(true)
    const targets = exportTargets(pkg.exports).filter(target => !target.includes('*'))
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) {
      expect(existsSync(join(ROOT, target)), `missing export target ${target}`).toBe(true)
    }
    expect(existsSync(join(ROOT, 'lib/client.js'))).toBe(true)
    expect(existsSync(join(ROOT, 'lib/engine.js'))).toBe(true)
  })

  it('ships the runtime assets it lists', () => {
    // Built JS/declarations may be listed as directory globs (tarball installs),
    // so accept any entry that covers lib/ rather than the literal "lib".
    expect(pkg.files.some(entry => entry === 'lib' || entry.startsWith('lib/'))).toBe(true)
    for (const required of ['cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
      expect(pkg.files).toContain(required)
    }
    expect(existsSync(join(ROOT, 'locale/en.json'))).toBe(true)
    expect(existsSync(join(ROOT, 'locale/zh.json'))).toBe(true)
    expect(existsSync(join(ROOT, 'icon.svg'))).toBe(true)
    expect(existsSync(join(ROOT, 'SETUP.md'))).toBe(true)
  })

  it('declares the Node/DSH ranges the guardian enforces', () => {
    expect(pkg.engines.node).toBe('^22.19.0 || >=24.0.0')
    expect(pkg.engines.dsh).toBe('>=0.2.2-rc.1 <0.3.0')
  })
})

describe('bundle patch and presets', () => {
  const patch = readText('cordis.patch.yml')
  const example = readText('examples/profile.cordis.patch.yml')

  it('is one insert layer with the guardian row', () => {
    const firstCode = patch
      .split('\n')
      .find(line => line.trim().length > 0 && !line.trimStart().startsWith('#'))
    expect(firstCode?.startsWith('- insert:')).toBe(true)
    expect(patch).toContain('id: dsh-superagent-personal')
    expect(pkg.name).toBe('dsh-superagent-personal')
  })

  it('declares the preset ids the runtime selects', () => {
    // Runtime (src/app/runtime.ts) creates sessions with exactly these ids.
    const runtimeSource = readText('src/app/runtime.ts')
    expect(runtimeSource).toContain("router: 'superagent-router'")
    expect(runtimeSource).toContain("worker: 'superagent-worker'")
    // And the patch layer declares them as agent-preset rows.
    expect(patch).toMatch(/\n {8}id: superagent-router\n/)
    expect(patch).toMatch(/\n {8}id: superagent-worker\n/)
    expect(patch.match(/name: '@deepseek-ai\/dsh-agent-preset'/g)).toHaveLength(2)
  })

  it('keeps the example profile override on the same row id', () => {
    expect(example).toContain('id: dsh-superagent-personal')
    expect(example).toContain('stateDir:')
    expect(example).toContain('mode: observe')
    // The example must not carry a real token value.
    expect(example).not.toMatch(/token(?:Env|File)?:\s*(?!SUPERAGENT_|<|\/)[A-Za-z0-9:_-]{20,}/)
  })
})

describe('client module', () => {
  it('registers under the package name and needs the services the manifest injects', () => {
    const client = readText('src/client/main.js')
    expect(client).toContain("id: 'dsh-superagent-personal'")
    expect(client).toContain("const inject = ['slots', 'locale']")
    // The built copy may be minified/bundled: assert the loader id and the
    // package name survive the build rather than a specific quote style.
    const built = readText('lib/client.js')
    expect(built).toContain('__ModuleLoader__')
    expect(built).toContain(pkg.name)
    // Client bundles the Host must serve first are bundle names, not services.
    for (const bundle of pkg.dsh.client?.inject ?? []) expect(bundle.startsWith('@deepseek-ai/')).toBe(true)
  })
})

describe('guardian artifact', () => {
  it('exports the supported range that engines.dsh pins', async () => {
    const guardian = (await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)) as { SUPPORTED_DSH?: string }
    expect(guardian.SUPPORTED_DSH).toBe(pkg.engines.dsh)
  })
})
