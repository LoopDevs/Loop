import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the MOCKED end-to-end suite.
 *
 * The default config (`playwright.config.ts`) runs tests against the real
 * backend pointing at real CTX. This config starts everything on a
 * non-conflicting port range and boots a mock CTX server in place of the
 * real upstream, so the full purchase flow (auth → amount → payment →
 * complete) can be exercised deterministically with no external
 * dependencies.
 *
 * Port choices — 909x for the mock, 8081 for the backend, 5174 for the
 * web dev server — keep these out of the way of a real-mode Playwright run,
 * so both can run back-to-back in the same checkout.
 */
export default defineConfig({
  testDir: './tests/e2e-mocked',
  fullyParallel: false, // Shared in-memory state in the mock; run serially.
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? 'github' : 'html',

  // A2-1705 phase A.2: run drizzle migrations against `loop_test`
  // BEFORE Playwright spins up the backend. The backend skips
  // `runMigrations()` under NODE_ENV=test, so this hook is where the
  // schema actually lands.
  globalSetup: './tests/e2e-mocked/global-setup.ts',

  use: {
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Start all three processes. Playwright waits for each URL to return 2xx
  // before starting tests. Order doesn't strictly matter — the backend will
  // retry the mock-CTX /status probe until the mock is up — but listing them
  // in dependency order makes failure modes clearer in logs.
  webServer: [
    {
      command: 'node tests/e2e-mocked/fixtures/mock-ctx.mjs',
      url: 'http://localhost:9091/status',
      reuseExistingServer: !process.env['CI'],
      timeout: 20_000,
      env: { PORT: '9091' },
    },
    {
      // Skip `npm run dev -w @loop/backend` because that script loads
      // apps/backend/.env, which (a) may not exist in CI and (b) contains
      // real-upstream values that would stomp our test config. Run tsx
      // directly against the source so only the env below applies.
      command: 'npm exec -w @loop/backend -- tsx src/index.ts',
      url: 'http://localhost:8081/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: {
        PORT: '8081',
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        GIFT_CARD_API_BASE_URL: 'http://localhost:9091',
        REFRESH_INTERVAL_HOURS: '6',
        LOCATION_REFRESH_INTERVAL_HOURS: '24',
        // A2-1705 phase A.2: real postgres connection. The migrations
        // are applied by `tests/e2e-mocked/global-setup.ts` before
        // Playwright boots this webServer, so the backend connects to
        // a current schema. NODE_ENV=test still skips the backend's
        // own `runMigrations()` call (idempotent overlap would be
        // harmless but pointless). The existing CTX-proxy purchase
        // flow doesn't write to the DB (orders live in mock-CTX's
        // memory map), so this connection is a harness investment for
        // future loop-native UI tests rather than a behaviour change
        // for the current 2-test suite.
        //
        // Loop-native auth env (LOOP_AUTH_NATIVE_ENABLED + signing
        // key + issuer fixtures) is intentionally left unset so the
        // home page's `/api/config` response stays identical to its
        // pre-A.2 shape. Flipping it would change SSR-vs-CSR rendering
        // (the home page has a `loopAuthNativeEnabled` branch) and
        // cause a hydration mismatch in the existing CTX-proxy tests.
        // A future flywheel-via-UI test will pin those env vars in a
        // dedicated `playwright.flywheel.config.ts`.
        DATABASE_URL: 'postgres://loop:loop@localhost:5433/loop_test',
        // Bypass per-IP rate limits — the suite runs 2 tests with
        // Playwright retries=2 in CI, hitting /api/auth/request-otp
        // up to 6 times in a cold window vs the 5/min limit.
        DISABLE_RATE_LIMITING: '1',
      },
    },
    {
      // React Router's `dev` command doesn't read PORT from env; force it
      // via the Vite CLI flag. Running react-router directly via `npm exec`
      // because `npm run dev:web -- --port 5174` was eating the --port flag.
      command: 'npm exec -w @loop/web -- react-router dev --host --port 5174',
      url: 'http://localhost:5174',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: {
        VITE_API_URL: 'http://localhost:8081',
      },
    },
  ],
});
