# @amigo-ai/scribe-typescript-sdk

Framework-agnostic TypeScript SDK for the Amigo **Scribe** streaming service.

This release ships the **CRUD REST client** for the full session lifecycle and
its per-session artifacts:

Session lifecycle:

- `createSession` — `POST /v1/{workspace_id}/sessions`
- `allocate` — `POST /v1/{workspace_id}/sessions/{session_id}/allocate` → `{ host, expires_at }`
- `listSessions` — `GET /v1/{workspace_id}/sessions` (cursor-paginated: `limit`, `continuation_token`)
- `getSession` — `GET /v1/{workspace_id}/sessions/{session_id}`
- `updateSession` — `PATCH /v1/{workspace_id}/sessions/{session_id}` (mutate `external_appointment_id` / `metadata` / `mode`)
- `endSession` — `POST /v1/{workspace_id}/sessions/{session_id}/end` (guarded → `in-review`)
- `cancelSession` — `POST /v1/{workspace_id}/sessions/{session_id}/cancel` (guarded → `cancelled`)
- `getTranscript` — `GET /v1/{workspace_id}/sessions/{session_id}/transcript`

Appointments (read-only; each carries a nested `session` object):

- `listAppointments` — `GET /v1/{workspace_id}/appointments` (cursor-paginated: `limit`, `continuation_token`)
- `getAppointment` — `GET /v1/{workspace_id}/appointments/{appointment_id}`

Artifacts (note / summary / checklist / codes):

- `getNote` — `GET /v1/{workspace_id}/sessions/{session_id}/note`
- `generateNote` — `POST /v1/{workspace_id}/sessions/{session_id}/note` (pass a `note_type` `NoteTemplate`; `amd-*` templates emit the `StructuredNote` envelope, `structured` populated / `body` null)
- `putNote` — `PUT /v1/{workspace_id}/sessions/{session_id}/note` — versioned autosave; send the full `StructuredNote` envelope in `structured` + `base_version` (complete-document replacement). `body` is **deprecated**: a `body` write is rejected with `422 deprecated_field`. Stale `base_version` → `409 version_conflict`, post-finalize → `409 invalid_session_state`
- `finalizeNote` — `POST /v1/{workspace_id}/sessions/{session_id}/note/finalize` (missing required AMD/template field → `422 finalize_validation_failed`)
- `getSummary` — `GET /v1/{workspace_id}/sessions/{session_id}/summary`
- `generateSummary` — `POST /v1/{workspace_id}/sessions/{session_id}/summary`
- `getChecklist` — `GET /v1/{workspace_id}/sessions/{session_id}/checklist`
- `getCodes` — `GET /v1/{workspace_id}/sessions/{session_id}/codes`
- `generateCodes` — `POST /v1/{workspace_id}/sessions/{session_id}/codes`

Assist (in-visit + post-visit AI helpers):

- `getActions` — `GET /v1/{workspace_id}/sessions/{session_id}/actions` (reload-safe poller)
- `generateActions` — `POST /v1/{workspace_id}/sessions/{session_id}/actions` (async `202`/`200`; auto-enqueued when the note job succeeds)
- `regenerateSection` — `POST /v1/{workspace_id}/sessions/{session_id}/note/regenerate-section` (`{ section_id, instructions?, base_version }` → `202`; stale `base_version` → `409 version_conflict`, post-finalize → `409 invalid_session_state`)
- `autoCheckChecklist` — `POST /v1/{workspace_id}/sessions/{session_id}/checklist/auto-check` → `200 { matches }` (persists `source='auto'` state; coexists with manual toggles)
- `askSession` — `POST /v1/{workspace_id}/sessions/{session_id}/ask` — a header-authenticated **SSE** streaming Q&A helper (an async generator of `delta {text}` frames then a terminal `done {generation_id}`; not `EventSource`, not persisted as an artifact)

It also ships the **recording-independent streaming WebSocket API client**
(`ScribeStreamClient`) — the WS transport/protocol layer that attaches with a
short-lived **attach ticket**, streams **caller-supplied PCM16 bytes**, receives
transcript frames, and handles control frames, app-level keepalive, and
resumable reconnect. It has **no audio-capture code** (no `getUserMedia`,
`AudioContext`, or mic): a caller feeds it PCM16 via `sendAudio`.

