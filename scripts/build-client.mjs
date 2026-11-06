#!/usr/bin/env node
/**
 * Build the hand-written Client module into the package output.
 *
 * The Host half is built by tsdown (`lib/index.js`, `lib/engine.js`). The
 * Client half is a plain-JavaScript dynamic Client module in the
 * `window.__ModuleLoader__` format the browser loader expects; it is not part
 * of the Node ESM build graph.
 *
 * The file is minified with rolldown (already a dependency of tsdown, resolved
 * through it so no new package is added). Bundling is safe here: the client has
 * no imports and keeps its side effect (`window.__ModuleLoader__.load(...)`).
 * If rolldown is unavailable the source is copied verbatim so a build never
 * fails for a tooling reason.
 *
 * Runs after tsdown because tsdown cleans `lib/` before building.
 */
import { createRequire } from 'node:module'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'client', 'main.js')
const target = join(root, 'lib', 'client.js')

await mkdir(dirname(target), { recursive: true })

/** Resolve rolldown through tsdown (both are already installed). */
async function loadRolldown() {
  try {
    const require = createRequire(import.meta.url)
    const tsdownEntry = require.resolve('tsdown')
    const tsdownRequire = createRequire(tsdownEntry)
    const rolldownPath = tsdownRequire.resolve('rolldown')
    return await import(pathToFileURL(rolldownPath).href)
  } catch {
    return undefined
  }
}

async function minifyWithRolldown(code) {
  const mod = await loadRolldown()
  if (!mod || typeof mod.rolldown !== 'function') return undefined
  const bundle = await mod.rolldown({ input: source, logLevel: 'silent' })
  try {
    const generated = await bundle.generate({ format: 'es', minify: true, sourcemap: false })
    const chunk = generated.output.find(entry => entry.type === 'chunk')
    if (!chunk || typeof chunk.code !== 'string' || chunk.code.length === 0) return undefined
    // A minified file must still expose the loader entry point.
    if (!chunk.code.includes('__ModuleLoader__')) return undefined
    return chunk.code
  } finally {
    await bundle.close().catch(() => undefined)
  }
}

const sourceCode = await readFile(source, 'utf8')
let output = await minifyWithRolldown(sourceCode)
if (output === undefined) {
  console.warn('client bundle: rolldown unavailable; copying unminified source')
  await copyFile(source, target)
} else {
  await writeFile(target, output, { mode: 0o644 })
}
const info = await stat(target)
console.log(`client bundle: ${target} (${info.size} bytes)`)
