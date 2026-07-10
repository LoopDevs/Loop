import { defineConfig, devices } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';

// Fresh, never-funded, never-reused keypair generated at config-load
// time — not a hardcoded literal (scripts/lint-docs.sh §5b flags any
// tracked `S[A-Z2-7]{55}`-shaped string as a possible leaked secret;
// generating it here is the same "never a hardcoded secret literal"
// convention `LOOP_ADMIN_STEP_UP_SIGNING_KEY`'s docs use — see
// AGENTS.md's env summary). Deposit address == operator account,
// matching production topology (ADR 010: the deposit account IS the
// operator account) — `submitNativePayment` derives the operator's
// public key from this same secret, so the two must agree.
const FIXTURE_OPERATOR_KEYPAIR = Keypair.random();

/**
 * Playwright config for the loop-native purchase-through-the-UI e2e
 * suite (Q6-4, docs/money-auth-worklist.md).
 *
 * The gap this closes: neither `tests/e2e-mocked` (drives the
 * LEGACY CTX-proxy purchase path — `LOOP_AUTH_NATIVE_ENABLED` is
 * unset there) nor `tests/e2e-flywheel` (seeds an already-fulfilled
 * loop-native order directly via SQL and only walks the CONSUMER
 * surface — `/orders` rendering) ever drives the actual production
 * path (`createLoopOrder`, gated on `config.loopOrdersEnabled`)
 * through a real browser: browse → amount → `POST /api/orders/loop`
 * → payment step → on-chain deposit lands → paid → procured →
 * fulfilled → redemption revealed.
 *
 * Separate config (own port range, own backend process) rather than
 * folding into `playwright.flywheel.config.ts` because this suite
 * needs `LOOP_PHASE_1_ONLY=true` (to pin the CTX-payment rail to XLM
 * deterministically — see `orders/procure-one.ts`'s
 * `LOOP_PHASE_1_ONLY` override) and `LOOP_WORKERS_ENABLED=true` (the
 * payment watcher + procurement worker must actually run — and
 * `config.loopOrdersEnabled` structurally REQUIRES
 * `LOOP_WORKERS_ENABLED=true`, see `apps/backend/src/config/handler.ts`).
 * `LOOP_PHASE_1_ONLY=true` hides the cashback UI surfaces
 * `tests/e2e-flywheel/flywheel-walk.test.ts` asserts on ("Earned with
 * Loop" headline) — sharing one backend process between the two
 * suites would break that test, exactly the same reasoning
 * `playwright.flywheel.config.ts`'s own header comment gives for why
 * IT doesn't share a backend with `playwright.mocked.config.ts`.
 *
 * Runs as a second step within the CI `test-e2e-flywheel` job (see
 * `.github/workflows/ci.yml`) rather than a new job — reuses the same
 * `postgres:16` service container, sequentially after the existing
 * flywheel suite's webServer has torn down. Not a new required-status
 * check; same posture as the existing flywheel suite.
 *
 * Port choices — 808x backend, 517x web, 909x mocks — chosen to not
 * conflict with the mocked (8081/5174/9091) or flywheel (8082/5175)
 * suites, so all three can run back-to-back in the same checkout.
 */
