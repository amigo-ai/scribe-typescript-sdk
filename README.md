# @amigo-ai/scribe

Framework-agnostic TypeScript SDK for the Amigo **Scribe** streaming service.

This first release ships the **CRUD REST client** for the session lifecycle:

- `createSession` — `POST /v1/{workspace_id}/sessions`
- `allocate` — `POST /v1/{workspace_id}/sessions/{session_id}/allocate` → `{ host, expires_at }`
- `getTranscript` — `GET /v1/{workspace_id}/sessions/{session_id}/transcript`

The browser-side WebSocket recorder (`ScribeRecorder` — PCM16 capture,
reconnect, keepalive) is **not** in this release; it is a later addition. The
package is browser-first (esbuild `platform: 'neutral'`, `lib` = `ES2022`+`DOM`,
no Node-only imports) but the REST client runs anywhere `fetch` exists.

> Scribe sessions follow **REST-create → REST-allocate → WS-attach**: create a
> session, allocate a streaming host, then attach a WebSocket to `host`. Only
> create + allocate + transcript are covered here.

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
npm run build     # esbuild dual CJS/ESM + tsc --emitDeclarationOnly (.d.ts)
npm run lint
npm test          # unit tests (mocked transport)
npm run test:e2e  # gated E2E — see tests/e2e/README.md (skips without creds)
```

Packaging mirrors [`amigo-typescript-sdk`](https://github.com/amigo-ai/amigo-typescript-sdk):
dual CJS/ESM via esbuild plus `tsc --emitDeclarationOnly` for types, exported
through the `exports` map (`types`/`import`/`require`).

## License

MIT
