/**
 * Static validation of the bundle patch and the example profile patch.
 *
 * The project deliberately has no YAML dependency, so these tests read the
 * patches as text and assert the contract the runtime and the installer depend
 * on: the plugin row, the two agent presets, their tool lists, the 5-second
 * shell/job waits, and the commented machine configuration. The patches are
 * also validated for the YAML features we actually use (no tab indentation).
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

async function readText(relative: string): Promise<string> {
  return readFile(join(root, relative), 'utf8')
}

/** Text of one agent-preset declaration, from its loader row to the next one. */
function presetSection(patch: string, loaderId: string): string {
  const start = patch.indexOf(`- id: ${loaderId}`)
  expect(start, `missing preset row ${loaderId}`).toBeGreaterThan(-1)
  const next = patch.indexOf('- id: superagent-router-preset', start + 1)
  const end = next === -1 ? patch.length : next
  return patch.slice(start, end)
}

describe('cordis.patch.yml', () => {
  it('is a single insert layer with the plugin row', async () => {
    const patch = await readText('cordis.patch.yml')
    const firstCode = patch.split('\n').find(line => line.trim().length > 0 && !line.trimStart().startsWith('#'))
    expect(firstCode?.startsWith('- insert:')).toBe(true)
    expect(patch).toContain('id: dsh-superagent-personal')
    expect(patch).toMatch(/id: dsh-superagent-personal\n\s+name: dsh-superagent-personal/)
    expect(patch).not.toContain('\t')
  })

  it('declares exactly the two agent presets the runtime selects', async () => {
    const patch = await readText('cordis.patch.yml')
    expect(patch.match(/name: '@deepseek-ai\/dsh-agent-preset'/g)).toHaveLength(2)
    expect(patch).toContain('id: superagent-worker-preset')
    expect(patch).toContain('id: superagent-router-preset')
    expect(patch).toMatch(/\n {8}id: superagent-worker\n/)
    expect(patch).toMatch(/\n {8}id: superagent-router\n/)
    for (const section of [presetSection(patch, 'superagent-worker-preset'), presetSection(patch, 'superagent-router-preset')]) {
      expect(section).toContain('description:')
      expect(section).toContain('order:')
      expect(section).toContain('plugins:')
    }
  })

  it('gives the worker preset the execution tools', async () => {
    const patch = await readText('cordis.patch.yml')
    const worker = presetSection(patch, 'superagent-worker-preset')
    for (const required of [
      '@deepseek-ai/dsh-persona',
      '@deepseek-ai/dsh-agent-instructions',
      '@deepseek-ai/dsh-time-context',
      '@deepseek-ai/dsh-bash-sandbox',
      '@deepseek-ai/dsh-pwsh-sandbox',
      '@deepseek-ai/dsh-tool-bash',
      '@deepseek-ai/dsh-tool-pwsh',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-fs-search',
      '@deepseek-ai/dsh-tool-jobs',
      '@deepseek-ai/dsh-skill-filesystem',
      '@deepseek-ai/dsh-tool-skill',
      '@deepseek-ai/dsh-compaction-basic',
      '@deepseek-ai/dsh-command-compact',
      '@deepseek-ai/dsh-compaction-tool-result-pruner',
      '@deepseek-ai/dsh-tool-subagent-control',
      '@deepseek-ai/dsh-tool-subagent',
      '@deepseek-ai/dsh-tool-todo',
      '@deepseek-ai/dsh-tool-goal',
      '@deepseek-ai/dsh-tool-web',
    ]) {
      expect(worker, `worker preset is missing ${required}`).toContain(required)
    }
    expect(worker).toContain('timeoutMs: 5000')
    expect(worker).toContain('maxTimeoutMs: 5000')
    expect(worker).toContain('waitTimeoutMs: 5000')
    expect(worker).toContain('maxWaitTimeoutMs: 5000')
    expect(worker).toContain('agentPreset: standard')
    expect(worker).toMatch(/readImage: true/)
    expect(worker).not.toContain('@deepseek-ai/dsh-experimental-agent-team')
  })

  it('keeps the router preset read-only and scheduling-only', async () => {
    const patch = await readText('cordis.patch.yml')
    const router = presetSection(patch, 'superagent-router-preset')
    expect(router).toContain('@deepseek-ai/dsh-tool-fs')
    expect(router).toMatch(/write: false/)
    expect(router).toMatch(/edit: false/)
    expect(router).toContain('@deepseek-ai/dsh-tool-jobs')
    expect(router).toContain('waitTimeoutMs: 5000')
    expect(router).toContain('maxWaitTimeoutMs: 5000')
    expect(router).toContain('timeoutMs: 5000')
    expect(router).toContain('@deepseek-ai/dsh-tool-skill')
    expect(router).toContain('@deepseek-ai/dsh-compaction-basic')
    expect(router).not.toContain('@deepseek-ai/dsh-tool-web')
    expect(router).not.toContain('@deepseek-ai/dsh-tool-fs-search')
    expect(router).not.toContain('@deepseek-ai/dsh-tool-todo')
    expect(router).not.toContain('@deepseek-ai/dsh-tool-subagent')
    expect(router).not.toContain('@deepseek-ai/dsh-persona')
    expect(router).toMatch(/readImage: true/)
    expect(router).not.toContain('@deepseek-ai/dsh-tool-goal')
    expect(router).not.toContain('@deepseek-ai/dsh-tool-web')
  })
})

