# E2E tests

These tests exercise the CRUD client (create-session → allocate → get-transcript)
against a **real** Scribe endpoint. They are **gated** so they only run when
credentials are present, which means:

- They are safe to run locally.
- They **do not run in CI** — the CI `e2e` job is intentionally disabled
  (`.github/workflows/ci.yml`), and the tests self-skip when the env vars are
  absent even if invoked.

## Run locally

1. Create a `.env` file at the repo root (git-ignored) with:

   ```dotenv
   SCRIBE_E2E_BASE_URL=https://<scribe-api-host>
   SCRIBE_E2E_TOKEN=<provider JWT with scribe:sessions:write + scribe:sessions:read_own>
   SCRIBE_E2E_WORKSPACE_ID=<workspace id matching the token claim>
   # optional explicit opt-out: SCRIBE_E2E_ENABLED=false
   ```

2. Run:

   ```bash
   npm run test:e2e
   ```

Without those three vars, the suite prints a skip notice and passes with no
assertions.

## Notes

- `allocate` may legitimately return `503` if the streaming Fleet is exhausted
  or not yet provisioned; the test tolerates that (logs the `Retry-After`).
- `get-transcript` on a just-created session returns `404` (transcript not yet
  available); the test tolerates that too.

## Follow-up: promote to CI

Tracked follow-up (see `.github/workflows/ci.yml` `e2e` job comment): once a
stable staging Scribe endpoint and a scoped service token exist, provision repo
secrets `SCRIBE_E2E_BASE_URL` / `SCRIBE_E2E_TOKEN` / `SCRIBE_E2E_WORKSPACE_ID`,
flip the `e2e` job's `if:` guard, and pass those secrets as env.
