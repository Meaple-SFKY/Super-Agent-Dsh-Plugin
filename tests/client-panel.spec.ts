/**
 * Smoke tests for the optional web panel's Client module.
 *
 * The panel is hand-written plain JavaScript in the `window.__ModuleLoader__`
 * format. These tests evaluate it in Node with a fake loader, React and context
 * and check three things:
 *  - the two slot registrations, and that a panel which cannot load degrades to
 *    a no-op module instead of throwing into the host page;
 *  - the setup wizard's pure state machine (steps, validation gates, config
 *    payload), which is exported through `internals` for exactly this reason;
 *  - that the page only calls the documented panel and setup API paths.
 *
 * Rendering itself is intentionally not exercised here: without a browser the
 * visual result is verified after installation by the Lead.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

interface LoaderEntry {
  id?: string
  factory?: (require: (specifier: string) => unknown) => unknown
}

interface Wizard {
  step: number
  telegram: {
    status: string
    token: string
    botUsername: string
    tokenFile: string
    error: string
    skipped: boolean
  }
  github: {
    status: string
    token: string
    login: string
    tokenFile: string
    repositories: Array<{ fullName: string; private?: boolean; pushedAt?: string }>
    selected: string[]
    allowSelf: boolean
    operator: string
    personalToken: string
    sshKeyFile: string
    sshKeyPublic: string
    sshKeyGenerated: boolean
    sshKeyExisting: boolean
    sshKeyGenerating: boolean
    sshKeyRestarting: boolean
    sshKeyError: string
    error: string
    skipped: boolean
  }
  behavior: { allowedUserIds: string; mode: string; maxWorkers: number; language: string }
  finish: { status: string; error: string; elapsed: number }
}

interface Internals {
  views: {
    OverviewView: (props: Record<string, unknown>) => unknown
    SetupView: (props: Record<string, unknown>) => unknown
    PermissionsView: (props: Record<string, unknown>) => unknown
    ExpandableDetail: (props: Record<string, unknown>) => unknown
  }
  API_PATHS: Record<string, string>
  WIZARD_STEPS: string[]
  MAX_WORKERS: number
  RESTART_WAIT_MS: number
  defaultWizard: () => Wizard
  wizardFromSetup: (setup: unknown) => Wizard
  stepLabels: (t: (key: string) => string) => string[]
  stepStates: (wizard: Wizard) => string[]
  canAdvance: (step: number, wizard: Wizard) => boolean
  buildConfig: (wizard: Wizard) => {
    language: string
    sources: {
      telegram: { enabled: boolean; tokenFile?: string; allowedUserIds?: string[] }
      github: {
        enabled: boolean
        tokenFile?: string
        repositories?: string[]
        allowSelf?: boolean
        allowedLogins?: string[]
        collaborators?: string[]
        login?: string
      }
    }
    policy: { mode: string }
    executor: { maxWorkers: number; gitSshKeyFile?: string; gitName?: string; gitEmail?: string }
  }
  parseList: (value: string) => string[]
  parseUserIds: (value: string) => string[]
  setupLanguage: (setup: unknown) => string
  PERMISSION_KEYS: Record<string, string>
  permissionText: (entry: unknown, t: (key: string) => string) => { title: string; detail: string }
  dictionaries: Record<'zh' | 'en', Record<string, string>>
  repoEntry: (value: unknown) => { fullName: string } | undefined
  isSetupConfigured: (setup: unknown) => boolean
  expectedAccounts: (wizard: Wizard) => { telegram: boolean; github: boolean }
  accountsMatch: (setup: unknown, expected: { telegram: boolean; github: boolean }) => boolean
  errorText: (result: unknown) => string
}

interface FakeModule {
  inject?: string[]
  apply?: (ctx: unknown) => void
  internals?: Internals
}

function loadClient(source: string): { entry: LoaderEntry; warnings: string[] } {
  const entry: LoaderEntry = {}
  const warnings: string[] = []
  const fakeWindow = {
    __ModuleLoader__: {
      load(next: LoaderEntry) {
        entry.id = next.id
        entry.factory = next.factory
      },
    },
  }
  const fakeConsole = {
    warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
    log: () => undefined,
  }
  // The module is a classic script, not an ESM module.
  const run = new Function('window', 'console', source) as (window: unknown, console: unknown) => void
  run(fakeWindow, fakeConsole)
  return { entry, warnings }
}

function fakeReact() {
  return {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props: { ...(props ?? {}), children },
    }),
    useState: (initial: unknown) => [initial, () => undefined],
    useCallback: (callback: unknown) => callback,
    useEffect: () => undefined,
    useMemo: (factory: () => unknown) => factory(),
  }
}

/**
 * Hook-capable React double for one offline render: hooks keep their order per
 * component call, effects are recorded but never run (they would fetch).
 */