describe('examples/profile.cordis.patch.yml', () => {
  it('targets the plugin row with the machine configuration keys', async () => {
    const example = await readText('examples/profile.cordis.patch.yml')
    expect(example).toContain('id: dsh-superagent-personal')
    expect(example).toContain('enabled: true')
    expect(example).toMatch(/stateDir: <absolute path/)
    expect(example).toContain('tokenEnv: SUPERAGENT_TELEGRAM_TOKEN')
    expect(example).toContain('tokenEnv: SUPERAGENT_GITHUB_TOKEN')
    expect(example).toContain('allowedUserIds:')
    expect(example).toContain('repositories:')
    expect(example).toContain('mode: observe')
    expect(example).toContain('maxWorkers:')
    expect(example).not.toContain('\t')
  })

  it('explains secrets without containing any', async () => {
    const example = await readText('examples/profile.cordis.patch.yml')
    expect(example.toLowerCase()).toContain('environment')
    expect(example).toMatch(/never (belong|print)/i)
    expect(example).not.toMatch(/\d{6,}:[A-Za-z0-9_-]{20,}/)
    expect(example).not.toMatch(/github_pat_[A-Za-z0-9_]{20,}/)
    expect(example).not.toMatch(/ghp_[A-Za-z0-9]{20,}/)
  })
})

