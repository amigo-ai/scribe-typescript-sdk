# @amigo-ai/scribe

Framework-agnostic TypeScript SDK for the Amigo **Scribe** streaming service.

This release ships the **CRUD REST client** for the full session lifecycle and
its per-session artifacts:

Session lifecycle:

- `createSession` — `POST /v1/{workspace_id}/sessions`
- `allocate` — `POST /v1/{workspace_id}/sessions/{session_id}/allocate` → `{ host, expires_at }`
- `listSessions` — `GET /v1/{workspace_id}/sessions` (cursor-paginated: `limit`, `continuation_token`)
- `getSession` — `GET /v1/{workspace_id}/sessions/{session_id}`
- `getTranscript` — `GET /v1/{workspace_id}/sessions/{session_id}/transcript`

Artifacts (note / summary / checklist / codes):

- `getNote` — `GET /v1/{workspace_id}/sessions/{session_id}/note`
- `generateNote` — `POST /v1/{workspace_id}/sessions/{session_id}/note`
- `finalizeNote` — `POST /v1/{workspace_id}/sessions/{session_id}/note/finalize`
- `getSummary` — `GET /v1/{workspace_id}/sessions/{session_id}/summary`
- `generateSummary` — `POST /v1/{workspace_id}/sessions/{session_id}/summary`
- `getChecklist` — `GET /v1/{workspace_id}/sessions/{session_id}/checklist`
- `generateChecklist` — `POST /v1/{workspace_id}/sessions/{session_id}/checklist`
- `getCodes` — `GET /v1/{workspace_id}/sessions/{session_id}/codes`

The browser-side WebSocket recorder (`ScribeRecorder` — PCM16 capture,
reconnect, keepalive) is **not** in this release; it is a later addition. The
package is browser-first (esbuild `platform: 'neutral'`, `lib` = `ES2022`+`DOM`,
no Node-only imports) but the REST client runs anywhere `fetch` exists.

> Scribe sessions follow **REST-create → REST-allocate → WS-attach**: create a
> session, allocate a streaming host, then attach a WebSocket to `host`. After
> the session ends, read the transcript and the generated artifacts (note,
> summary, checklist, codes) via the REST client covered here.

## Install

```bash
npm install @amigo-ai/scribe
```

> Not yet published to npm — the first publish is a later phase of the
> scribe-streaming rollout.

## Usage

```ts
import { ScribeClient, ServiceUnavailableError } from '@amigo-ai/scribe'

const scribe = new ScribeClient({
  baseUrl: 'https://api.amigo.ai',
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

## Development

```bash
npm install
npm run openapi:sync     # refresh openapi/scribe.json from production (network)
npm run generate:schema  # regenerate src/generated/openapi.ts from openapi/scribe.json
npm run build            # esbuild (ESM) + tsc --emitDeclarationOnly (.d.ts)
npm run lint
npm test                 # unit tests (mocked transport)
npm run test:e2e         # gated E2E — see tests/e2e/README.md (skips without creds)
```

**Packaging.** The SDK is **ESM-only** (`"type": "module"`): a single ESM entry
point (`dist/index.mjs`) built with esbuild plus `tsc --emitDeclarationOnly` for
the `.d.ts` types, exported through the `exports` map (`types`/`import`). There is
no CommonJS build.

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

## License

MIT
