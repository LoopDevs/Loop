import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the REAL-UPSTREAM end-to-end suite.
 *
 * Run via `npm run test:e2e:real`. This config assumes a real backend is
 * already running locally against production CTX (see
 * `docs/development.md`); it only boots the web dev server.
 *
 * Before audit A-003 this config was bound to `npm run test:e2e`, which
 * silently required a local backend that most developers did not have
 * running — purchase-flow tests failed with missing merchant data because
 * the web app had no API to talk to. `test:e2e` now defaults to the
 * self-contained mocked config (`playwright.mocked.config.ts`), and this
 * real-upstream suite has been moved to `test:e2e:real` as the explicit
 * opt-in.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
  reporter: process.env['CI'] ? 'github' : 'html',

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Mobile viewport via chromium — runs everywhere (locally and CI, since
    // CI only installs chromium). Catches layout/UX regressions that only
    // show up at narrow widths. Scoped to the smoke suite because purchase
    // flow tests depend on desktop-only UI (e.g. the Navbar search input is
    // hidden behind `md:block`). Mobile-specific interaction tests can be
    // added to smoke.test.ts or a dedicated mobile suite. For full
    // mobile-Safari parity run the 'mobile-safari' project locally after
    // `npx playwright install webkit`.
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'] },
      testMatch: /smoke\.test\.ts$/,
    },
    // Full mobile Safari only runs locally (CI installs chromium only).
    ...(!process.env['CI']
      ? [
          {
            name: 'mobile-safari',
            use: { ...devices['iPhone 14'] },
          },
        ]
      : []),
  ],

  // Start web dev server automatically in CI / local if not already running
  webServer: {
    command: 'npm run dev:web',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
    env: {
      VITE_API_URL: process.env['VITE_API_URL'] ?? 'http://localhost:8080',
    },
  },
});
