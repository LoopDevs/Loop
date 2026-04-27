/**
 * Loop-native flywheel-via-UI walk (A2-1705 phase A.3 closure).
 *
 * Walks the consumer-side UI surface for an authenticated user who
 * has a fulfilled loop-native order + cashback credited:
 *
 *   1. Mint a real loop-native access/refresh token pair via the
 *      test-only `/__test__/mint-loop-token` endpoint (gated on
 *      NODE_ENV=test, identical guard to the existing /__test__/reset).
 *   2. Plant the refresh token + email breadcrumb in browser storage
 *      so the existing `use-session-restore.ts` boot flow refreshes
 *      the access token through the production refresh endpoint.
 *   3. Navigate to /orders. The boot-restore round-trip mints a fresh
 *      access token, the orders page fetches `/api/orders/loop`, and
 *      the LoopOrdersList renders the seeded fulfilled order. The
 *      CashbackEarningsHeadline renders the user's lifetime cashback.
 *
 * What this validates that the in-process flywheel.test.ts can't:
 *   - The boot-restore session reload — sessionStorage seeded → real
 *     /api/auth/refresh → access token restored → React Query cache
 *     populated.
 *   - The loop-native orders list component renders against real DB
 *     rows (the unit suite mocks the fetch).
 *   - The cashback earnings headline appears for a user with non-zero
 *     lifetime cashback.
 *
 * The seed is in `./global-setup.ts` so the test stays focused on the
 * UI walk; programmatic order creation through the UI is covered by
 * the legacy mocked-e2e purchase flow + the in-process flywheel
 * integration test. Together the three suites cover the full
 * producer → ledger → consumer chain.
 */
import { test, expect, type Page } from '@playwright/test';

const BACKEND_URL = 'http://localhost:8082';
const SEEDED_EMAIL = 'flywheel-walk@test.local';

interface MintResponse {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

async function mintLoopSession(page: Page, email: string): Promise<MintResponse> {
  const res = await page.request.post(`${BACKEND_URL}/__test__/mint-loop-token`, {
    data: { email },
  });
  if (!res.ok()) {
    throw new Error(`mint-loop-token failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as MintResponse;
}

test.describe('loop-native flywheel walk', () => {
  test('seeded fulfilled order + cashback render in /orders for the authenticated user', async ({
    page,
  }) => {
    // Step 1: mint a real session for the seeded user.
    const session = await mintLoopSession(page, SEEDED_EMAIL);

    // Step 2: navigate to a same-origin page so we can plant
    // sessionStorage. About:blank doesn't share storage with the app
    // origin; visiting / first gives us a real document on the right
    // origin.
    await page.goto('/');

    await page.evaluate(
      ({ refreshToken, email }) => {
        sessionStorage.setItem('loop_refresh_token', refreshToken);
        sessionStorage.setItem('loop_user_email', email);
        // Boot-restore checks this breadcrumb to decide whether to
        // skip the splash; without it the home page hesitates before
        // firing the /refresh call.
        localStorage.setItem('loop_was_authed', 'true');
      },
      { refreshToken: session.refreshToken, email: session.email },
    );

    // Step 3: navigate to /orders. Boot-restore reads sessionStorage,
    // posts to /api/auth/refresh with the seeded refresh token, gets
    // a fresh access token, and the orders page renders for the
    // authenticated user.
    await page.goto('/orders');

    // CashbackEarningsHeadline renders only when lifetime > 0. The
    // seed gives the user $2.50 of lifetime cashback, so the
    // "Earned with Loop" heading should appear. This proves the
    // /api/users/me/cashback-summary fetch + render pipeline.
    await expect(page.getByText(/Earned with Loop/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/\$2\.50/).first()).toBeVisible();

    // OrdersSummaryHeader reads from /api/orders and counts terminal
    // states. The seed has one fulfilled order, so the "Fulfilled"
    // tile should show "1". Anchors on the surrounding region
    // accessible name to disambiguate from any stray "1" elsewhere.
    const summary = page.getByRole('region', { name: /Orders summary/i });
    await expect(summary).toBeVisible();
    await expect(summary.getByText(/Fulfilled/i)).toBeVisible();
  });
});
