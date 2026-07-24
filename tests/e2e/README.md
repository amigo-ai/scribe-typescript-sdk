# E2E tests

Two suites exercise the SDK against a **real** Scribe stack, driven through the
shipped clients (`ScribeServerClient` = backend, `ScribeStreamClient` = browser):

1. **`scribe-crud.e2e.test.ts`** — CRUD client (create-session → allocate →
   get-transcript). Uses a static provider JWT (`SCRIBE_E2E_TOKEN`) if set,
   otherwise `ScribeServerClient` mints a per-clinician token via the provider-M2M
   grant (same secrets as suite 2) and hands back a bound `ScribeClient`, so it
   **runs in CI** too.
2. **`scribe-streaming.e2e.test.ts`** — the full in-person path through the SDK:
   `ScribeServerClient.mintProviderToken` (act-as-by-email) →
   `server.createSession` → `server.prepareConnection` (allocate + `token_exchange`
   attach ticket) wired into the browser client's `connectionProvider` seam →
   `ScribeStreamClient.connect()`, stream **synthetic PCM16** (headless CI has no
   mic), observe acks/pong, then `end()`.

Both **run in CI** on pushes to `main` and same-repo PRs (see
`.github/workflows/ci.yml` `e2e` job).

Both are **gated**: they self-skip when their env vars are absent, so they are
safe to run locally and fork PRs (no secrets) skip cleanly.

## Run locally

Create a `.env` file at the repo root (git-ignored). For the **CRUD** suite:

```dotenv
SCRIBE_E2E_BASE_URL=https://<scribe-api-host>
SCRIBE_E2E_TOKEN=<provider JWT with scribe:sessions:write + scribe:sessions:read_own>
SCRIBE_E2E_WORKSPACE_ID=<workspace id matching the token claim>
# optional explicit opt-out: SCRIBE_E2E_ENABLED=false
```

For the **streaming** suite (mints its own per-clinician token; no static JWT):

```dotenv
SCRIBE_E2E_BASE_URL=https://<scribe-crud-host>
SCRIBE_E2E_IDENTITY_BASE_URL=https://<identity-/token-host>
SCRIBE_E2E_WORKSPACE_ID=<workspace id of the provider-M2M client>
SCRIBE_E2E_PROVIDER_EMAIL=<a provider WITH an active grant in that workspace>
SCRIBE_M2M_CLIENT_ID=<provider-M2M client id>
SCRIBE_M2M_CLIENT_SECRET=<provider-M2M client secret>
```

Then:

```bash
npm run test:e2e
```

Each suite prints a skip notice and passes with no assertions when its vars are
absent.

## Notes

- `allocate` may legitimately return `503` if the streaming Fleet is exhausted
  or not yet provisioned; both suites tolerate that (the streaming suite skips
  the WS leg after proving the M2M + CRUD path).
- `get-transcript` on a just-created session returns `404` (transcript not yet
  available); the CRUD suite tolerates that too.
- The streaming suite feeds a generated PCM16 tone; transcript frames from a
  pure tone are best-effort — the hard assertions are attach + acks + pong.
- A `400 invalid_target` on the M2M mint (`BadRequestError` with
  `errorCode === 'invalid_target'`) means the `SCRIBE_E2E_PROVIDER_EMAIL` has no
  **active grant** in the workspace — a fixture problem, not a code bug; the
  streaming suite fails loudly with that guidance.

## CI

Both suites run in CI (`.github/workflows/ci.yml` `e2e` job) on pushes to `main`
and same-repo PRs. Config is split by sensitivity:

- **Repository variables** (non-sensitive): `SCRIBE_E2E_BASE_URL`,
  `SCRIBE_E2E_IDENTITY_BASE_URL`.
- **Repository secrets**: `SCRIBE_E2E_WORKSPACE_ID`, `SCRIBE_E2E_PROVIDER_EMAIL`,
  `SCRIBE_M2M_CLIENT_ID`, `SCRIBE_M2M_CLIENT_SECRET`.

Fork PRs skip the job (secrets/vars withheld). The M2M `client_secret` is stored
only as a GitHub Actions secret — never committed or logged.
