import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the admin/support dashboard E2E smoke (Q6-5,
 * `docs/money-auth-worklist.md`).
 *
 * The gap this closes: A5-1 (order re-drive), A5-2 (revoke-sessions),
 * A5-3 (login/OTP support tooling), A5-4 (order refund), A5-6 (stuck-
 * orders visibility), A5-7 (per-subject audit timeline), and A5-8
 * (fleet-wide ledger browser) all shipped with unit + staff-gating +
 * component test coverage, but nothing drove the actual admin
 * dashboard through a real browser as an authenticated staff user —
 * so a broken client-side route guard, a wrong staff-tier check, or a
 * data-shape mismatch between the backend and the admin UI could ship
 * green.
 *
 * Separate config / port range from the other three e2e suites
 * (mocked=8081/5174, flywheel=8082/5175, loop-purchase=8084/5177) for
 * the same reason `playwright.flywheel.config.ts` doesn't share a
 * backend with `playwright.mocked.config.ts`: `LOOP_AUTH_NATIVE_ENABLED`
 * changes the home page's SSR branch and this suite needs its own
 * staff-role seed independent of the other suites' user rows. No
 * mock-CTX or mock-Horizon needed — this suite never drives an order
 * THROUGH the admin write path (the step-up gate rejects the redrive/
 * refund attempts before any handler logic runs — see the test file's
 * own doc comment), it only proves the write AFFORDANCES render,
 * gate, and (for revoke-sessions, which has no step-up) complete.
 *
 * Runs as a third step within the CI `test-e2e-flywheel` job (see
 * `.github/workflows/ci.yml`), after the flywheel walk and the
 * loop-purchase suite have each finished and torn down their own
 * webServer — reuses the same `postgres:16` service container.
 */
export default defineConfig({
  testDir: './tests/e2e-admin-support',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI']
    ? [['github'], ['html', { outputFolder: 'playwright-report-admin', open: 'never' }]]
    : 'html',

  globalSetup: './tests/e2e-admin-support/global-setup.ts',

  use: {
    baseURL: 'http://localhost:5176',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    {
      command: 'npm exec -w @loop/backend -- tsx src/index.ts',
      url: 'http://localhost:8083/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: {
        PORT: '8083',
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        // No real CTX upstream — this suite never reaches procurement
        // (the step-up gate rejects the redrive/refund attempts
        // first). Still required by env.ts validation.
        GIFT_CARD_API_BASE_URL: 'http://unused.test.local',
        REFRESH_INTERVAL_HOURS: '6',
        LOCATION_REFRESH_INTERVAL_HOURS: '24',
        DATABASE_URL: 'postgres://loop:loop@localhost:5433/loop_test',
        LOOP_AUTH_NATIVE_ENABLED: 'true',
        LOOP_JWT_SIGNING_KEY: 'admin-e2e-loop-jwt-signing-key-at-least-32-chars-min',
        // ADR 028 — required so the redrive (A5-1) / refund (A5-4)
        // step-up gates return 401 STEP_UP_REQUIRED (which the web
        // step-up hook catches and opens StepUpModal for) rather than
        // 503 STEP_UP_UNAVAILABLE (which it does NOT catch — see
        // apps/web/app/hooks/use-admin-step-up.ts). Without this the
        // step-up-triggers assertion would be testing the wrong
        // failure mode.
        LOOP_ADMIN_STEP_UP_SIGNING_KEY: 'admin-e2e-step-up-signing-key-at-least-32-chars-min',
        LOOP_WORKERS_ENABLED: 'false',
        DISABLE_RATE_LIMITING: '1',
        // AUDIT-2-E: required second control (in addition to
        // NODE_ENV=test) before test-endpoints.ts mounts
        // `/__test__/mint-loop-token` — reused unmodified from the
        // flywheel suite's precedent. Only mints a Loop-native
        // session; the staff-role grant itself is a direct SQL seed
        // in global-setup.ts (mint-loop-token has no concept of
        // staff_roles).
        LOOP_TEST_ENDPOINTS_SECRET: 'loop-admin-e2e-test-endpoints-secret',
      },
    },
    {
      command: 'npm exec -w @loop/web -- react-router dev --host --port 5176',
      url: 'http://localhost:5176',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: {
        VITE_API_URL: 'http://localhost:8083',
      },
    },
  ],
});
