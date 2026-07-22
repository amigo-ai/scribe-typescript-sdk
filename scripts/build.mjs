import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

await rm('dist', { recursive: true, force: true })

const shared = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'neutral', // browser-first, framework-agnostic — no node built-ins
  target: 'es2020',
  minify: false,
  sourcemap: true,
}

// ESM-only build — the package is `"type": "module"` and ships a single ESM
// entry point (no CommonJS output).
await build({
  ...shared,
  outfile: 'dist/index.mjs',
  format: 'esm',
})

console.log('✨ Esbuild complete (ESM)')
