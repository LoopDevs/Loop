import { defineConfig } from 'vitest/config';

// vitest.config.ts replaces (rather than merges with) vite.config.ts, so
// path aliases need to be declared here too. Mirror tsconfig.json:
//   ~/* -> ./app/*
// Using resolve.tsconfigPaths would be cleaner but vitest's vite layer
// doesn't pick that option up the same way the app build does.
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'app'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['app/**/*.ts', 'app/**/*.tsx'],
      // Routes and `root.tsx` are exercised via Playwright (tests/e2e,
      // tests/e2e-mocked); excluding them here prevents coverage from
      // accounting for the same code twice across test suites. This is the
      // single best place to record the boundary between unit-tested and
      // e2e-tested code. Everything else — services, stores, hooks,
      // utils, native wrappers, components — is in scope for unit
      // coverage. When adding a route-independent piece of logic,
      // factor it out of the route and add a unit test.
      exclude: ['app/**/__tests__/**', 'app/routes/**', 'app/root.tsx'],
      // Thresholds are a regression gate, not an aspiration (audit A-014).
      // Actual at time of baseline: stmt 40.2 / branch 37.9 / func 45.4 /
      // line 41.1. These floors sit ~3-5pts below to tolerate minor
      // fluctuation but still fail CI if a change drags coverage down.
      // The explicit goal is to ratchet these up as new unit tests land,
      // never to widen the gap between measured and claimed coverage.
      thresholds: {
        lines: 37,
        functions: 40,
        branches: 32,
        statements: 35,
      },
    },
  },
});