describe('package manifest and display resources', () => {
  it('declares the bundle patch, the client module, and the engines range', async () => {
    const pkg = JSON.parse(await readText('package.json')) as {
      name?: string
      exports?: Record<string, unknown>
      engines?: { node?: string; dsh?: string }
      dsh?: {
        bundle?: { patch?: string }
        client?: { platform?: string; inject?: string[]; immediately?: boolean }
      }
      files?: string[]
      peerDependencies?: Record<string, string>
    }
    expect(pkg.name).toBe('dsh-superagent-personal')
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh?.client?.platform).toBe('web')
    expect(pkg.dsh?.client?.immediately).toBe(true)
    expect(pkg.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-sidebar')
    expect(pkg.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(pkg.exports?.['./client']).toBe('./lib/client.js')
    expect(pkg.exports?.['./icon']).toBe('./icon.svg')
    expect(pkg.engines?.dsh).toBe('>=0.2.2-rc.1 <0.3.0')
    expect(pkg.engines?.node).toContain('22.19')
    expect(pkg.files).toContain('icon.svg')
    expect(pkg.files).toContain('locale/*.json')
    expect(pkg.peerDependencies?.['@deepseek-ai/dsh-app-boot']).toBe('0.2.2-rc.1')
  })

  it('ships parseable locale metadata and a valid SVG icon', async () => {
    for (const locale of ['en', 'zh']) {
      const parsed = JSON.parse(await readText(`locale/${locale}.json`)) as {
        meta?: { title?: string; description?: string }
      }
      expect(parsed.meta?.title, `${locale} title`).toBeTruthy()
      expect(parsed.meta?.description, `${locale} description`).toBeTruthy()
    }
    const icon = await readText('icon.svg')
    expect(icon.trimStart().startsWith('<svg')).toBe(true)
    expect(icon).toContain('</svg>')
    expect(Buffer.byteLength(icon)).toBeLessThan(256 * 1024)
  })

  it('runs the client build after tsdown', async () => {
    const pkg = JSON.parse(await readText('package.json')) as { scripts?: Record<string, string> }
    expect(pkg.scripts?.build).toContain('tsdown')
    expect(pkg.scripts?.build).toContain('scripts/build-client.mjs')
    const info = await stat(join(root, 'scripts', 'build-client.mjs'))
    expect(info.isFile()).toBe(true)
  })
})

describe('install and operations scripts', () => {
  it('ships the watchdog, launchd installer, plist, setup and uninstall scripts', async () => {
    for (const file of [
      'scripts/watchdog.mjs',
      'scripts/install-launchd.sh',
      'scripts/com.sfky.superagent.watchdog.plist',
      'scripts/setup.mjs',
      'scripts/uninstall.sh',
    ]) {
      const info = await stat(join(root, file))
      expect(info.isFile(), `${file} should exist`).toBe(true)
    }
    const plist = await readText('scripts/com.sfky.superagent.watchdog.plist')
    expect(plist).toContain('<key>Label</key>')
    expect(plist).toContain('__LABEL__')
    expect(plist).toContain('RunAtLoad')
    expect(plist).toContain('KeepAlive')
    expect(plist).toContain('StartInterval')
    const watchdog = await readText('scripts/watchdog.mjs')
    expect(watchdog).toContain('--dry-run')
    expect(watchdog).toContain('watchdog.log')
    expect(watchdog).toContain('backoff')
    expect(watchdog).not.toContain('TELEGRAM_TOKEN')
    expect(watchdog).not.toContain('GITHUB_TOKEN')
  })

  it('ships slim runtime assets: no sourcemaps and no internal docs', async () => {
    const pkg = JSON.parse(await readText('package.json')) as { files?: string[] }
    const files = pkg.files ?? []
    expect(files).toContain('lib/**/*.js')
    expect(files).toContain('lib/**/*.d.ts')
    expect(files).not.toContain('lib')
    expect(files).not.toContain('docs')
    expect(files).toContain('SETUP.md')
    expect(files).toContain('README.md')
    expect(files.filter(entry => entry.startsWith('docs/'))).toEqual([
      'docs/000-architecture.md',
      'docs/001-interfaces.md',
      'docs/002-setup-api.md',
      'docs/003-capabilities.md',
    ])
    // Internal QA notes must not reach an installed bundle.
    expect(files.some(entry => entry.includes('verification') || entry.includes('dsh-api-notes'))).toBe(false)

    const client = await readText('lib/client.js')
    expect(client).toContain('__ModuleLoader__')
    expect(client.length).toBeLessThan(150_000)
    const source = await readText('src/client/main.js')
    expect(client.length).toBeLessThan(source.length)
    expect(files.some(entry => entry.endsWith('.map'))).toBe(false)
  })

  it('ships the capability matrix and Telegram capability switches', async () => {
    const docs = await readText('docs/003-capabilities.md')
    for (const section of ['Goal', 'read_image', 'Workflow', 'Agent Team', 'Telegram', 'GitHub']) {
      expect(docs, `003 should mention ${section}`).toContain(section)
    }
    const config = await readText('src/index.ts')
    expect(config).toContain('richText')
    expect(config).toContain('files')
    expect(config).toContain('keyboards')
    const client = await readText('src/client/main.js')
    expect(client).toContain('telegram.capabilities')
    expect(client).toContain('telegram.richTextHint')
  })

  it('documents setup, verification, observe mode and uninstall', async () => {
    const setup = await readText('SETUP.md')
    for (const topic of [
      'BotFather',
      'fine-grained',
      'Contents: Read and write',
      'stateDir',
      'install_bundle',
      'dsh plugin --profile',
      '/status',
      'observe',
      'auto',
      'watchdog',
      'uninstall',
      'engines.dsh',
      'chmod 600',
    ]) {
      expect(setup, `SETUP.md should mention ${topic}`).toContain(topic)
    }
  })
})