The **browser recording layer** (`ScribeRecorder` + the `AudioCapture` pipeline)
drives the mic into that client — see [Browser recording](#browser-recording).
Plus the pure transcript core: the wire contract (`CLIENT_FRAME`,
`SERVER_MESSAGE`, `CLOSE_CODE`), `normalizeTurn`, the `transcriptReducer` (keyed
on the server-owned ordinal), and `buildWsUrl`.

The package is browser-first (esbuild `platform: 'neutral'`, `lib` = `ES2022`+`DOM`,
no Node-only imports) but the REST client runs anywhere `fetch` exists.

> Scribe sessions follow **REST-create → REST-allocate → WS-attach**: create a
> session, allocate a streaming host, then attach a WebSocket to `host`. After
> the session ends, read the transcript and the generated artifacts (note,
> summary, checklist, codes) via the REST client covered here.

For the **browser vs. server split-trust** model there are two higher-level
clients:

- **`ScribeServerClient`** (backend) — holds the M2M secret; mints per-clinician
  provider tokens (act-as-by-email), does create/allocate, and mints WS-only
  attach tickets. Exposes `allocate` and `mintAttachTicket` separately plus a
  `prepareConnection` helper. Server-side only.
- **`ScribeStreamClient`** (browser) — given a host + attach ticket, manages the
  WebSocket audio connection.

> **Integrating as an external customer?** See the end-to-end
> [customer integration guide](docs/customer-integration.md) — the split-trust
> model, copy-pasteable backend + browser examples, security, hosts, and
> troubleshooting.

## Install

```bash
npm i @amigo-ai/scribe-typescript-sdk
```

Requires Node.js ≥ 20 (or any modern browser / runtime with `fetch` +
`WebSocket`). The package is **ESM-only** — use `import`, not `require`.

## Usage

```ts
import { ScribeClient, ServiceUnavailableError } from '@amigo-ai/scribe-typescript-sdk'

const scribe = new ScribeClient({
  // Scribe API (CRUD) host — production. (Staging: https://scribe-staging.platform.amigo.ai)
  baseUrl: 'https://scribe.platform.amigo.ai',
  // A provider JWT carrying `scribe:sessions:write` (+ `scribe:sessions:read_own`
  // for transcripts). Pass a string, or a (possibly async) supplier to refresh
  // a short-lived token per request.
  token: async () => getFreshProviderJwt(),
  workspaceId: 'ws_123',
})

// 1. Create a session
const session = await scribe.createSession({
  external_id: 'appointment-42',
  metadata: { clinic: 'north' },
})

// 2. Allocate a streaming host
try {
  const { host, expires_at } = await scribe.allocate(session.id)
  // attach your WebSocket to `wss://${host}/agent/stream/connect?session_id=...`
} catch (err) {
  if (err instanceof ServiceUnavailableError) {
    // Fleet at capacity / cooldown — retry after err.retryAfterSeconds
  }
}

// 3. Read the persisted transcript (after the session is finalized)
const { segments } = await scribe.getTranscript(session.id)
```

### Server client (backend)

`ScribeServerClient` is the confidential, backend half: it holds the M2M
credentials and encapsulates the two mints + CRUD. **Never import it into a
browser bundle.**

```ts
import { ScribeServerClient } from '@amigo-ai/scribe-typescript-sdk'

const server = new ScribeServerClient({
  identityBaseUrl: 'https://api.platform.amigo.ai', // identity /token (mints)
  scribeBaseUrl: 'https://scribe.platform.amigo.ai', // Scribe CRUD
  workspaceId: 'ws_123',
  clientId: process.env.AMIGO_M2M_CLIENT_ID!,
  clientSecret: process.env.AMIGO_M2M_CLIENT_SECRET!, // server-side only
})

// `clinicianEmail` comes from YOUR authenticated app session (never the browser).
const session = await server.createSession(clinicianEmail, { external_id: 'appointment-42' })

// Encapsulating helper: one allocate + one ticket mint → the browser-safe bundle.
const { host, ticket } = await server.prepareConnection(clinicianEmail, session.id)

// ...or the pieces separately:
const allocation = await server.allocate(clinicianEmail, session.id) // { host, expiresAt }
const attach = await server.mintAttachTicket(clinicianEmail, session.id) // { ticket, expiresAt }

// Reads (transcript / note / summary / checklist / codes) as the clinician:
const { segments } = await server.scribe(clinicianEmail).getTranscript(session.id)
```

A `400` `invalid_target` (`BadRequestError` with `errorCode === 'invalid_target'`)
means the clinician has no active Scribe grant in the workspace.

### Streaming WebSocket client (browser)

`ScribeStreamClient` owns the worker WebSocket: it attaches with an **attach
ticket**, streams caller-supplied PCM16, and handles keepalive + resumable
reconnect. Auth is a purpose-built, WS-only attach ticket (aud `scribe-streaming`,
scope `scribe:streams:connect`, ~5-min TTL) — **not** a raw provider JWT. The SDK
never holds a provider credential or mints tickets; it resolves a host + ticket
from your backend via one of three seams (re-invoked on every reconnect):

```ts
import { ScribeStreamClient } from '@amigo-ai/scribe-typescript-sdk'

