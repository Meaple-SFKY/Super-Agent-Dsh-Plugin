import { defineConfig } from 'tsdown'

// `@deepseek-ai/*` runtime peers resolve from the DSH installation and stay
// external. The one exception is schemastery: the guardian exports `Config` at
// module load, and the Loader reads it before any dynamic import. `alwaysBundle`
// opts only schemastery back into lib/index.js (its ESM build is
// self-contained), so the built entry still loads in a directory without
// `node_modules` — which is how the black-box guardian suite exercises the
// artifact a profile loads. Node built-ins stay external; runtime peers stay
// external for `engine.js`.
const neverBundle = (id: string): boolean => {
  if (/^node:/.test(id) || id === 'proper-lockfile') return true
  // schemastery and its pure-utility dependency stay in the bundle; both
  // ship self-contained ESM and are part of the guardian's load-time surface.
  if (/^@deepseek-ai\/(schemastery|cosmokit)(\/|$)/.test(id)) return false
  return /^@deepseek-ai\//.test(id)
}

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/engine.ts'],
    outDir: 'lib',
    format: 'esm',
    fixedExtension: false,
    platform: 'node',
    target: 'node22',
    dts: true,
    clean: true,
    deps: {
      neverBundle,
      alwaysBundle: [/^@deepseek-ai\/schemastery$/, /^@deepseek-ai\/cosmokit$/],
    },
  },
])
