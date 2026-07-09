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
    // ADR 043 (B-6): initializes the i18next singleton (side-effect import)
    // before every test file's module registry, so `useTranslation()` in
    // any rendered component resolves real English copy instead of raw
    // "namespace:key" fallback strings. See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['app/**/*.ts', 'app/**/*.tsx'],
      // C3 (hardening 2026-07): routes, `root.tsx`, and the home/
      // onboarding presentation are now MEASURED. They were previously
      // excluded, which narrowed the denominator and let the coverage
      // number overstate how much of the shipping app is actually
      // tested. The exclusions below are the genuinely un-unit-testable
      // surface only: the test files themselves, the route-table config,
      // and the SSR/client entry bootstraps (framework-invoked, no
      // branching of ours). Everything else — every route loader, meta,
      // action, and component — counts. When a route owns risky logic,
      // add a route test (see gift-card.$name / not-found-ssr for the
      // loader/meta pattern) or Playwright coverage.
      exclude: [
        'app/**/__tests__/**',
        'app/routes.ts', // generated route table, not app logic
        'app/entry.server.tsx', // SSR bootstrap, framework-invoked
      ],
      // Thresholds are a regression gate, not an aspiration (audit A-014).
      // C3 re-baselined them against the HONEST whole-app denominator
      // (routes included): measured stmt 58.2 / branch 53.6 / func 56.2 /
      // line 59.6 (2026-07). Floors sit ~3-4pts below to tolerate minor
      // fluctuation but still fail CI if a change drags coverage down —
      // and they're now honest (whole-app), not a narrowed subset. Ratchet
      // up as new tests land; never widen the measured↔claimed gap again.
      thresholds: {
        lines: 56,
        functions: 53,
        branches: 50,
        statements: 55,
      },
    },
  },
});
