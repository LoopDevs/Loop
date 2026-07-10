/**
 * Admin/support dashboard E2E smoke (Q6-5, `docs/money-auth-worklist.md`).
 *
 * The admin surface grew a lot this session — A5-1 (order re-drive),
 * A5-2 (revoke-sessions), A5-3 (login/OTP support tooling), A5-4
 * (order refund), A5-6 (stuck-orders support-visibility), A5-7 (per-
 * subject audit timeline), A5-8 (fleet-wide ledger browser) — all
 * with unit + staff-gating + component test coverage, but nothing
 * drove the dashboard through a real browser as an authenticated
 * staff user. A broken client-side route guard, a wrong staff-tier
 * check, or a data-shape mismatch between backend and admin UI could
 * ship green through every existing layer. This suite closes that
 * gap with two tests:
 *
 *   1. Signed in as an ADMIN-tier staff user: dashboard loads, the
 *      stuck-orders triage view (A5-6), the fleet ledger browser
 *      (A5-8, with a filter + the pagination affordance), the orders
 *      list, and a user-360 page (A5-7 audit timeline + A5-3
 *      auth-state, both showing real seeded data) all render. The
 *      order re-drive (A5-1) and refund (A5-4) write affordances
 *      render and — on submit — trip the ADR 028 step-up gate exactly
 *      the way a real admin session would (this suite never completes
 *      either: both are real money-moving writes and the assertion
 *      that matters here is "the step-up dance triggers", not
 *      "procurement succeeds", which the money-review-gated backend
 *      integration tests already cover). Session-revocation (A5-2,
 *      which has NO step-up by design — see RevokeSessionsPanel's own
 *      doc comment) is completed end-to-end as the one safe write
 *      this suite proves all the way through a real browser: it moves
 *      no value and is fully reversible.
 *   2. Signed in as a SUPPORT-tier staff user: the same read surfaces
 *      render, but every admin-only write affordance (re-drive,
 *      refund, revoke-sessions, clear-OTP-lockout) and every admin-
 *      only nav/page (e.g. `/admin/staff`) is absent or denied — the
 *      UI-side half of the ADR 037 permission matrix.
 *
 * Auth: mints a real Loop-native session via the test-only
 * `/__test__/mint-loop-token` endpoint (same mechanism as
 * `tests/e2e-flywheel/flywheel-walk.test.ts` — no OTP inbox to
 * scrape). That endpoint grants a SESSION, not a ROLE; the ADR 037
 * `staff_roles` grants themselves are seeded directly via SQL in
 * `global-setup.ts`, same spirit as that suite's direct ledger seed.
 *
 * Non-flake discipline (learned from Q6-4's multi-round de-flake):
 * every wait is a `toBeVisible({ timeout })`, a scoped dialog/role
 * query, or a `waitForResponse` on the specific mutation — no
 * `page.waitForTimeout` anywhere in this file. All seed data is
 * planted deterministically in `global-setup.ts` (fixed ids, no
 * randomness) so every assertion targets a known row rather than
 * "whatever happens to be there".
 */
import { test, expect, type Page } from '@playwright/test';
import {
  ADMIN_EMAIL,
  SUPPORT_EMAIL,
  TARGET_EMAIL,
  TARGET_USER_ID,
  STUCK_ORDER_ID,
} from './global-setup';

const BACKEND_URL = 'http://localhost:8083';

// AUDIT-2-E: `/__test__/*` requires this shared secret via the
// `X-Test-Endpoints-Secret` header in addition to NODE_ENV=test — see
// apps/backend/src/test-endpoints.ts. Must match the
// LOOP_TEST_ENDPOINTS_SECRET set on the backend webServer in
// playwright.admin.config.ts.
const TEST_ENDPOINTS_SECRET = 'loop-admin-e2e-test-endpoints-secret';

