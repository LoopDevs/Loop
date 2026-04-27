import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the real-postgres integration suite (A2-1705).
 *
 * Separate from `vitest.config.ts` so the existing 1856-test unit
 * suite keeps its placeholder-DB + per-file-mock posture, while the
 * integration suite runs against a live `loop_test` postgres with
 * checked-in migrations applied.
 *
 * Run locally:
 *   docker compose up -d db   # one-time, see ./docker-compose.yml
 *   npm run test:integration -w @loop/backend
 *
 * In CI, the workflow uses a postgres service container (see
 * `.github/workflows/ci.yml::flywheel-integration`).
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // Single worker — the truncate-per-test pattern relies on a
    // serialised view of the DB; parallel workers would clobber each
    // other's state. Vitest 4 promoted these from `poolOptions` to
    // top-level `pool` config.
    pool: 'forks',
    fileParallelism: false,
    setupFiles: ['./src/__tests__/integration/vitest-integration-setup.ts'],
    // Only the integration files. The default unit suite is excluded
    // here so a `npm run test:integration` invocation never touches
    // the per-file-mock paths.
    include: ['src/__tests__/integration/**/*.test.ts'],
    // Coverage isn't this suite's job — the unit suite owns coverage
    // metrics. Skip the v8 instrumentation overhead.
    coverage: { enabled: false },
    // Real DB calls + migrations are slow on cold start; the default
    // 5s test timeout is too tight. 30s gives the migrator + worker
    // ticks room without masking real hangs.
    testTimeout: 30_000,
  },
});
