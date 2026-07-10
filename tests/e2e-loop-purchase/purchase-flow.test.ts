import { test, expect, type Page } from '@playwright/test';

/**
 * Loop-native purchase-through-the-UI e2e (Q6-4, docs/money-auth-worklist.md).
 *
 * The gap this closes: the ACTUAL production order path
 * (`createLoopOrder`, gated on `config.loopOrdersEnabled` — ADR 010's
 * principal switch) was never browser-driven in CI before this suite.
 * `tests/e2e-mocked/purchase-flow.test.ts` drives the LEGACY CTX-proxy
 * path (`LOOP_AUTH_NATIVE_ENABLED` is unset in that config).
 * `tests/e2e-flywheel/flywheel-walk.test.ts` seeds an already-fulfilled
 * loop-native order directly via SQL and only walks the read/consumer
 * side (`/orders` rendering). Neither drives: order CREATE via the UI
 * → the payment step's Stellar deposit instructions → a matching
 * on-chain deposit landing → the payment watcher marking the order
 * `paid` → the procurement worker settling with CTX and fulfilling →
 * the redemption payload appearing in the UI.
 *
 * Auth: reuses the SAME test-only `/__test__/mint-loop-token` +
 * sessionStorage-plant technique `flywheel-walk.test.ts` already
 * established — loop-native OTPs are minted server-side against
 * postgres with no inbox to scrape (see that endpoint's doc comment
 * in `apps/backend/src/test-endpoints.ts`), so there is no real OTP
 * form to drive for this auth path the way the mocked suite's
 * fixed-code mock-CTX OTP allows.
 *
 * On-chain simulation: `tests/e2e-loop-purchase/fixtures/mock-horizon.mjs`
 * stands in for Stellar Horizon (deposit-side `GET /accounts/:id/payments`
 * the payment watcher polls, PLUS `GET /accounts/:id` +
 * `POST /transactions` for the procurement worker's own outbound
 * payment to CTX). `tests/e2e-mocked/fixtures/mock-ctx.mjs` (reused
 * unmodified except a fixed-up destination address — see its own
 * comment) stands in for the CTX operator-side procurement call +
 * redemption read.
 *
 * Non-flakiness: every wait is on a UI/state assertion with a
 * generous explicit timeout (`toBeVisible`/`toPass`), never a fixed
 * `page.waitForTimeout`. The payment + procurement worker tick
 * intervals are configured to 1s (see playwright.loop-purchase.config.ts)
 * so the polling loops below don't need to out-wait the 10s/5s
 * production cadence.
 */

const BACKEND_URL = 'http://localhost:8084';
const MOCK_CTX_URL = 'http://localhost:9093';
const MOCK_HORIZON_URL = 'http://localhost:9094';
const TEST_EMAIL = 'loop-purchase-e2e@test.local';

// AUDIT-2-E: `/__test__/*` requires this shared secret via the
// `X-Test-Endpoints-Secret` header in addition to NODE_ENV=test — see
// apps/backend/src/test-endpoints.ts. Must match the
// LOOP_TEST_ENDPOINTS_SECRET set on the backend webServer in
// playwright.loop-purchase.config.ts.
const TEST_ENDPOINTS_SECRET = 'loop-purchase-e2e-test-endpoints-secret';

