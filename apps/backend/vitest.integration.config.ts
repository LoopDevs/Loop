import { defineConfig } from 'vitest/config';

// Vitest config for real-postgres integration suite — A2-1705
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // Single worker — truncate-per-test pattern requires serialised DB view; parallel workers clobber state
    pool: 'forks',
    fileParallelism: false,
    setupFiles: ['./src/__tests__/integration/vitest-integration-setup.ts'],
    // Integration files only; excludes unit suite to avoid per-file-mock paths
    include: ['src/__tests__/integration/**/*.test.ts'],
    // Coverage owned by unit suite; skip v8 instrumentation overhead
    coverage: { enabled: false },
    // 30s timeout for cold-start migrations + worker ticks; default 5s too tight
    testTimeout: 30_000,
  },
});
