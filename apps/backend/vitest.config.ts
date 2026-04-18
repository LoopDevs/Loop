import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/index.ts'],
      // Thresholds are a regression gate, not an aspiration (audit A-014).
      // They sit ~3pts below the actual coverage number measured at the
      // time of writing (stmt 83.7 / branch 77.0 / func 79.4 / line 85.0).
      // When adding code, either keep coverage at or above these floors or
      // ratchet the floor up — never widen the gap between "what we test"
      // and "what we claim to test."
      thresholds: {
        lines: 80,
        functions: 75,
        branches: 72,
        statements: 80,
      },
    },
  },
});