interface MintResponse {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

interface CreateLoopOrderXlmResponse {
  orderId: string;
  payment: {
    method: 'xlm';
    stellarAddress: string;
    memo: string;
    amountMinor: string;
    currency: string;
    assetAmount: string;
    paymentUri: string;
  };
}

async function mintLoopSession(page: Page, email: string): Promise<MintResponse> {
  const res = await page.request.post(`${BACKEND_URL}/__test__/mint-loop-token`, {
    headers: { 'X-Test-Endpoints-Secret': TEST_ENDPOINTS_SECRET },
    data: { email },
  });
  if (!res.ok()) {
    throw new Error(`mint-loop-token failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as MintResponse;
}

/**
 * Signs in without a real OTP form (see file header). Plants the
 * refresh token + email breadcrumb, then does a FULL navigation (not
 * a client-side route change) to `/` so `use-session-restore.ts`'s
 * boot-time hook actually reads the freshly-planted storage — a SPA
 * link click wouldn't remount the app and re-run that hook.
 */
async function signIn(page: Page): Promise<MintResponse> {
  const session = await mintLoopSession(page, TEST_EMAIL);
  // First navigation just gives us a same-origin document to write
  // storage into — about:blank doesn't share storage with the app.
  await page.goto('/');
  await page.evaluate(
    ({ refreshToken, email }) => {
      sessionStorage.setItem('loop_refresh_token', refreshToken);
      sessionStorage.setItem('loop_user_email', email);
      localStorage.setItem('loop_was_authed', 'true');
    },
    { refreshToken: session.refreshToken, email: session.email },
  );
  // Fresh full navigation: boot-restore reads the planted refresh
  // token, calls the real /api/auth/refresh, and the app renders
  // authenticated from here on.
  await page.goto('/');
  // Flake fix (Q6-4 follow-up): WAIT for the authenticated state to
  // fully settle before doing anything else. `use-session-restore.ts`
  // fires the `/api/auth/refresh` round-trip asynchronously on boot;
  // if we race ahead and start the purchase before it resolves, the
  // auth-store update lands mid-flow and re-renders/remounts the
  // merchant route subtree — which fires `PurchaseContainer`'s
  // `useEffect` cleanup (`store.reset()` + `setLoopCreate(null)`),
  // silently dropping the user from the payment screen back to the
  // amount form (observed once in the merge CI run: the order was
  // fine server-side but the UI had reset to a fresh amount form —
  // USDC re-selected, amount cleared). A real user completes the OTP
  // form and auth settles before they ever navigate to a merchant, so
  // gating on the authenticated avatar here makes the synthetic login
  // faithful to that ordering. The "Account menu" button
  // (Navbar.tsx) renders only when `accessToken !== null`.
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 15_000 });
  return session;
}

/** Starts at home (already authenticated), navigates to the first merchant's detail page. */
async function gotoFirstMerchantDetail(page: Page): Promise<void> {
  const merchantLink = page.locator('a[href*="/gift-card/"]').first();
  await expect(merchantLink).toBeVisible({ timeout: 15_000 });
  await merchantLink.click();
  await page.waitForURL(/\/gift-card\//);
}

/**
 * Polls mock-ctx's order list until the procurement worker has
 * created the operator-side order (id unknown ahead of time — it's a
 * fresh UUID mock-ctx mints on `POST /gift-cards`), then marks it
 * fulfilled with a URL-type redemption. `expect(...).toPass()` retries
 * the whole callback (not a fixed sleep) until it succeeds or times
 * out, so this is robust to however many watcher/procurement ticks it
 * takes to reach this point.
 */
async function waitForCtxOrderAndMarkFulfilled(page: Page): Promise<void> {
  await expect(async () => {
    const res = await page.request.get(`${MOCK_CTX_URL}/gift-cards`);
    const body = (await res.json()) as { result: Array<{ id: string }> };
    const order = body.result[0];
    expect(order, 'procurement has not created the CTX-side order yet').toBeDefined();
    const markRes = await page.request.post(`${MOCK_CTX_URL}/_test/mark-fulfilled/${order!.id}`, {
      data: { type: 'url' },
    });
    expect(markRes.ok()).toBe(true);
  }).toPass({ timeout: 20_000, intervals: [300] });
}

test.describe('loop-native purchase-through-the-UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post(`${MOCK_CTX_URL}/_test/reset`);
    await page.request.post(`${MOCK_HORIZON_URL}/_test/reset`);
  });

  test('browse → amount → loop-native order → on-chain deposit → paid → procured → fulfilled → redemption revealed', async ({
    page,
  }) => {
    const session = await signIn(page);
    await gotoFirstMerchantDetail(page);

    // Loop-native order creation offers a payment-rail picker
    // (`config.loopOrdersEnabled` — the whole point of this suite).
    // Pin XLM explicitly: the default selection is USDC, and this
    // suite's mock CTX/Horizon stack only exercises the XLM rail
    // (matches LOOP_PHASE_1_ONLY's production-realistic pin in
    // orders/procure-one.ts — see playwright.loop-purchase.config.ts).
    const xlmRadio = page.getByRole('radio', { name: 'XLM' });
    await expect(xlmRadio).toBeVisible({ timeout: 10_000 });
    await xlmRadio.click();
    await expect(xlmRadio).toHaveAttribute('aria-checked', 'true');

    const amountInput = page.getByLabel(/Amount \(USD\)/).first();
    await expect(amountInput).toBeVisible({ timeout: 10_000 });
    await amountInput.fill('25');

    // Capture the REAL POST /api/orders/loop response the UI receives
    // — the deposit address/memo/asset-amount it displays are exactly
    // what we need to construct a matching mock-Horizon deposit, with
    // no separate assumption about the XLM/USD rate baked into the
    // test (it's read straight off the wire, whatever the mocked
    // price feed produced).
    const [createResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/orders/loop') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Continue' }).click(),
    ]);
    if (createResponse.status() !== 200) {
      throw new Error(
        `POST /api/orders/loop returned ${createResponse.status()}: ${await createResponse.text()}`,
      );
    }
    const created = (await createResponse.json()) as CreateLoopOrderXlmResponse;
    expect(created.payment.method).toBe('xlm');
    expect(created.payment.stellarAddress).toBeTruthy();
    expect(created.payment.memo).toBeTruthy();
    expect(created.payment.amountMinor).toBe('2500');
    expect(created.payment.currency).toBe('USD');

    // ─── Payment step: money-critical UI states ────────────────────
    await expect(page.getByText('Waiting for payment')).toBeVisible({ timeout: 10_000 });
    // "You pay" — the fiat amount the user is committing to.
    await expect(page.getByText('$25.00')).toBeVisible();
    // "Send" — the exact asset amount + address + memo the UI tells
    // the user to send. Built from the captured response so this
    // assertion can't silently pass against a stale/wrong figure.
    await expect(
      page.getByText(`${created.payment.assetAmount} XLM`, { exact: false }),
    ).toBeVisible();
    await expect(page.getByText(created.payment.stellarAddress)).toBeVisible();
    await expect(page.getByText(created.payment.memo)).toBeVisible();

    // ─── Simulate the on-chain deposit landing ─────────────────────
    // A real user's wallet would broadcast this; the payment watcher
    // (1s tick — see playwright.loop-purchase.config.ts) polls
    // mock-horizon's GET /accounts/:id/payments exactly like real
    // Horizon and transitions the order pending_payment → paid.
    const injectRes = await page.request.post(`${MOCK_HORIZON_URL}/_test/inject-payment`, {
      data: {
        to: created.payment.stellarAddress,
        from: 'GUSERTESTSENDERPLACEHOLDERNOTAREALKEY0000000000000000',
        amount: created.payment.assetAmount,
        assetType: 'native',
        memo: created.payment.memo,
      },
    });
    expect(injectRes.ok()).toBe(true);

    // ─── paid → procuring → fulfilled ──────────────────────────────
    // Money-critical, asserted DETERMINISTICALLY against the backend
    // (not a racy UI frame): the order must move OFF `pending_payment`
    // once the deposit lands — that transition is the proof the payment
    // watcher matched the deposit end to end (amount + memo + asset all
    // had to line up). `toPass` polls the authoritative order API, so
    // it's immune to the UI's 3s poll cadence.
    await expect(async () => {
      const res = await page.request.get(`${BACKEND_URL}/api/orders/loop/${created.orderId}`, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { state: string };
      expect(['paid', 'procuring', 'fulfilled']).toContain(body.state);
    }).toPass({ timeout: 20_000, intervals: [300] });

    // …and the payment-step UI reflects the progressed state. The exact
    // intermediate label ("Payment received" for `paid` vs "Buying your
    // gift card" for `procuring`) is deliberately NOT pinned to one
    // frame: with the watcher + procurement worker both ticking at 1s
    // (this suite's speed tuning) against the UI's 3s poll, a fast
    // backend can race `paid`→`procuring`→`fulfilled` past a single
    // sampled frame. Matching ANY progressed label (including "Ready")
    // is race-free while staying non-vacuous — the amount-selection
    // fallback form shows none of these three, so a regression that
    // dropped the user off the payment step (e.g. a mid-flow remount)
    // still fails here rather than passing silently.
    await expect(page.getByText(/Payment received|Buying your gift card|Ready/)).toBeVisible({
      timeout: 15_000,
    });

    // ─── Complete the operator-side CTX order. Procurement began its
    //     redemption wait the moment the order hit `procuring`; marking
    //     the CTX-side order fulfilled here delivers the redemption
    //     payload it is polling for (well inside its 25s budget, so the
    //     order fulfils WITH the mock redeem URL rather than a
    //     budget-exhausted null). ─────────────────────────────────────
    await waitForCtxOrderAndMarkFulfilled(page);

    // ─── fulfilled: state label + redemption reveal ────────────────
    await expect(page.getByText('Ready')).toBeVisible({ timeout: 25_000 });
    const redeemLink = page.getByRole('link', { name: 'Open redemption link' });
    await expect(redeemLink).toBeVisible();
    await expect(redeemLink).toHaveAttribute('href', 'https://redeem.test/mock');

    // ─── Cross-check against the authoritative API response, not
    //     just the rendered text — proves the DB row actually landed
    //     `fulfilled` with the redemption fields persisted, not just
    //     that some stale UI text matched. ─────────────────────────
    const orderRes = await page.request.get(`${BACKEND_URL}/api/orders/loop/${created.orderId}`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(orderRes.ok()).toBe(true);
    const orderBody = (await orderRes.json()) as { state: string; redeemUrl: string | null };
    expect(orderBody.state).toBe('fulfilled');
    expect(orderBody.redeemUrl).toBe('https://redeem.test/mock');
  });
});
