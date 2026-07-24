/**
 * Are-the-types-wrong (attw) validation for the packed tarball.
 *
 * Why this wrapper instead of the `attw` CLI: the published CLI decompresses the
 * tarball with fflate's *streaming* Gunzip and only keeps the last emitted chunk
 * (https://github.com/arethetypeswrong/arethetypeswrong.github.io — fflate #207).
 * For tarballs whose inflated size crosses fflate's internal chunk boundary
 * (this package does), that drops all but the final chunk and the CLI dies with
 * `Cannot read properties of undefined (reading 'filename')` on ANY package.
 * We decompress with Node's reliable `zlib.gunzipSync`, then drive
 * `@arethetypeswrong/core` directly with the same "esm-only" profile the CLI
 * would use (ignore the node10 + node16-cjs resolutions — this package is
 * ESM-only, `"type": "module"`, no CJS entry).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { checkPackage, Package } from '@arethetypeswrong/core'
import { untar } from '@andrewbranch/untar.js'

// esm-only profile: these resolution kinds are irrelevant for an ESM-only pkg.
const IGNORE_RESOLUTIONS = new Set(['node10', 'node16-cjs'])

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

function getTarball() {
  const arg = process.argv[2]
  if (arg) return path.resolve(arg)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-attw-'))
  const out = execFileSync('npm', ['pack', '--json', '--pack-destination', tmpDir], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const info = JSON.parse(out)
  return path.join(tmpDir, info[0].filename)
}

function loadPackage(tarballPath) {
  const gz = fs.readFileSync(tarballPath)
  const tar = zlib.gunzipSync(gz) // reliable, unlike fflate streaming Gunzip
  const entries = untar(new Uint8Array(tar.buffer, tar.byteOffset, tar.byteLength))
  if (!entries.length) throw new Error('empty tarball after decompression')
  const prefix = entries[0].filename.substring(0, entries[0].filename.indexOf('/') + 1)
  const pkgJsonEntry = entries.find(e => e.filename === `${prefix}package.json`)
  const pkgJson = JSON.parse(new TextDecoder().decode(pkgJsonEntry.fileData))
  const files = {}
  for (const e of entries) {
    files[`/node_modules/${pkgJson.name}/${e.filename.substring(prefix.length)}`] = e.fileData
  }
  return new Package(files, pkgJson.name, pkgJson.version)
}

const tarballPath = getTarball()
const pkg = loadPackage(tarballPath)
const result = await checkPackage(pkg)

console.log(`attw: ${result.packageName}@${result.packageVersion}`)
if (!result.types) {
  console.error('attw: FAIL — package ships no type declarations')
  process.exit(1)
}
console.log(`attw: types = ${result.types.kind}`)

const problems = (result.problems ?? []).filter(p => !IGNORE_RESOLUTIONS.has(p.resolutionKind))

if (problems.length === 0) {
  console.log('attw: No problems found (esm-only profile). 🎉')
  process.exit(0)
}

console.error(`attw: ${problems.length} problem(s) found (esm-only profile):`)
for (const p of problems) {
  console.error(
    `  - ${p.kind}${p.resolutionKind ? ` [${p.resolutionKind}]` : ''}${
      p.entrypoint ? ` @ ${p.entrypoint}` : ''
    }`
  )
}
process.exit(1)
