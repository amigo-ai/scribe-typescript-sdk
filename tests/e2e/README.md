# E2E tests

Two suites exercise the SDK against a **real** Scribe stack:

1. **`scribe-crud.e2e.test.ts`** — CRUD client (create-session → allocate →
   get-transcript) with a static provider JWT (`SCRIBE_E2E_TOKEN`). Local-only.
2. **`scribe-streaming.e2e.test.ts`** — the full **superscribe-web in-person
   path** through the SDK: mint a per-clinician provider token via the
   provider-M2M `client_credentials` + `provider_email` (act-as-by-email) grant →
   `createSession` → `allocate` → mint a `token_exchange` attach ticket → open
   the WebSocket, stream **synthetic PCM16** (headless CI has no mic), observe
   acks/pong, then `end()`. This suite **runs in CI** on pushes to `main` and
   same-repo PRs (see `.github/workflows/ci.yml` `e2e` job).

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
- A `400 invalid_target` on the M2M mint means the `SCRIBE_E2E_PROVIDER_EMAIL`
  has no **active (non-MFA) grant** in the workspace — a fixture problem, not a
  code bug; the suite fails loudly with that guidance.

## CI

The streaming suite runs in CI (`.github/workflows/ci.yml` `e2e` job) on pushes
to `main` and same-repo PRs, using repo secrets `SCRIBE_E2E_BASE_URL`,
`SCRIBE_E2E_IDENTITY_BASE_URL`, `SCRIBE_E2E_WORKSPACE_ID`,
`SCRIBE_E2E_PROVIDER_EMAIL`, `SCRIBE_M2M_CLIENT_ID`, `SCRIBE_M2M_CLIENT_SECRET`.
Fork PRs (no secrets) skip the job. The M2M `client_secret` is stored only as a
GitHub Actions secret — never committed or logged.
