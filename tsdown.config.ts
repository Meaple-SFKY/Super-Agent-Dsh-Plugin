import { defineConfig } from 'tsdown'

const neverBundle = [/^@deepseek-ai\//, /^node:/, 'proper-lockfile']

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
    deps: { neverBundle },
  },
])
