/**
 * Smoke tests for the optional web panel's Client module.
 *
 * The panel is hand-written plain JavaScript in the `window.__ModuleLoader__`
 * format. These tests evaluate it in Node with a fake loader, React and context
 * and assert the two slot registrations plus the failure-isolation contract: a
 * panel that cannot load must return a no-op module instead of throwing into
 * the host page.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const root = process.cwd()

interface LoaderEntry {
  id?: string
  factory?: (require: (specifier: string) => unknown) => unknown
}

interface FakeModule {
  inject?: string[]
  apply?: (ctx: unknown) => void
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
  const run = new Function('window', 'console', source) as (
    window: unknown,
    console: unknown,
  ) => void
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

  it('talks only to the documented panel API', async () => {
    const source = await readFile(join(root, 'src', 'client', 'main.js'), 'utf8')
    expect(source).toContain("const API = '/superagent/api'")
    expect(source).toContain('${API}/state')
    expect(source).toContain('${API}/action')
    expect(source).toContain("'x-superagent-request': '1'")
    expect(source).toContain("'pause'")
    expect(source).toContain("'resume'")
    expect(source).toContain("'retry'")
    expect(source).toContain("'stop'")
    // A broken host API must not crash the page: fetch failures are caught.
    expect(source).toContain('catch (error)')
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
