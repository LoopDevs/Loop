import { defineConfig, devices } from '@playwright/test';

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
    // Mobile Safari only runs locally (CI installs chromium only)
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
