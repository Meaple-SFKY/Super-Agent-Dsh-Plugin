#!/usr/bin/env node
/**
 * Copy the hand-written Client module into the package output.
 *
 * The Host half is built by tsdown (`lib/index.js`, `lib/engine.js`). The
 * Client half is a plain-JavaScript dynamic Client module in the
 * `window.__ModuleLoader__` format the browser loader expects; it is not part
 * of the Node ESM build graph, so a copy is the simplest correct wiring and
 * needs no extra dependency.
 *
 * Runs after tsdown because tsdown cleans `lib/` before building.
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'client', 'main.js')
const target = join(root, 'lib', 'client.js')

await mkdir(dirname(target), { recursive: true })
await copyFile(source, target)
console.log(`client bundle: ${target}`)