interface MintResponse {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

async function mintSession(page: Page, email: string): Promise<MintResponse> {
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
 * Mints a session for `email` and plants it in browser storage —
 * mirrors `tests/e2e-flywheel/flywheel-walk.test.ts`'s
 * `mintLoopSession` helper. Visits `/` first so there's a same-origin
 * document to plant sessionStorage/localStorage on (about:blank
 * shares no storage with the app origin); the caller navigates on
 * from there.
 */
async function signInAs(page: Page, email: string): Promise<void> {
  const session = await mintSession(page, email);
  await page.goto('/');
  await page.evaluate(
    ({ refreshToken, email: sessionEmail }) => {
      sessionStorage.setItem('loop_refresh_token', refreshToken);
      sessionStorage.setItem('loop_user_email', sessionEmail);
      // Boot-restore checks this breadcrumb to decide whether to skip
      // the splash; without it the first page hesitates before firing
      // the /refresh call.
      localStorage.setItem('loop_was_authed', 'true');
    },
    { refreshToken: session.refreshToken, email: session.email },
  );
}

/**
 * Drives a `ReasonDialog`- or `RefundDialog`-fronted admin write to
 * the point where the ADR 028 step-up gate trips, and asserts
 * `StepUpModal` opens in response — then cancels, leaving no lasting
 * side effect (the backend never reaches handler logic: the step-up
 * middleware 401s before `adminRedriveOrderHandler` /
 * `adminRefundOrderHandler` runs at all).
 */
async function expectWriteTripsStepUp(
  page: Page,
  opts: {
    triggerButtonName: string;
    dialogTitleRegex: RegExp;
    confirmButtonName: string;
    apiPathSegment: string;
  },
): Promise<void> {
  await page.getByRole('button', { name: opts.triggerButtonName, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: opts.dialogTitleRegex });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole('textbox').first().fill('Q6-5 e2e smoke — verifying the step-up gate.');

  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(opts.apiPathSegment) && r.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: opts.confirmButtonName, exact: true }).click(),
  ]);
  expect(response.status()).toBe(401);
  const body = (await response.json()) as { code?: string };
  expect(body.code).toBe('STEP_UP_REQUIRED');

  const stepUpModal = page.getByRole('dialog', { name: 'Confirm with your verification code' });
  await expect(stepUpModal).toBeVisible({ timeout: 10_000 });
  await expect(stepUpModal.getByRole('button', { name: 'Send code' })).toBeVisible();

  // Cancel — this suite proves the gate triggers, not that the write
  // completes (both are real money-moving primitives; completing them
  // is the money-review-gated backend integration tests' job).
  await stepUpModal.getByRole('button', { name: 'Cancel' }).click();
  await expect(stepUpModal).not.toBeVisible();
}

