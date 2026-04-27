import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the loop-native flywheel-via-UI walk
 * (A2-1705 phase A.3 closure).
 *
 * Separate from `playwright.mocked.config.ts` because this suite
 * pins `LOOP_AUTH_NATIVE_ENABLED=true` + the Stellar issuer
 * fixtures, which changes `/api/config` and the home page's
 * `loopAuthNativeEnabled` SSR branch. Sharing a backend with the
 * mocked suite would either break those tests' hydration or force
 * us to gate the flag conditionally, which is the kind of test-only
 * production drift we want to avoid.
 *
 * Port choices — 808x backend, 517x web — chosen to NOT conflict
 * with the mocked harness (8081 / 5174) so both can run back-to-back
 * in the same checkout.
 *
 * No mock-CTX: this suite doesn't drive the legacy auth path. The
 * loop-native auth surface mints its own JWTs against postgres; we
 * exercise it via the test-only `/__test__/mint-loop-token`
 * endpoint declared in `apps/backend/src/test-endpoints.ts`.
 */
export default defineConfig({
  testDir: './tests/e2e-flywheel',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? 'github' : 'html',

  globalSetup: './tests/e2e-flywheel/global-setup.ts',

  use: {
    baseURL: 'http://localhost:5175',
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
      url: 'http://localhost:8082/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: {
        PORT: '8082',
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        // No real CTX upstream — the loop-native flow under test
        // doesn't talk to it. Still required by env.ts validation.
        GIFT_CARD_API_BASE_URL: 'http://unused.test.local',
        REFRESH_INTERVAL_HOURS: '6',
        LOCATION_REFRESH_INTERVAL_HOURS: '24',
        DATABASE_URL: 'postgres://loop:loop@localhost:5433/loop_test',
        // Enable loop-native auth — this is the whole point of the
        // separate config. The mint-loop-token test endpoint mints
        // tokens against the same signing key, the boot-restore
        // refresh round-trip exercises the real /api/auth/refresh
        // handler, and the home page renders its
        // `loopAuthNativeEnabled` SSR branch.
        LOOP_AUTH_NATIVE_ENABLED: 'true',
        LOOP_JWT_SIGNING_KEY: 'flywheel-walk-loop-jwt-signing-key-32-chars-min',
        // Stellar fixture issuers — required for `/api/orders/loop`
        // and the cashback payout flow, even though this test
        // doesn't drive an order creation through the UI.
        LOOP_STELLAR_DEPOSIT_ADDRESS: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        LOOP_STELLAR_USDLOOP_ISSUER: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        LOOP_STELLAR_GBPLOOP_ISSUER: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        LOOP_STELLAR_EURLOOP_ISSUER: 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
        LOOP_WORKERS_ENABLED: 'false',
        DISABLE_RATE_LIMITING: '1',
      },
    },
    {
      command: 'npm exec -w @loop/web -- react-router dev --host --port 5175',
      url: 'http://localhost:5175',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: {
        VITE_API_URL: 'http://localhost:8082',
      },
    },
  ],
});
