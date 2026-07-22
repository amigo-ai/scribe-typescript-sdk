/**
 * Refresh the vendored OpenAPI snapshot at `openapi/scribe.json`.
 *
 * Source of truth (in priority order):
 *   1. Explicit --spec path/to/spec.json within this repo (local file)
 *   2. Explicit --url https://... (alternate HTTPS source)
 *   3. Default: the Scribe service's production OpenAPI document
 *      https://scribe.platform.amigo.ai/v1/openapi.json
 *
 * Unlike `amigo-platform-typescript-sdk` (which prefers a local `../platform`
 * sibling checkout), the Scribe SDK has no sibling repo, so the default source
 * is the live production URL. After syncing, run `npm run generate:schema` to
 * regenerate `src/generated/openapi.ts` from the refreshed snapshot.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const OUT_FILE = path.resolve(REPO_ROOT, 'openapi/scribe.json')
const DEFAULT_SPEC_URL = 'https://scribe.platform.amigo.ai/v1/openapi.json'

const args = process.argv.slice(2)

function getArgValue(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function assertValidOpenApi(document, source) {
  if (
    !document ||
    typeof document !== 'object' ||
    typeof document.openapi !== 'string' ||
    typeof document.paths !== 'object'
  ) {
    throw new Error(`Invalid OpenAPI document from: ${source}`)
  }
  return document
}

async function loadFromUrl(url) {
  if (!/^https:\/\//.test(url)) {
    throw new Error(`Spec URL must be an HTTPS URL: ${url}`)
  }
  console.log(`Fetching OpenAPI spec from: ${url}`)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch spec (${response.status} ${response.statusText}): ${url}`)
  }
  return assertValidOpenApi(await response.json(), url)
}

function loadFromFile(file) {
  const resolved = path.resolve(REPO_ROOT, file)
  const relative = path.relative(REPO_ROOT, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`--spec must point to a file within this repo: ${file}`)
  }
  console.log(`Reading OpenAPI spec from file: ${resolved}`)
  return assertValidOpenApi(JSON.parse(fs.readFileSync(resolved, 'utf-8')), resolved)
}

const specArg = getArgValue('--spec')
const urlArg = getArgValue('--url')
const document = specArg ? loadFromFile(specArg) : await loadFromUrl(urlArg ?? DEFAULT_SPEC_URL)

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
fs.writeFileSync(OUT_FILE, `${JSON.stringify(document, null, 2)}\n`)

const pathCount = Object.keys(document.paths ?? {}).length
const schemaCount = Object.keys(document.components?.schemas ?? {}).length
console.log(`Wrote ${OUT_FILE}: ${pathCount} paths, ${schemaCount} schemas`)
