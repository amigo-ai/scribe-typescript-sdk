# E2E tests

These suites exercise the SDK against a **real** Scribe stack (staging,
workspace `f001e5c8`), driven through the shipped clients (`ScribeServerClient` =
backend, `ScribeClient` = CRUD reads/writes, `ScribeStreamClient` = browser).
Shared setup (env gating, `ScribeServerClient` factory, JWT decode, counting
fetch, id helpers) lives in `harness.ts`.

1. **`scribe-resource-api.e2e.test.ts`** — full coverage of **every exposed
   `ScribeClient` resource method**, happy + sad: create / get / list (+
   pagination + `continuation_token`) sessions, allocate (+ cooldown `503 +
Retry-After`), get-transcript, and the artifact read/generate/finalize
   methods (note, summary, checklist, codes), plus auth (401), not-found (404),
   and cross-workspace sad paths.
2. **`scribe-server-client.e2e.test.ts`** — the `ScribeServerClient` backend/M2M
   surface: `mintProviderToken` (act-as-by-email; per-email cache via a counting
   fetch; `invalid_target`; email normalisation), `clearTokenCache`, `scribe()`,
   `createSession`, `allocate`, `mintAttachTicket` (`token_exchange`;
   `aud`/`scope`/TTL correctness), and `prepareConnection`.
3. **`scribe-streaming.e2e.test.ts`** — the full in-person path through the SDK
   (`ScribeServerClient.prepareConnection` → `ScribeStreamClient.connect()` →
   synthetic PCM16 → acks/pong → `end()`). **Phase 15**; the WS streaming/audio
   round-trip is NOT duplicated by the resource-API suites.

All **run in CI** on pushes to `main` and same-repo PRs (see
`.github/workflows/ci.yml` `e2e` job). All are **gated**: they self-skip when
their env vars are absent, so they are safe to run locally and fork PRs (no
secrets) skip cleanly.

## Coverage NOT automated in CI (manual)

The CI provider-M2M grant has a **fixed scope set** (`sessions:write` +
`sessions:read_own` + `notes:rw_own`), so two sad paths cannot be produced from
CI and are validated manually with a purpose-scoped grant (see the `it.todo`
markers in `scribe-resource-api.e2e.test.ts`):

- **403 missing-scope read** — needs a token minted WITHOUT `read_own`.
- **`invalid_scope` mint** — needs a scope-restricted grant; the SDK exposes no
  per-call scope override.

Cross-provider ownership (`read_own` denying another provider's session) is
covered indirectly: `read_own` returns **404** for both a missing session and
another provider's session, asserted by the not-found cases.

## Zero-residue / test-data discipline

- **Staging only**, workspace `f001e5c8`. Production untouched.
- Every session is created with an `sdk-e2e-*` external id and is **never
  streamed**, so it stays "dangling" and is auto-reaped by the phase-06 reaper.
- **No grants and no M2M clients are created** — the suites reuse the
  pre-provisioned persistent CI provider grant. `invalid_target` is driven with
  a throwaway `sdk-e2e-nogrant-*@example.com` (no grant, no side effect).
- There is **no session-delete endpoint** (filed as an SDK/API follow-up), so
  teardown records + logs the created ids rather than deleting them; residue
  self-clears via the reaper.

## Run locally

Create a `.env` at the repo root (git-ignored):

```dotenv
SCRIBE_E2E_BASE_URL=https://scribe-staging.platform.amigo.ai
SCRIBE_E2E_IDENTITY_BASE_URL=https://api-staging.platform.amigo.ai
SCRIBE_E2E_WORKSPACE_ID=<workspace id of the provider-M2M client>
SCRIBE_E2E_PROVIDER_EMAIL=<a provider WITH an active grant in that workspace>
SCRIBE_M2M_CLIENT_ID=<provider-M2M client id>
SCRIBE_M2M_CLIENT_SECRET=<provider-M2M client secret>
# optional explicit opt-out: SCRIBE_E2E_ENABLED=false
```

Then:

```bash
npm run test:e2e
```

Each suite prints a skip notice and passes with no assertions when its vars are
absent.

## Notes

- `allocate` may legitimately return `503` if the streaming Fleet is exhausted
  or in per-session cooldown; the suites tolerate the exhaustion case and assert
  the cooldown case (`503 + Retry-After`).
- Artifact reads (`getTranscript/getNote/getSummary/getChecklist/getCodes`) on a
  fresh, never-streamed session return `404` (not yet generated); the suites
  assert that documented path and assert the full shape if the artifact is
  present. `generate*` on a session with no transcript returns a typed 4xx or a
  generated artifact — both are asserted.
- A `400 invalid_target` on a mint (`BadRequestError`, `errorCode ===
'invalid_target'`) means the email has no **active grant** — a fixture problem;
  `beforeAll` fails loudly with that guidance for the configured provider.

## CI

Both jobs run in CI (`.github/workflows/ci.yml`) on pushes to `main` and
same-repo PRs. Config is split by sensitivity:

- **Repository variables** (non-sensitive): `SCRIBE_E2E_BASE_URL`,
  `SCRIBE_E2E_IDENTITY_BASE_URL`.
- **Repository secrets**: `SCRIBE_E2E_WORKSPACE_ID`, `SCRIBE_E2E_PROVIDER_EMAIL`,
  `SCRIBE_M2M_CLIENT_ID`, `SCRIBE_M2M_CLIENT_SECRET`.

Fork PRs skip the job (secrets/vars withheld). The M2M `client_secret` is stored
only as a GitHub Actions secret — never committed or logged.
