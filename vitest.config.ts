import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['coverage/**', '**/*.config.*', '**/*.test.*'],
    },
    projects: [
      // Unit tests — mocked transport, no network. Run in CI.
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.{test,spec}.{js,ts}', 'src/**/*.{test,spec}.{js,ts}'],
          exclude: ['node_modules', 'dist', 'tests/e2e/**'],
        },
      },
      // E2E tests — hit a real Scribe endpoint. Gated: skipped unless creds/env
      // are present (see tests/e2e/*). Runs in CI against staging (the `e2e`
      // job in .github/workflows/ci.yml); self-skips without creds.
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.{test,spec}.{js,ts}'],
          exclude: ['**/node_modules/**'],
          pool: 'forks',
          // Serialize the suites: they each allocate a GameServer from the
          // shared staging Fleet, so running them in one fork (not in parallel)
          // avoids racing for capacity (which would soft-skip the stream leg).
          poolOptions: { forks: { singleFork: true } },
          fileParallelism: false,
        },
      },
    ],
  },
})