test.describe('admin/support dashboard smoke (Q6-5)', () => {
  test('admin: read surfaces render with seeded data; write affordances gate + step-up triggers; revoke-sessions completes', async ({
    page,
  }) => {
    await signInAs(page, ADMIN_EMAIL);

    // --- /admin: dashboard loads, admin-only nav tab is visible ---
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Admin', level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    // AdminNav.TABS: 'Staff' is admin-only (ADR 037 §3) — its presence
    // is the nav-level tier signal for this session.
    await expect(page.getByRole('link', { name: 'Staff', exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // --- A5-6: stuck-orders triage view ---
    await page.goto('/admin/stuck-orders');
    await expect(page.getByRole('heading', { name: 'Admin · Stuck orders' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(`a[title="${STUCK_ORDER_ID}"]`)).toBeVisible({ timeout: 15_000 });

    // --- A5-8: fleet-wide ledger browser — filter + pagination affordance ---
    await page.goto(`/admin/ledger?userId=${TARGET_USER_ID}`);
    await expect(page.getByRole('heading', { name: 'Admin · Ledger' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('+$2.50')).toBeVisible({ timeout: 15_000 });
    // Type-filter chip: clicking it re-runs the query scoped to
    // 'cashback' — the seeded row is cashback-typed, so it survives.
    // Scoped to role='button' — the row's own type pill also renders
    // the literal text "cashback" as a plain (non-button) span, so an
    // unscoped text query would be ambiguous.
    await page.getByRole('button', { name: 'cashback', exact: true }).click();
    await expect(page.getByRole('button', { name: 'cashback', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByText('+$2.50')).toBeVisible({ timeout: 10_000 });
    // Pagination affordance: with one matching row (< the 50 page
    // size), "Older" has nothing further to page to.
    await expect(page.getByRole('button', { name: 'Older →' })).toBeDisabled();

    // --- Orders list (read) ---
    await page.goto('/admin/orders');
    await expect(page.getByRole('heading', { name: 'Admin · Orders' })).toBeVisible({
      timeout: 15_000,
    });
    // Unlike the stuck-orders page (where `title={row.id}` sits on the
    // `<Link>` itself), the orders-list row puts `title` on the
    // wrapping `<p>` — the link's accessible name is just the
    // truncated 8-char id, which is what we match here.
    await expect(
      page.getByRole('link', { name: STUCK_ORDER_ID.slice(0, 8), exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // --- User 360: A5-7 audit timeline + A5-3 auth-state ---
    await page.goto(`/admin/users/${TARGET_USER_ID}`);
    await expect(page.getByRole('heading', { name: TARGET_EMAIL, level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    // A5-3: the seeded otp_attempt_counters row locks this user.
    await expect(page.getByText('locked', { exact: true })).toBeVisible({ timeout: 15_000 });
    // A5-7: the seeded cashback ledger row + the fulfilled/paid orders
    // both surface as timeline entries. Scoped to the audit-timeline
    // <section> (found via its heading) rather than the bare page —
    // AdminNav renders a "Ledger" nav tab on every admin page, and an
    // unscoped exact-text query would silently match that tab instead
    // of proving the timeline itself rendered the ledger event.
    const auditSection = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Audit timeline' }) });
    await expect(auditSection).toBeVisible({ timeout: 15_000 });
    await expect(auditSection.getByText('Ledger', { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(auditSection.getByText('Order', { exact: true }).first()).toBeVisible();
    // Credit balance table shows the seeded $2.50 balance. `.first()`
    // — the cashback-summary chip near the top of the page also
    // renders "$2.50" (same lifetime total, different surface).
    await expect(page.getByText('$2.50', { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    // --- A5-3: clear-OTP-lockout affordance renders for admin (not completed here) ---
    await expect(page.getByRole('button', { name: 'Clear OTP lockout' })).toBeVisible({
      timeout: 10_000,
    });

    // --- A5-2: revoke-sessions — the one write this suite completes end-to-end ---
    await page.getByRole('button', { name: 'Revoke all sessions', exact: true }).click();
    const revokeDialog = page.getByRole('dialog', { name: 'Revoke all sessions?' });
    await expect(revokeDialog).toBeVisible({ timeout: 10_000 });
    const [revokeResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/revoke-sessions') && r.request().method() === 'POST',
      ),
      revokeDialog.getByRole('button', { name: 'Revoke sessions', exact: true }).click(),
    ]);
    expect(revokeResponse.status()).toBe(200);
    await expect(
      page.getByRole('status').filter({ hasText: 'All sessions revoked for' }),
    ).toBeVisible({ timeout: 10_000 });

    // Non-vacuous follow-through: reload and confirm the revoke wrote
    // a real, durable row the audit timeline (A5-7) picks up — proves
    // the write wasn't just a client-side toast with no backend effect.
    await page.reload();
    const auditSectionAfterRevoke = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Audit timeline' }) });
    await expect(auditSectionAfterRevoke.getByText('Session', { exact: true }).first()).toBeVisible(
      { timeout: 15_000 },
    );

    // --- A5-1 / A5-4: order-detail write affordances gate + step-up triggers ---
    await page.goto(`/admin/orders/${STUCK_ORDER_ID}`);
    await expect(page.getByRole('heading', { name: 'Re-drive (A5-1)' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('heading', { name: 'Refund order (A5-4)' })).toBeVisible();

    await expectWriteTripsStepUp(page, {
      triggerButtonName: 'Re-drive order',
      dialogTitleRegex: /Reason for redriving this order\?/,
      confirmButtonName: 'Redrive',
      apiPathSegment: '/redrive',
    });

    await expectWriteTripsStepUp(page, {
      triggerButtonName: 'Refund order',
      dialogTitleRegex: /Refund this order\?/,
      confirmButtonName: 'Refund',
      apiPathSegment: '/refund',
    });
  });

  test('support: read surfaces render; admin-only writes and pages are hidden or denied', async ({
    page,
  }) => {
    await signInAs(page, SUPPORT_EMAIL);

    // --- /admin: dashboard loads, admin-only nav tab is ABSENT ---
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Admin', level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    // Wait for a support-visible tab first — `visibleTabs(null)` (role
    // still resolving) also renders zero tabs, so asserting
    // `toHaveCount(0)` on 'Staff' without first waiting for the nav to
    // actually settle would trivially pass during that transient
    // loading window regardless of whether the tier gate is broken.
    // Confirmed non-vacuous: this exact assertion was verified to fail
    // red against a deliberately broken `visibleTabs` (see PR
    // description) before this settle-first guard was added, and to
    // stay green after reverting the break.
    await expect(page.getByRole('link', { name: 'Treasury', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('link', { name: 'Staff', exact: true })).toHaveCount(0);

    // --- A5-6: stuck-orders is support-visible (the read half of the fix) ---
    await page.goto('/admin/stuck-orders');
    await expect(page.getByRole('heading', { name: 'Admin · Stuck orders' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(`a[title="${STUCK_ORDER_ID}"]`)).toBeVisible({ timeout: 15_000 });

    // --- A5-8: ledger browser is support-visible ---
    await page.goto(`/admin/ledger?userId=${TARGET_USER_ID}`);
    await expect(page.getByRole('heading', { name: 'Admin · Ledger' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('+$2.50')).toBeVisible({ timeout: 15_000 });

    // --- User 360: read renders, admin-only write affordances are gone ---
    await page.goto(`/admin/users/${TARGET_USER_ID}`);
    await expect(page.getByRole('heading', { name: TARGET_EMAIL, level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    // Same settle-first discipline as the nav-tab check above: the
    // AdminNav's 'Treasury' tab and RevokeSessionsPanel/AuthStatePanel's
    // admin-gated affordances all key off the SAME shared `['me']`
    // TanStack Query cache, so once 'Treasury' is visible, every other
    // consumer on this page has the resolved (non-transient) role too.
    await expect(page.getByRole('link', { name: 'Treasury', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    // AuthStatePanel's READ half is support-visible...
    await expect(page.getByText('locked', { exact: true })).toBeVisible({ timeout: 15_000 });
    // ...but its admin-only clear action, and the whole
    // RevokeSessionsPanel (admin-only — the panel returns null for
    // non-admin), are both absent.
    await expect(page.getByRole('button', { name: 'Clear OTP lockout' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Revoke all sessions' })).toHaveCount(0);

    // --- Order detail: read renders, redrive/refund affordances are gone ---
    await page.goto(`/admin/orders/${STUCK_ORDER_ID}`);
    // Support still sees the order itself (ADR 037: order reads are
    // support-tier) — the state pill is a deterministic read signal.
    await expect(page.getByText('paid', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    // Settle-first again — OrderRedrivePanel/RefundOrderPanel share the
    // same `['me']` cache as the nav.
    await expect(page.getByRole('link', { name: 'Treasury', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('heading', { name: 'Re-drive (A5-1)' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Refund order (A5-4)' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Re-drive order' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refund order' })).toHaveCount(0);

    // --- Admin-only page: client-side denial banner, no 500/blank page ---
    await page.goto('/admin/staff');
    await expect(
      page.getByText('Admin access required. The signed-in account does not hold the admin role.'),
    ).toBeVisible({ timeout: 15_000 });
  });
});
