import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
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
