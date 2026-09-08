import { fileURLToPath } from 'node:url';
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
      // Skip `npm run dev -w @loop/backend` because that script would
      // pick up the developer's local `apps/backend/config.yaml`, which
      // (a) may not exist in CI and (b) points at the real upstream.
      // Run tsx directly against the source with CONFIG_PATH aimed at
      // the committed e2e fixture so only that file applies.
      command: 'npm exec -w @loop/backend -- tsx src/index.ts',
      url: 'http://localhost:8081/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: {
        // Everything the backend reads lives in the fixture: port 8081,
        // the mock-CTX base URL + operator creds, the ephemeral memory
        // store, rate limiting off, and the AUDIT-2-E test-endpoints
        // secret. See apps/backend/config.e2e.yaml for the reasoning
        // behind each.
        // Absolute: `npm exec -w` runs the child from apps/backend, so a
        // repo-root-relative path would not resolve.
        CONFIG_PATH: fileURLToPath(new URL('apps/backend/config.e2e.yaml', import.meta.url)),
        NODE_ENV: 'test',
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
