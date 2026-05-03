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
      // Routes and `root.tsx` are excluded from UNIT coverage so this
      // metric stays focused on shared modules. Some route journeys are
      // exercised via Playwright and a few routes have direct tests, but
      // that coverage is partial — this exclusion is not a blanket claim
      // that every route is covered elsewhere. When a route owns risky
      // logic, add a route test or Playwright coverage explicitly.
      exclude: [
        'app/**/__tests__/**',
        'app/routes/**',
        'app/root.tsx',
        // Route-level presentation: MobileHome is the mobile variant of
        // the home route, and the onboarding flow is a 5-component
        // assembly rendered by a single route. They follow the same
        // route-level exclusion boundary as `app/routes/**`; that is a
        // unit-coverage choice, not a blanket browser-coverage claim.
        // Keep reusable UI (components/ui/**, atoms) IN.
        'app/components/features/home/**',
        'app/components/features/onboarding/**',
      ],
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