export default defineConfig({
  testDir: './tests/e2e-loop-purchase',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI']
    ? [['github'], ['html', { outputFolder: 'playwright-report-loop-purchase', open: 'never' }]]
    : 'html',

  globalSetup: './tests/e2e-loop-purchase/global-setup.ts',

  use: {
    baseURL: 'http://localhost:5177',
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
      // Reused verbatim from the mocked-e2e suite — same generic
      // fixture, different port. Serves the merchant catalog +
      // handles the operator-side `POST /gift-cards` procurement
      // create + `GET /gift-cards/:id` redemption read.
      command: 'node tests/e2e-mocked/fixtures/mock-ctx.mjs',
      url: 'http://localhost:9093/status',
      reuseExistingServer: !process.env['CI'],
      timeout: 20_000,
      env: { PORT: '9093' },
    },
    {
      command: 'node tests/e2e-loop-purchase/fixtures/mock-horizon.mjs',
      url: 'http://localhost:9094/status',
      reuseExistingServer: !process.env['CI'],
      timeout: 20_000,
      env: { PORT: '9094' },
    },
    {
      // NOT the plain `tsx src/index.ts` the other two suites use —
      // see tests/e2e-loop-purchase/fixtures/backend-entry.mjs's own
      // header comment for why: `@stellar/stellar-sdk`'s
      // `Horizon.Server` refuses a plain-http URL by default, and
      // mock-horizon.mjs (below) is unencrypted HTTP for simplicity.
      command: 'npx tsx tests/e2e-loop-purchase/fixtures/backend-entry.mjs',
      url: 'http://localhost:8084/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: {
        PORT: '8084',
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        GIFT_CARD_API_BASE_URL: 'http://localhost:9093',
        REFRESH_INTERVAL_HOURS: '6',
        LOCATION_REFRESH_INTERVAL_HOURS: '24',
        DATABASE_URL: 'postgres://loop:loop@localhost:5433/loop_test',
        DISABLE_RATE_LIMITING: '1',
        // AUDIT-2-E: required second control (in addition to
        // NODE_ENV=test) before test-endpoints.ts mounts
        // `/__test__/mint-loop-token` — reused unmodified from the
        // flywheel suite's precedent to authenticate without an
        // OTP inbox to scrape.
        LOOP_TEST_ENDPOINTS_SECRET: 'loop-purchase-e2e-test-endpoints-secret',
        LOOP_AUTH_NATIVE_ENABLED: 'true',
        LOOP_JWT_SIGNING_KEY: 'loop-purchase-e2e-jwt-signing-key-at-least-32-chars',
        // Structurally required: `config.loopOrdersEnabled` (the flag
        // PurchaseContainer branches on) is
        // `LOOP_AUTH_NATIVE_ENABLED && LOOP_WORKERS_ENABLED &&
        // LOOP_STELLAR_DEPOSIT_ADDRESS !== undefined` — see
        // apps/backend/src/config/handler.ts. Without this the
        // loop-native path is unreachable from the UI at all.
        LOOP_WORKERS_ENABLED: 'true',
        LOOP_STELLAR_DEPOSIT_ADDRESS: FIXTURE_OPERATOR_KEYPAIR.publicKey(),
        LOOP_STELLAR_OPERATOR_SECRET: FIXTURE_OPERATOR_KEYPAIR.secret(),
        LOOP_STELLAR_HORIZON_URL: 'http://localhost:9094',
        // CoinGecko-shape override — see mock-horizon.mjs's `/rates`.
        LOOP_XLM_PRICE_FEED_URL: 'http://localhost:9094/rates',
        // Pins the CTX-settlement rail to XLM unconditionally
        // (orders/procure-one.ts) and matches this suite's production
        // config (LOOP_PHASE_1_ONLY=true is the real Tranche-1
        // setting) — see this file's header comment for why it can't
        // share flywheel's backend process.
        LOOP_PHASE_1_ONLY: 'true',
        // Fake operator credentials — mock-ctx.mjs never inspects the
        // Authorization / X-Client-Id headers, so any well-formed
        // pool entry works.
        CTX_OPERATOR_POOL: JSON.stringify([
          { id: 'mock-operator', bearer: 'mock-operator-bearer-token', clientId: 'loopweb' },
        ]),
        // Fast, deterministic ticking — default production cadence
        // (10s / 5s) would make this test slow without adding
        // coverage; fixed-interval timers on mocked, no-network I/O
        // don't introduce flakiness at a 1s cadence.
        LOOP_PAYMENT_WATCHER_INTERVAL_SECONDS: '1',
        LOOP_PROCUREMENT_INTERVAL_SECONDS: '1',
        // Large on purpose — this order has zero cashback
        // (LOOP_PHASE_1_ONLY zeroes userCashbackMinor on the row, so
        // no pending_payouts row is ever written), so the payout
        // worker has nothing to do; keep its tick from firing
        // spuriously during the run.
        LOOP_PAYOUT_WORKER_INTERVAL_SECONDS: '3600',
        // procurement-redemption.ts reads these directly off
        // process.env (not through the env.ts zod layer) — fast
        // polling so `waitForRedemption`'s fallback loop picks up the
        // test's `mark-fulfilled` call quickly once the SSE
        // pseudo-attempt (mock-ctx doesn't implement SSE) falls
        // through.
        LOOP_REDEMPTION_POLL_INTERVAL_MS: '300',
        LOOP_REDEMPTION_TOTAL_TIMEOUT_MS: '25000',
      },
    },
    {
      command: 'npm exec -w @loop/web -- react-router dev --host --port 5177',
      url: 'http://localhost:5177',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: {
        VITE_API_URL: 'http://localhost:8084',
      },
    },
  ],
});
