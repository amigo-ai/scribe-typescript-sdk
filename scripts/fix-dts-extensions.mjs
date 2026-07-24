/**
 * Rewrite extensionless relative specifiers in the emitted `.d.ts` files to use
 * explicit `.js` extensions, as required by Node16/NodeNext ESM resolution.
 *
 * The package is ESM-only (`"type": "module"`). `tsc` emits declaration files
 * with extensionless relative imports (`from './client'`), which do NOT resolve
 * under Node's ESM resolver and make `@arethetypeswrong/core` (attw) report
 * `InternalResolutionError`. Under NodeNext, a `.js` specifier in a declaration
 * file resolves to the sibling `.d.ts`, so appending `.js` is the correct fix.
 *
 * This runs on the built `dist/types` tree only — it never touches `src/`, so
 * the authored source and the public type surface are unchanged. Each emitted
 * declaration mirrors a source file 1:1, so every relative specifier maps to a
 * sibling declaration; we append `.js` unless it already carries an extension.
 */
import fs from 'node:fs'
import path from 'node:path'

const TYPES_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'dist',
  'types'
)

// Matches `from '<spec>'`, `import('<spec>')`, and `export ... from '<spec>'`.
// Group 1: the `from ` / `import(` lead-in. Group 2: quote. Group 3: specifier.
const SPECIFIER_RE = /(from\s*|import\()\s*(['"])(\.\.?\/[^'"]*?)\2/g

function needsExtension(spec) {
  // Already has a known module extension → leave alone.
  return !/\.(js|mjs|cjs|json)$/.test(spec)
}

function rewrite(source) {
  return source.replace(SPECIFIER_RE, (match, lead, quote, spec) => {
    if (!needsExtension(spec)) return match
    return `${lead}${quote}${spec}.js${quote}`
  })
}

function walk(dir) {
  let changed = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      changed += walk(full)
    } else if (entry.name.endsWith('.d.ts')) {
      const original = fs.readFileSync(full, 'utf8')
      const next = rewrite(original)
      if (next !== original) {
        fs.writeFileSync(full, next)
        changed += 1
      }
    }
  }
  return changed
}

if (!fs.existsSync(TYPES_DIR)) {
  console.error(`fix-dts-extensions: ${TYPES_DIR} does not exist — run the build first.`)
  process.exit(1)
}

const changed = walk(TYPES_DIR)
console.log(`fix-dts-extensions: rewrote relative specifiers in ${changed} declaration file(s).`)