const client = new ScribeStreamClient({
  sessionId: session.id,
  // PREFERRED: one call to your backend route returning { host, ticket }
  // (backed by ScribeServerClient.prepareConnection).
  connectionProvider: async sessionId => fetchConnectionFromYourBackend(sessionId),
  onTurn: segment => render(segment), // normalized SttTranscriptSegment (server ordinal)
  onStateChange: state => console.log(state),
  onReconnect: () => console.log('resumed'),
  onError: err => console.error(err),
})

await client.connect() // resolve host + ticket → open WS
client.sendAudio(pcm16) // ArrayBuffer | Uint8Array — you own capture
client.pause()
client.resume()
client.end() // finalize + clean close (1000)
```

Instead of `connectionProvider` you can pass the split `allocateProvider` +
`ticketProvider` seams, or static `host` + `ticket` for a one-shot (not
reconnect-safe) connection.

Reconnect is automatic on `1012` / `1006` (never on `1000` / `4009` / `4001`):
the client re-resolves a fresh host + ticket, reconnects the same session, sends
`resume_from{acked_offset_bytes}`, and resends only the unacked ring-buffer
audio. Pair `normalizeTurn` + `transcriptReducer` (or your own store) to render
by the server-owned ordinal.

### Browser recording

`ScribeRecorder` is the browser-facing surface: it owns the Web Audio /
`getUserMedia` PCM16 capture pipeline and drives a `ScribeStreamClient` for you.
It adds **no** wire-protocol logic — reconnect, ring buffer, keepalive, and
attach-ticket auth all live in `ScribeStreamClient`; the attach-ticket seams are
passed straight through. `start()` connects + opens the mic and pipes each PCM16
chunk to `sendAudio`; `pause`/`resume`/`end` drive both capture and the client.
Browser-only (needs `getUserMedia`/`AudioContext`).

```ts
import { ScribeRecorder } from '@amigo-ai/scribe'

const recorder = new ScribeRecorder({
  sessionId: session.id,
  ticketProvider: async sessionId => ({ ticket: await mintAttachTicket(sessionId) }),
  allocateProvider: async sessionId => allocateHost(sessionId), // → { host, expiresAt }
  audioCaptureMode: 'mic', // or 'mic+system' (adds tab/window audio via getDisplayMedia)
  onTurn: segment => render(segment),
  onStateChange: ({ state, streamState, micPermission, capturing }) => update(state),
  onReconnect: () => console.log('resumed'),
  onError: err => console.error(err),
})

