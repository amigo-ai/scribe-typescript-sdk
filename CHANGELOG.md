# Changelog

All notable changes to `@concurrence-hq/scribe-typescript-sdk` (published as
`@amigo-ai/scribe-typescript-sdk` through `0.15.1`) are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.16.0]

### Changed

- The package is now published as `@concurrence-hq/scribe-typescript-sdk`.
  `@amigo-ai/scribe-typescript-sdk` is deprecated and receives no further
  releases; existing installs keep working at their pinned versions. To migrate,
  run `npm uninstall @amigo-ai/scribe-typescript-sdk && npm i @concurrence-hq/scribe-typescript-sdk`
  and replace `'@amigo-ai/scribe-typescript-sdk'` with
  `'@concurrence-hq/scribe-typescript-sdk'` in imports. No API changes.

## [0.14.0]

### Removed

- `UpdateNoteRequest` (the `putNote` request body) no longer has the deprecated
  optional `body` field, matching the Scribe API. The server already rejected a
  `body` write with `422 deprecated_field`, so no working caller sent it; the
  `putNote` docs no longer mention `deprecated_field`. Compile-time only — send
  `{ base_version, structured }` as before. `NoteReadResponse.body` (the read
  side) is unchanged.

## [0.13.0]

### Added

- `listSessions` now accepts and forwards the optional `created_after` (inclusive)
  and `created_before` (exclusive) ISO date-time filters to
  `GET /v1/{workspace_id}/sessions`, forming a half-open created-at window
  `[created_after, created_before)`. Either bound may be given alone; omitting
  both preserves the previous behavior. Additive and backward compatible.