function renderableReact() {
  const hooks: unknown[] = []
  let index = 0
  return {
    reset() {
      index = 0
      hooks.length = 0
    },
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
      const merged: Record<string, unknown> = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useState(initial: unknown) {
      const slot = index++
      if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      const set = (next: unknown) => {
        hooks[slot] = typeof next === 'function' ? (next as (value: unknown) => unknown)(hooks[slot]) : next
      }
      return [hooks[slot], set]
    },
    useRef(initial: unknown) {
      const slot = index++
      if (!(slot in hooks)) hooks[slot] = { current: initial }
      return hooks[slot]
    },
    useCallback(callback: unknown) {
      return callback
    },
    useMemo(factory: () => unknown) {
      return factory()
    },
    useEffect() {
      // Network effects stay unrun in this smoke test.
    },
  }
}

function fakeCtx() {
  const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
  const slots: string[] = []
  const effects: unknown[] = []
  const localeNamespaces: string[] = []
  const ctx = {
    effect(factory: () => unknown) {
      effects.push(factory())
      return () => undefined
    },
    slots: {
      inject(owner: string, callback: () => unknown) {
        slots.push(owner)
        return callback()
      },
      register(options: Record<string, unknown>, component: unknown) {
        registrations.push({ options, component })
        return () => undefined
      },
    },
    locale: {
      register(namespace: string) {
        localeNamespaces.push(namespace)
        return () => undefined
      },
      bind() {
        return (key: string) => key
      },
    },
  }
  return { ctx, registrations, slots, effects, localeNamespaces }
}

async function loadModule(): Promise<FakeModule> {
  const source = await readFile(join(root, 'src', 'client', 'main.js'), 'utf8')
  const { entry } = loadClient(source)
  const factory = entry.factory
  if (factory === undefined) throw new Error('client module registered no factory')
  return factory(specifier => {
    if (specifier === 'react') return fakeReact()
    throw new Error(`unexpected require: ${specifier}`)
  }) as FakeModule
}

function internalsOf(module: FakeModule): Internals {
  if (module.internals === undefined) throw new Error('client module exports no internals')
  return module.internals
}

function setupState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    stateDir: '/tmp/superagent',
    plugin: { status: 'ready', detail: null },
    accounts: {
      telegram: { configured: false, enabled: false },
      github: { configured: false, enabled: false, repositories: [], count: 0 },
    },
    permissions: [],
    restartRequired: false,
    ...overrides,
  }
}

function baseWizard(module: FakeModule): Wizard {
  return internalsOf(module).defaultWizard()
}

function validatedWizard(module: FakeModule): Wizard {
  const wizard = baseWizard(module)
  wizard.telegram = {
    ...wizard.telegram,
    status: 'validated',
    botUsername: 'demo_bot',
    tokenFile: '/tmp/superagent/secrets/telegram-token',
  }
  wizard.github = {
    ...wizard.github,
    status: 'validated',
    login: 'agent-account',
    operator: 'alice',
    tokenFile: '/tmp/superagent/secrets/github-token',
    repositories: [{ fullName: 'acme/widgets' }, { fullName: 'acme/docs' }],
    selected: ['acme/widgets', 'acme/docs'],
  }
  wizard.behavior = { allowedUserIds: '123, 456 123', mode: 'auto', maxWorkers: 3, language: 'zh' }
  return wizard
}

