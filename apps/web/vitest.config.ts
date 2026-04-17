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
      exclude: ['app/**/__tests__/**', 'app/routes/**', 'app/root.tsx'],
      thresholds: {
        // Low because components are tested via e2e, not unit tests.
        // Ratchet up as component tests are added.
        lines: 18,
        functions: 25,
        branches: 14,
        statements: 18,
      },
    },
  },
});