await recorder.start() // connect + open mic; pipes PCM16 → client.sendAudio
recorder.pause() // stops the mic; the WS stays open
await recorder.resume() // re-opens the mic
recorder.end() // stop the mic + finalize + clean close
```

On reconnect the mic keeps running — the client re-allocates, re-mints a ticket,
and resends unacked audio while the recorder keeps feeding new chunks. The
recorder state matrix is `idle → recording ⇄ paused → ended` (plus `failed`,
e.g. the mic-permission-denied path, which also surfaces via `onError`).
Lower-level building blocks are exported too: `floatToPcm16`, `STT_SAMPLE_RATE`,
`AudioCapture`, and the `captureStreamsForMode` / `createPcmCapturePipeline` /
`stopCapturedStreams` helpers.

### Configuration

| Option           | Type                                        | Notes                                                    |
| ---------------- | ------------------------------------------- | -------------------------------------------------------- |
| `baseUrl`        | `string`                                    | Base URL of the Scribe/platform API.                     |
| `token`          | `string \| () => string \| Promise<string>` | Bearer token or supplier. Needs `scribe:sessions:write`. |
| `workspaceId`    | `string`                                    | Scopes every request; can be overridden per call.        |
| `fetch`          | `FetchLike?`                                | Injectable transport (defaults to global `fetch`).       |
| `defaultHeaders` | `Record<string,string>?`                    | Extra headers merged into every request.                 |

### Errors

Non-2xx responses throw typed errors (all extend `ScribeError`):
`BadRequestError` (400), `AuthenticationError` (401), `PermissionError` (403),
`NotFoundError` (404), `ConflictError` (409), `ValidationError` (422),
`RateLimitError` (429), `ServerError` (500), `ServiceUnavailableError` (503,
with `retryAfterSeconds`). Transport failures throw `NetworkError`.

Machine-readable domain error codes are surfaced on `ScribeError.errorCode`.
Structured-note codes: `version_conflict` / `invalid_session_state` (409),
`deprecated_field` (a `body` write on the deprecated compatibility field),
`unsupported_note_template` (unknown/mismatched pinned template),
`note_template_required` (session create/patch with no resolvable `visit_type`),
`validation_error` (structured document failed template validation, per-field
`details`), and `finalize_validation_failed` (finalize with a required
AMD/template field missing) — all `422`. Async structured generation that fails
validation after a bounded repair leaves the note `generation_status === 'failed'`
with an `error` (`ErrorDetail`) describing the `structured_generation_invalid`
failure.

## Development

```bash
npm install
npm run openapi:sync     # refresh openapi/scribe.json from production (network)
npm run generate:schema  # regenerate src/generated/openapi.ts from openapi/scribe.json
npm run build            # esbuild (ESM) + tsc (.d.ts) + NodeNext .js-extension fixup
npm run lint
npm test                 # unit tests (mocked transport)
npm run test:e2e         # gated E2E — see tests/e2e/README.md (skips without creds)
npm run validate         # publint + attw + npm pack --dry-run (pre-publish checks)
```

**Packaging.** The SDK is **ESM-only** (`"type": "module"`): a single ESM entry
point (`dist/index.mjs`) built with esbuild plus `tsc` for the `.d.ts` types,
exported through the `exports` map (`types`/`import`). There is no CommonJS build.
`tsc` emits declarations with extensionless relative imports, which Node's
NodeNext ESM resolver rejects; `scripts/fix-dts-extensions.mjs` rewrites those to
explicit `.js` specifiers post-build so `@arethetypeswrong/cli` (attw) resolves
the types cleanly. Validate with `npm run validate` (publint + attw + `npm pack
--dry-run`).

**Wire types.** The REST wire types in `src/types.ts` are derived from the Scribe
service's **production OpenAPI document**
(`https://scribe.platform.amigo.ai/v1/openapi.json`, vendored at
`openapi/scribe.json`) via [`openapi-typescript`](https://github.com/openapi-ts/openapi-typescript).
To refresh types after the API schema changes:

```bash
npm run openapi:sync     # re-fetch the spec into openapi/scribe.json
npm run generate:schema  # regenerate src/generated/openapi.ts from that snapshot
```

Both `openapi/scribe.json` and the generated `src/generated/openapi.ts` are
committed so the build needs no network. CI runs `generate:schema` and fails the
PR if `src/generated/openapi.ts` is out of sync with the vendored spec (the
"Verify generated API types are committed" step). `openapi:sync` accepts
`--url <https url>` or `--spec <local file>` overrides; the default source is the
production URL. The generated module is types-only — nothing is added to the
runtime bundle.

## Versioning & releases

The SDK follows [semver](https://semver.org). It is published to npm as
[`@amigo-ai/scribe-typescript-sdk`](https://www.npmjs.com/package/@amigo-ai/scribe-typescript-sdk) with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements).

Releases are automated directly by `.github/workflows/release.yml`, without a
third-party release action:

1. Merge source-code changes under `src/` to `main` using
   [Conventional Commit](https://www.conventionalcommits.org/) titles. `fix:`
   produces a patch release, `feat:` a minor release, and a breaking-change
   marker (`feat!:` or a `BREAKING CHANGE:` footer) a major release. Do not
   change the `package.json` version in a source PR; CI enforces that the
   release workflow remains the sole owner of version bumps.
2. The workflow examines commit subjects and bodies since the latest `vX.Y.Z`
   tag, calculates the next version, and creates a tag-only commit containing
   the corresponding `package.json` / `package-lock.json` version bump. Changes
   outside `src/` do not trigger the automated release flow.
3. The workflow pushes the annotated tag and creates a GitHub Release whose
   generated notes cover the commits since the previous release tag. It then
   re-validates the package
   (`build → typecheck → test → publint + attw + npm pack`) and runs
   `npm publish --provenance --access public` automatically.

The workflow can still be dispatched manually from a `vX.Y.Z` tag as a recovery
path. The tag must match the version in `package.json`.

Publishing uses **npm [trusted publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC)** — there is no npm token. The workflow authenticates with its
`id-token: write` OIDC token, which also produces the provenance attestation.

Before the first publish can succeed, two one-time setup steps are required (no
repo secrets):

- **Configure a trusted publisher** for `@amigo-ai/scribe-typescript-sdk` on npmjs.com
  (Package → Settings → Trusted Publisher) pointing at this repository
  (`amigo-ai/scribe-typescript-sdk`) and workflow (`.github/workflows/release.yml`).
  This is the account/ops action that replaces provisioning a token.
- The repository must be **public** for OIDC trusted publishing + provenance.

Pre-publish validation can be run locally at any time:

```bash
npm run build
npm run validate   # publint + attw (are-the-types-wrong) + npm pack --dry-run
```

## License

MIT
