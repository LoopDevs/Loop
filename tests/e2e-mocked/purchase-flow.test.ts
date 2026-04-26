import { test, expect, type Page } from '@playwright/test';

/**
 * Mocked end-to-end purchase flow.
 *
 * The mock CTX server (tests/e2e-mocked/fixtures/mock-ctx.mjs) stands in
 * for the real upstream. It accepts OTP "123456" for any email and holds
 * orders in memory; a test-only POST /_test/mark-fulfilled/:id flips an
 * order to the redeem/complete state deterministically.
 *
 * Each test resets the mock's state so ordering is irrelevant.
 */

const MOCK_CTX_URL = 'http://localhost:9091';
const BACKEND_URL = 'http://localhost:8081';
const FIXED_OTP = '123456';

async function resetMock(page: Page): Promise<void> {
  await page.request.post(`${MOCK_CTX_URL}/_test/reset`);
  // Also reset backend per-IP rate-limit state so retries across tests
  // don't stack up against the 5/min /api/auth/request-otp budget.
  // Endpoint is gated on NODE_ENV=test (see apps/backend/src/app.ts).
  await page.request.post(`${BACKEND_URL}/__test__/reset`);
}

async function markOrderFulfilled(
  page: Page,
  orderId: string,
  type: 'url' | 'barcode' = 'url',
): Promise<void> {
  const res = await page.request.post(`${MOCK_CTX_URL}/_test/mark-fulfilled/${orderId}`, {
    data: { type },
  });
  if (!res.ok()) {
    throw new Error(`Failed to mark order fulfilled: ${res.status()}`);
  }
}

/** Starts at home, navigates to a merchant detail page, returns that merchant's name. */
async function gotoMerchantDetail(page: Page): Promise<string> {
  await page.goto('/');
  const merchantLink = page.locator('a[href^="/gift-card/"]').first();
  await expect(merchantLink).toBeVisible();
  // The card's h3 carries the merchant name; read it for later assertions.
  const name = await merchantLink.locator('h3').first().innerText();
  await merchantLink.click();
  await page.waitForURL(/\/gift-card\//);
  return name;
}

/** Drives the inline auth form from the purchase card. Leaves state authenticated. */
async function signInInline(page: Page, email = 'e2e-mocked@test.local'): Promise<void> {
  await page.getByLabel(/Email address/).fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  // A2-1704: bump the OTP-step sync wait to 10s. The Continue click
  // fires `POST /api/auth/request-otp` which proxies to the mock CTX
  // and only THEN re-renders the OTP step. On a slow CI runner the
  // round-trip can exceed Playwright's 5s default and produce the
  // 15+-consecutive-run "toBeVisible flake" the audit flagged. Match
  // the timeout cadence of other purchase-flow waits (10_000) — the
  // `Verification code` label is the more reliable signal because it
  // anchors on the OTP-input element, not interstitial text that can
  // appear before the input is hooked up.
  await expect(page.getByLabel('Verification code')).toBeVisible({ timeout: 10_000 });
  await page.getByLabel('Verification code').fill(FIXED_OTP);
  await page.getByRole('button', { name: 'Verify' }).click();
}

test.describe('mocked purchase flow', () => {
  test.beforeEach(async ({ page }) => {
    await resetMock(page);
  });

  test('happy path — email → OTP → amount → payment → redeem (URL)', async ({ page }) => {
    await gotoMerchantDetail(page);
    await signInInline(page);

    // After verify: PurchaseContainer renders the AmountSelection for the
    // merchant. Seed merchants are a mix of fixed + min-max denoms; the
    // first card in the list (mock-amazon) is min-max so we get an input.
    const amountInput = page.getByLabel(/Amount \(USD\)/).first();
    await expect(amountInput).toBeVisible({ timeout: 10_000 });
    await amountInput.fill('25');
    await page.getByRole('button', { name: 'Continue' }).click();

    // Payment step renders with the address/amount/memo from the mock order.
    // The mock's fake XLM rate is 5 per USD, so $25 → 125.0000 XLM.
    await expect(page.getByText(/Send exactly this amount/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/125\.0000/)).toBeVisible();

    // Extract the order id the frontend is polling — it lives in the
    // payment URL / memo. Easier to pull from the mock's list endpoint.
    const ordersRes = await page.request.get(`${MOCK_CTX_URL}/gift-cards`);
    const ordersBody = (await ordersRes.json()) as { result: Array<{ id: string }> };
    const orderId = ordersBody.result[0]?.id;
    expect(orderId).toBeTruthy();

    // Flip the order to fulfilled with a URL-type redemption; the frontend
    // polling (every 3s) should pick it up and transition to the Redeem step.
    await markOrderFulfilled(page, orderId!, 'url');

    // Wait for the Redeem screen — challenge code is a distinct signal.
    await expect(page.getByText(/MOCK-CHALLENGE-/)).toBeVisible({ timeout: 15_000 });
  });

  test('wrong OTP shows an inline error without leaving the OTP step', async ({ page }) => {
    await gotoMerchantDetail(page);
    await page.getByLabel(/Email address/).fill('e2e@test.local');
    await page.getByRole('button', { name: 'Continue' }).click();
    // A2-1704: anchor on the OTP-input label (not the interstitial
    // text) and bump the timeout to 10s — same fix as `signInInline`.
    await expect(page.getByLabel('Verification code')).toBeVisible({ timeout: 10_000 });
    await page.getByLabel('Verification code').fill('000000');
    await page.getByRole('button', { name: 'Verify' }).click();

    // An error message should appear inline; the verify button stays visible
    // (we're still on the OTP step, not redirected).
    await expect(page.getByText(/Invalid code/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Verify' })).toBeVisible();
  });
});
