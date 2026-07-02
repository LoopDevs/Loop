import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Measure the whole package, not just files a test happens to
      // import — otherwise adding an untested module silently reads as
      // 100%. Excluded: the barrel (re-exports only), generated
      // protobuf output, and pure type/constant modules with no
      // executable statements for v8 to attribute.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/proto/**'],
      // Thresholds are a regression gate, not an aspiration (same
      // policy as apps/backend): set a few points below the measured
      // number at the time of writing — ratchet up, never widen.
      // Measured at introduction (2026-07-02): stmt 98.8 / branch 92.8
      // / func 97.6 / line 99.3.
      thresholds: {
        lines: 95,
        functions: 92,
        branches: 88,
        statements: 95,
      },
    },
  },
});
