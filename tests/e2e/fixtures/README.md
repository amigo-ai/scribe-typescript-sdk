# E2E audio fixtures

## `speech-16k-mono-s16le.pcm`

Real, intelligible **speech** in the exact PCM format the Scribe streaming path
expects — **raw PCM16, 16 kHz, mono, little-endian, headerless** (matches
`harness.ts` `synthPcm16`: `sampleRate = 16000`, `Int16` LE; the stream sends
100 ms / 3200-byte frames).

Used by `scribe-post-visit-mutations.e2e.test.ts` so staging speech-to-text
produces a **non-empty transcript** — a synthetic sine tone transcribes to
nothing, which makes `generateNote` return `409 "Transcript is empty"` and blocks
the note-mutation flow.

Spoken content (a short clinical utterance):

> "Patient reports intermittent headaches for the past two weeks, worse in the
> morning, with no fever or vision changes. Denies nausea and dizziness. Blood
> pressure today is one twenty over eighty."

### Regenerate (macOS)

```sh
say -o /tmp/spk.aiff "Patient reports intermittent headaches for the past two weeks, worse in the morning, with no fever or vision changes. Denies nausea and dizziness. Blood pressure today is one twenty over eighty."
ffmpeg -y -i /tmp/spk.aiff -ar 16000 -ac 1 -f s16le tests/e2e/fixtures/speech-16k-mono-s16le.pcm
```

`-ar 16000` (sample rate) · `-ac 1` (mono) · `-f s16le` (signed 16-bit
little-endian raw PCM). The file is test-only and is **not** shipped in the npm
package (`package.json` `files` ships only `dist/`, `docs/`, `README`, `LICENSE`).