describe('src/client/main.js', () => {
  it('registers a sidebar entry and its main page under the package name', async () => {
    const source = await readFile(join(root, 'src', 'client', 'main.js'), 'utf8')
    const { entry, warnings } = loadClient(source)

    expect(entry.id).toBe('dsh-superagent-personal')
    expect(typeof entry.factory).toBe('function')

    const factory = entry.factory
    if (factory === undefined) throw new Error('client module registered no factory')
    const module = factory((specifier: string) => {
      if (specifier === 'react') return fakeReact()
      throw new Error(`unexpected require: ${specifier}`)
    }) as FakeModule
    expect(module.inject).toContain('slots')
    expect(module.inject).toContain('locale')
    expect(typeof module.apply).toBe('function')

    const fake = fakeCtx()
    expect(() => module.apply?.(fake.ctx)).not.toThrow()
    expect(warnings).toHaveLength(0)
    expect(fake.localeNamespaces).toContain('superagent')
    expect(fake.slots).toContain('main')
    expect(fake.slots).toContain('sidebar.panellist')

    const main = fake.registrations.find(registration => registration.options.name === 'main')
    expect(main?.options.key).toBe('superagent')

    const panel = fake.registrations.find(registration => registration.options.name === 'sidebar.panellist')
    expect(panel?.options.id).toBe('superagent')
    expect(typeof panel?.options.label).toBe('function')
    expect((panel?.options.label as () => string)()).toBe('panel')

    expect(fake.effects.length).toBeGreaterThanOrEqual(3)
  })

  it('talks only to the documented panel and setup API', async () => {
    const source = await readFile(join(root, 'src', 'client', 'main.js'), 'utf8')
    expect(source).toContain("const API = '/superagent/api'")
    for (const path of [
      '${API}/state',
      '${API}/action',
      '${API}/setup/state',
      '${API}/setup/telegram',
      '${API}/setup/github',
      '${API}/setup/github/ssh-key',
      '${API}/setup/config',
      '${API}/setup/permissions',
    ]) {
      expect(source, path).toContain(path)
    }
    expect(source).toContain("'x-superagent-request': '1'")
    expect(source).toContain("method: 'POST'")
    expect(source).toContain("method: 'PUT'")
    for (const action of ["'pause'", "'resume'", "'retry'", "'stop'"]) {
      expect(source).toContain(action)
    }
    // A broken host API must not crash the page: request failures are caught.
    expect(source).toContain('catch (error)')
    // The wizard polls after saving so it can wait for the plugin restart.
    expect(source).toContain('RESTART_WAIT_MS')
  })

  it('follows the DSH-native rhythm, card and control sizes across all tabs', async () => {
    const source = await readFile(join(root, 'src', 'client', 'main.js'), 'utf8')
    // One page wrapper: flex column, 24px rhythm, used by all three tabs.
    expect(source).toContain('.sa-page { display: flex; flex-direction: column; gap: 24px; }')
    expect((source.match(/sa-page sa-fade/g) ?? []).length).toBe(3)
    // Native content width and one grid gap (20px) everywhere.
    expect(source).toContain('.sa-main { max-width: 960px;')
    expect(source).toContain('.sa-grid { display: grid; gap: 20px; }')
    expect(source).toContain('.sa-grid--stats { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }')
    expect(source).toContain('.sa-grid--two { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }')
    expect(source).not.toContain('grid-gap')
    expect(source).not.toMatch(/gap:\s*(32|36|40|44)px/)
    // Native card: 0.5px border, theme radius, layer-1 background, no heavy shadow.
    expect(source).toMatch(/\.sa-card \{[\s\S]*?border: \.5px solid var\(--dsw-alias-border-l2\);/)
    expect(source).toMatch(/\.sa-card \{[\s\S]*?border-radius: var\(--dsw-radius-lg\);/)
    expect(source).toMatch(/\.sa-card \{[\s\S]*?background: var\(--dsw-alias-bg-layer-1\);/)
    expect(source).toMatch(/\.sa-card \{[\s\S]*?padding: 20px;/)
    expect(source).toContain('.sa-card--hero { padding: 24px;')
    expect(source).not.toContain('0 6px 22px')
    // Native text scale.
    expect(source).toMatch(/\.sa-root \{[\s\S]*?font-size: 13px;/)
    expect(source).toMatch(/\.sa-root \{[\s\S]*?line-height: 20px;/)
    expect(source).toContain('.sa-stat-value { font-size: 28px;')
    expect(source).toContain('.sa-stat-label {')
    // Control and rhythm sizes.
    expect(source).toContain('margin-bottom: 12px;')
    expect(source).toContain('.sa-field { display: flex; flex-direction: column; gap: 12px; min-width: 0; }')
    expect(source).toContain('.sa-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }')
    expect(source).toContain('.sa-list { display: flex; flex-direction: column; gap: 8px; }')
    expect(source).toMatch(/\.sa-btn \{[\s\S]*?height: 32px;/)
    expect(source).toContain('.sa-btn--sm { height: 28px;')
    expect(source).toMatch(/\.sa-input, \.sa-textarea, \.sa-select \{[\s\S]*?min-height: 40px;/)
    expect(source).toContain('border: .5px solid var(--dsw-alias-border-l4);')
    expect(source).toMatch(/\.sa-row \{[\s\S]*?min-height: 44px;/)
    expect(source).toContain('border-bottom: .5px solid var(--dsw-alias-border-l2);')
    expect(source).toContain('@media (max-width: 900px)')
    // Tab roots use the shared class; only the four wizard step bodies keep the
    // bare animation class (they are single cards inside the page rhythm).
    expect((source.match(/className: 'sa-fade'/g) ?? []).length).toBe(4)
    expect(source).not.toMatch(/style: \{ display: 'flex', flexDirection: 'column', gap: (12|16|20|24|28|32) \}/)
  })

  it('offers SSH key generation via the setup API and keeps the advanced section closed by default', async () => {
    const source = await readFile(join(root, 'src', 'client', 'main.js'), 'utf8')
    expect(source).toContain('setupGithubSshKey')
    expect(source).toContain("${API}/setup/github/ssh-key")
    expect(source).toContain('github.generateKey')
    expect(source).toContain('github.publicKey')
    expect(source).toContain("'https://github.com/settings/keys'")
    expect(source).toContain('sa-checklist')
    expect(source).toContain('github.automationTitle')
    expect(source).toContain('github.manualTitle')
    expect(source).toContain('sshKeyRestarting')
    expect(source).toContain('waitForSetupReady')
    expect(source).toContain('github.keyExisting')
    expect(source).toContain('git.publicKey')

    const { entry } = loadClient(source)
    const react = renderableReact()
    const factory = entry.factory
    if (factory === undefined) throw new Error('client module registered no factory')
    const module = factory(specifier => {
      if (specifier === 'react') return react
      throw new Error(`unexpected require: ${specifier}`)
    }) as FakeModule
    const internals = internalsOf(module)
    const setup = { data: setupState(), error: '', loading: false, at: '' }
    const noop = () => undefined
    const wizard = validatedWizard(module)
    wizard.step = 1
    wizard.github = { ...wizard.github, sshKeyPublic: 'ssh-ed25519 AAAA-TEST-KEY', sshKeyGenerated: true }

    react.reset()
    const tree = JSON.stringify(
      internals.views.SetupView({
        t: (key: string) => key,
        wizard,
        setup,
        busy: '',
        saving: false,
        onSetWizard: noop,
        onValidateTelegram: noop,
        onValidateGithub: noop,
        onSave: noop,
        onSkipTelegram: noop,
        onSkipGithub: noop,
        onGenerateSshKey: noop,
        onOpenDashboard: noop,
        onReconfigure: noop,
      }),
    )
    expect(tree).toContain('github.advanced')
    expect(tree).toContain('github.automationTitle')
    expect(tree).not.toContain('AAAA-TEST-KEY')
  })

  it('clamps long source and health details instead of stretching cards', async () => {
    const source = await readFile(join(root, 'src', 'client', 'main.js'), 'utf8')
    expect(source).toContain('function ExpandableDetail')
    expect(source).toContain('sa-detail--clamp')
    expect(source).toContain('WebkitLineClamp')
    expect(source).toContain('sa-detaillink')
    expect(source).toContain("'common.expand'")
    expect(source).toContain("'common.collapse'")
    expect(source).toContain('overflow-wrap: anywhere')
    expect(source).toContain('overflow: hidden')
  })

  it('degrades to a no-op module when it cannot load', async () => {
    const source = await readFile(join(root, 'src', 'client', 'main.js'), 'utf8')
    const { entry, warnings } = loadClient(source)
    const module = entry.factory?.(() => {
      throw new Error('react missing')
    }) as FakeModule

    expect(module.inject).toEqual([])
    expect(() => module.apply?.({})).not.toThrow()
    expect(warnings.join(' ')).toContain('failed to load')
  })

  it('never throws when the slots service is missing', async () => {
    const source = await readFile(join(root, 'src', 'client', 'main.js'), 'utf8')
    const { entry } = loadClient(source)
    const module = entry.factory?.(() => fakeReact()) as FakeModule
    expect(() => module.apply?.({})).not.toThrow()
  })
})

describe('setup wizard state machine', () => {
  it('starts on step 0 with nothing verified', async () => {
    const module = await loadModule()
    const wizard = baseWizard(module)
    expect(wizard.step).toBe(0)
    expect(wizard.telegram.status).toBe('idle')
    expect(wizard.github.status).toBe('idle')
    expect(wizard.behavior.mode).toBe('observe')
    expect(wizard.behavior.maxWorkers).toBe(2)
    expect(wizard.behavior.language).toBe('zh')
    expect(wizard.github.operator).toBe('')
    expect(wizard.github.personalToken).toBe('')
    expect(wizard.github.sshKeyFile).toBe('')
    expect(wizard.github.sshKeyPublic).toBe('')
    expect(wizard.github.sshKeyGenerated).toBe(false)
    expect(wizard.github.sshKeyExisting).toBe(false)
    expect(wizard.github.sshKeyRestarting).toBe(false)
    expect(internalsOf(module).stepStates(wizard)).toEqual(['current', 'todo', 'todo', 'todo'])
    expect(internalsOf(module).canAdvance(0, wizard)).toBe(false)
  })

  it('hydrates from setup/state, including string repository lists', async () => {
    const module = await loadModule()
    const internals = internalsOf(module)
    const configured = internals.wizardFromSetup(
      setupState({
        language: 'en',
        accounts: {
          telegram: { configured: true, enabled: true, botUsername: 'demo_bot' },
          github: {
            configured: true,
            enabled: true,
            login: 'agent',
            repositories: ['acme/widgets'],
            count: 1,
            allowSelf: true,
            allowedLogins: ['alice'],
            collaborators: ['alice', 'bob'],
          },
        },
        git: {
          name: 'Superagent Bot',
          email: 'bot@example.com',
          sshKeyFile: '/home/me/.ssh/superagent_bot',
          sshKeyConfigured: true,
          publicKey: 'ssh-ed25519 AAAA-TEST user@example',
        },
      }),
    )
    expect(configured.telegram.status).toBe('validated')
    expect(configured.telegram.botUsername).toBe('demo_bot')
    expect(configured.github.status).toBe('validated')
    expect(configured.github.selected).toEqual(['acme/widgets'])
    expect(configured.github.allowSelf).toBe(false)
    expect(configured.behavior.language).toBe('en')
    expect(configured.github.operator).toBe('alice')
    expect(configured.github.sshKeyFile).toBe('/home/me/.ssh/superagent_bot')
    expect(configured.github.sshKeyGenerated).toBe(true)
    expect(configured.github.sshKeyPublic).toBe('ssh-ed25519 AAAA-TEST user@example')
    expect(internals.isSetupConfigured(setupState({ accounts: { telegram: { configured: true }, github: {} } }))).toBe(true)
    expect(internals.isSetupConfigured(setupState())).toBe(false)
    expect(internals.wizardFromSetup(setupState()).behavior.language).toBe('zh')
  })

  it('gates each step on its verification result', async () => {
    const module = await loadModule()
    const internals = internalsOf(module)
    const wizard = baseWizard(module)

    wizard.telegram = { ...wizard.telegram, status: 'validated', botUsername: 'demo_bot' }
    expect(internals.canAdvance(0, wizard)).toBe(true)
    wizard.telegram = { ...wizard.telegram, skipped: true, status: 'idle' }
    expect(internals.canAdvance(0, wizard)).toBe(true)

    wizard.github = { ...wizard.github, status: 'validated', selected: [] }
    expect(internals.canAdvance(1, wizard)).toBe(false)
    wizard.github = { ...wizard.github, selected: ['acme/widgets'], operator: 'alice' }
    expect(internals.canAdvance(1, wizard)).toBe(true)
    wizard.github = { ...wizard.github, operator: '' }
    expect(internals.canAdvance(1, wizard)).toBe(false)
    wizard.github = { ...wizard.github, operator: 'alice' }

    wizard.telegram = { ...wizard.telegram, skipped: false, status: 'validated' }
    wizard.behavior = { allowedUserIds: '', mode: 'observe', maxWorkers: 2, language: 'zh' }
    expect(internals.canAdvance(2, wizard)).toBe(false)
    wizard.behavior = { allowedUserIds: '123,456', mode: 'auto', maxWorkers: 3, language: 'zh' }
    expect(internals.canAdvance(2, wizard)).toBe(true)
    wizard.behavior = { ...wizard.behavior, mode: 'bogus' }
    expect(internals.canAdvance(2, wizard)).toBe(false)
    wizard.behavior = { ...wizard.behavior, mode: 'observe', maxWorkers: 99 }
    expect(internals.canAdvance(2, wizard)).toBe(false)
    wizard.behavior = { ...wizard.behavior, maxWorkers: 2, language: 'fr' }
    expect(internals.canAdvance(2, wizard)).toBe(false)
    wizard.behavior = { ...wizard.behavior, language: 'zh' }
    expect(internals.canAdvance(3, wizard)).toBe(true)
  })

  it('builds the PUT setup/config payload with token files and parsed ids', async () => {
    const module = await loadModule()
    const internals = internalsOf(module)
    const wizard = validatedWizard(module)
    const config = internals.buildConfig(wizard)

    expect(config.sources.telegram).toEqual({
      enabled: true,
      allowedUserIds: ['123', '456'],
      tokenFile: '/tmp/superagent/secrets/telegram-token',
    })
    expect(config.sources.github).toEqual({
      enabled: true,
      repositories: ['acme/widgets', 'acme/docs'],
      allowSelf: false,
      login: 'agent-account',
      tokenFile: '/tmp/superagent/secrets/github-token',
      allowedLogins: ['alice'],
      collaborators: ['alice'],
    })
    expect(config.language).toBe('zh')
    expect(config.policy).toEqual({ mode: 'auto' })
    expect(config.executor).toEqual({ maxWorkers: 3 })
  })

  it('writes the bot language and hydrates it from setup/state', async () => {
    const module = await loadModule()
    const internals = internalsOf(module)
    const wizard = validatedWizard(module)
    wizard.behavior = { ...wizard.behavior, language: 'en' }
    expect(internals.buildConfig(wizard).language).toBe('en')
    expect(internals.buildConfig(baseWizard(module)).language).toBe('zh')
    expect(internals.setupLanguage({ language: 'en' })).toBe('en')
    expect(internals.setupLanguage({ language: 'zh' })).toBe('zh')
    expect(internals.setupLanguage({ language: 'fr' })).toBe('zh')
    expect(internals.setupLanguage(undefined)).toBe('zh')
  })

  it('always writes allowSelf=false for the dedicated-bot flow', async () => {
    const module = await loadModule()
    const internals = internalsOf(module)
    const wizard = validatedWizard(module)
    wizard.github = { ...wizard.github, allowSelf: true }
    expect(internals.buildConfig(wizard).sources.github.allowSelf).toBe(false)
    // A not-yet-validated source is sent as disabled and carries no options.
    expect(internals.buildConfig(baseWizard(module)).sources.github).toEqual({ enabled: false })
  })

  it('writes the operator identity and generated SSH key path only when set', async () => {
    const module = await loadModule()
    const internals = internalsOf(module)
    const wizard = validatedWizard(module)

    // validatedWizard carries operator `alice`, so both lists derive from it.
    const withOperator = internals.buildConfig(wizard)
    expect(withOperator.sources.github.allowedLogins).toEqual(['alice'])
    expect(withOperator.sources.github.collaborators).toEqual(['alice'])
    expect(withOperator.executor.gitSshKeyFile).toBeUndefined()

    // Empty operator / SSH path keep the existing config untouched.
    wizard.github = { ...wizard.github, operator: '   ', sshKeyFile: '   ' }
    const plain = internals.buildConfig(wizard)
    expect(plain.sources.github.allowedLogins).toBeUndefined()
    expect(plain.sources.github.collaborators).toBeUndefined()
    expect(plain.executor.gitSshKeyFile).toBeUndefined()

    // Values are trimmed before writing.
    wizard.github = { ...wizard.github, operator: 'bob', sshKeyFile: ' /home/me/.ssh/superagent_bot ' }
    const generated = internals.buildConfig(wizard)
    expect(generated.sources.github.allowedLogins).toEqual(['bob'])
    expect(generated.sources.github.collaborators).toEqual(['bob'])
    expect(generated.executor.gitSshKeyFile).toBe('/home/me/.ssh/superagent_bot')
    expect(generated.executor.gitName).toBeUndefined()
    expect(generated.executor.gitEmail).toBeUndefined()
    expect(internals.parseList('a, b a; c')).toEqual(['a', 'b', 'c'])
  })

  it('disables skipped sources instead of sending half a configuration', async () => {
    const module = await loadModule()
    const internals = internalsOf(module)
    const wizard = baseWizard(module)
    wizard.telegram = { ...wizard.telegram, skipped: true }
    wizard.github = { ...wizard.github, skipped: true }
    wizard.behavior = { allowedUserIds: '', mode: 'observe', maxWorkers: 2, language: 'zh' }
    const config = internals.buildConfig(wizard)
    expect(config.sources.telegram).toEqual({ enabled: false })
    expect(config.sources.github).toEqual({ enabled: false })
  })

  it('parses ids and repository entries defensively', async () => {
    const module = await loadModule()
    const internals = internalsOf(module)
    expect(internals.parseUserIds('123, 456; 123\n789')).toEqual(['123', '456', '789'])
    expect(internals.parseUserIds('')).toEqual([])
    expect(internals.repoEntry('acme/widgets')).toEqual({ fullName: 'acme/widgets', private: false, pushedAt: '' })
    expect(internals.repoEntry({ fullName: 'acme/widgets', private: true, pushedAt: '2026-01-01T00:00:00Z' })).toEqual({
      fullName: 'acme/widgets',
      private: true,
      pushedAt: '2026-01-01T00:00:00Z',
    })
    expect(internals.repoEntry({})).toBeUndefined()
    expect(internals.errorText({ ok: false, error: 'nope' })).toBe('nope')
    expect(internals.errorText({})).toBe('request failed')
  })

  it('matches expected accounts after the restart poll', async () => {
    const module = await loadModule()
    const internals = internalsOf(module)
    const wizard = validatedWizard(module)
    const expected = internals.expectedAccounts(wizard)
    expect(expected).toEqual({ telegram: true, github: true })
    expect(
      internals.accountsMatch(
        setupState({
          accounts: {
            telegram: { configured: true },
            github: { configured: true, repositories: ['acme/widgets'] },
          },
        }),
        expected,
      ),
    ).toBe(true)
    expect(
      internals.accountsMatch(
        setupState({ accounts: { telegram: { configured: true }, github: { configured: false } } }),
        expected,
      ),
    ).toBe(false)
    expect(
      internals.accountsMatch(setupState(), internals.expectedAccounts(baseWizard(module))),
    ).toBe(true)
  })
})

describe('permissions localization', () => {
  it('maps every runtime permission id to zh/en copy and falls back for unknown ids', async () => {
    const module = await loadModule()
    const internals = internalsOf(module)
    const zh = (key: string) => internals.dictionaries.zh[key] ?? key
    const en = (key: string) => internals.dictionaries.en[key] ?? key
    const ids = [
      'filesystem',
      'network',
      'macos-screen-recording',
      'macos-accessibility',
      'macos-full-disk-access',
      'telegram-bot',
      'github-token',
      'watchdog',
      'restart',
    ]

    for (const id of ids) {
      const entry = { id, title: `EN title ${id}`, detail: `EN detail ${id}`, state: 'required', restartRequired: false }
      const localizedZh = internals.permissionText(entry, zh)
      expect(localizedZh.title, `${id} zh title`).not.toBe(entry.title)
      expect(localizedZh.title, `${id} zh title should be Chinese`).toMatch(/[\u4e00-\u9fff]/)
      expect(localizedZh.detail, `${id} zh detail`).not.toBe(entry.detail)
      expect(localizedZh.detail, `${id} zh detail should be Chinese`).toMatch(/[\u4e00-\u9fff]/)

      const key = internals.PERMISSION_KEYS[id]
      const localizedEn = internals.permissionText(entry, en)
      expect(localizedEn.title, `${id} en title`).toBe(internals.dictionaries.en[`${key}.title`])
      expect(localizedEn.detail, `${id} en detail`).toBe(internals.dictionaries.en[`${key}.detail`])
    }

    // Documented/alias ids that runtime may return now or later.
    for (const id of ['telegram-token', 'restart-required']) {
      const fallback = internals.permissionText({ id, title: 'EN title', detail: 'EN detail' }, zh)
      expect(fallback.title, id).not.toBe('EN title')
    }

    // Unknown ids keep the API text verbatim.
    expect(internals.permissionText({ id: 'future-permission', title: 'Future title', detail: 'Future detail' }, zh)).toEqual({
      title: 'Future title',
      detail: 'Future detail',
    })
  })

  it('renders runtime permissions in the panel locale, with state and restart labels localized', async () => {
    const source = await readFile(join(root, 'src/client', 'main.js'), 'utf8')
    const { entry } = loadClient(source)
    const react = renderableReact()
    const factory = entry.factory
    if (factory === undefined) throw new Error('client module registered no factory')
    const module = factory(specifier => {
      if (specifier === 'react') return react
      throw new Error(`unexpected require: ${specifier}`)
    }) as FakeModule
    const internals = internalsOf(module)
    const zh = (key: string) => internals.dictionaries.zh[key] ?? key

    react.reset()
    const tree = JSON.stringify(
      internals.views.PermissionsView({
        t: zh,
        permissions: {
          data: {
            ok: true,
            permissions: [
              { id: 'filesystem', title: 'State directory only', detail: 'English filesystem detail', state: 'required', restartRequired: false },
              { id: 'future-permission', title: 'Future title', detail: 'Future detail', state: 'optional', restartRequired: true },
            ],
          },
        },
        error: '',
        loading: false,
        at: '',
        onRefresh: () => undefined,
      }),
    )
    expect(tree).toContain(internals.dictionaries.zh['permission.filesystem.title'])
    expect(tree).not.toContain('State directory only')
    expect(tree).toContain('Future title')
    expect(tree).toContain(internals.dictionaries.zh['permissions.required'])
    expect(tree).toContain(internals.dictionaries.zh['common.restartRequired'])
  })
})

describe('panel render smoke test', () => {
  it('constructs the dashboard, every wizard step and the permissions page', async () => {
    const source = await readFile(join(root, 'src', 'client', 'main.js'), 'utf8')
    const { entry } = loadClient(source)
    const react = renderableReact()
    const factory = entry.factory
    if (factory === undefined) throw new Error('client module registered no factory')
    const module = factory(specifier => {
      if (specifier === 'react') return react
      throw new Error(`unexpected require: ${specifier}`)
    }) as FakeModule
    const internals = internalsOf(module)
    const t = (key: string) => key
    const noop = () => undefined

    const dashboard = {
      data: {
        ok: true,
        plugin: { status: 'ready', detail: null, version: '0.1.0' },
        paused: false,
        sources: [{ id: 'telegram', health: 'ready', detail: null, at: '' }],
        tickets: {
          attention: [{ id: 't1', title: 'Fix CI', kind: 'blocked', question: 'Ship it?', at: '' }],
          active: [{ id: 't2', title: 'Review', stage: 'working', lastReport: 'progress', at: '' }],
        },
        health: [{ name: 'runtime', state: 'ready', detail: null }],
      },
      error: '',
      loading: false,
      at: '',
    }
    const setup = { data: setupState(), error: '', loading: false, at: '' }
    const wizard = validatedWizard(module)
    const overviewProps = {
      t,
      state: dashboard,
      setup,
      busy: '',
      note: null,
      onAction: noop,
      onRefresh: noop,
      onOpenSetup: noop,
    }
    const setupProps = {
      t,
      setup,
      busy: '',
      saving: false,
      onSetWizard: noop,
      onValidateTelegram: noop,
      onValidateGithub: noop,
      onSave: noop,
      onSkipTelegram: noop,
      onSkipGithub: noop,
      onOpenDashboard: noop,
      onReconfigure: noop,
    }
    const permissionsProps = {
      t,
      permissions: {
        data: { ok: true, permissions: [{ id: 'x', title: 'Example', state: 'required', detail: 'details', restartRequired: true }] },
        error: '',
        loading: false,
        at: '',
      },
      onRefresh: noop,
    }

    react.reset()
    expect(() => internals.views.OverviewView(overviewProps)).not.toThrow()

    for (let step = 0; step < 4; step += 1) {
      react.reset()
      expect(() =>
        internals.views.SetupView({
          ...setupProps,
          wizard: { ...wizard, step, finish: { status: 'idle', error: '', elapsed: 0 } },
        }),
      ).not.toThrow()
    }

    react.reset()
    expect(() => internals.views.PermissionsView(permissionsProps)).not.toThrow()
  })

  it('renders long details collapsed with a toggle and short details plain', async () => {
    const source = await readFile(join(root, 'src', 'client', 'main.js'), 'utf8')
    const { entry } = loadClient(source)
    const react = renderableReact()
    const factory = entry.factory
    if (factory === undefined) throw new Error('client module registered no factory')
    const module = factory(specifier => {
      if (specifier === 'react') return react
      throw new Error(`unexpected require: ${specifier}`)
    }) as FakeModule
    const internals = internalsOf(module)
    const t = (key: string) => key

    react.reset()
    const long = JSON.stringify(internals.views.ExpandableDetail({ t, text: 'boom '.repeat(80), clamp: 3, threshold: 100 }))
    expect(long).toContain('sa-detail--clamp')
    expect(long).toContain('common.expand')
    expect(long).toContain('WebkitLineClamp')

    react.reset()
    const short = JSON.stringify(internals.views.ExpandableDetail({ t, text: 'ok', clamp: 3 }))
    expect(short).not.toContain('sa-detail--clamp')
    expect(short).not.toContain('common.expand')
  })
})
