/**
 * Flywheel integration test (A2-1705 phase A.1).
 *
 * Walks the cashback-flywheel happy path through the real backend
 * stack — Hono routing, real postgres (loop_test), real schema
 * (CHECK constraints + partial unique indexes + triggers from
 * migrations 0000-NNNN), real drizzle SQL emission, real txn
 * semantics inside `markOrderFulfilled`. Catches the class of bugs
 * Phase 6.5 of the audit found empirically (A2-610/611/700) that
 * static reads + per-handler mocks couldn't.
 *
 * Walk:
 *   1. Seed merchant + cashback-config (numeric DB row, real
 *      `merchant_cashback_config_history` trigger fires).
 *   2. Create user via `findOrCreateUserByEmail` (idempotent insert
 *      against the unique index).
 *   3. Mint a Loop-signed access JWT (real signLoopToken).
 *   4. POST /api/orders/loop {xlm} via `app.request()` — exercises
 *      Hono routing + middleware + handler + the cashback-split
 *      pinning in `repo.createOrder`.
 *   5. Mark the order paid (simulating the payment watcher).
 *   6. Drive `runProcurementTick()` with mocked CTX upstream +
 *      mocked redemption fetch. Asserts: order → fulfilled,
 *      credit_transactions row written (CHECK constraint passes),
 *      user_credits balance bumped, pending_payouts row inserted.
 *
 * What's mocked:
 *   - `operatorFetch` (CTX gift-card POST + GET)
 *   - `fetchRedemption` (CTX gift-card detail re-read)
 *   - `getMerchants` (in-memory catalog — would otherwise require
 *     the merchants sync worker to have run)
 *   - Discord notifiers (fire-and-forget; test doesn't assert on
 *     them)
 *
 * What's REAL:
 *   - Postgres + every CHECK constraint + every trigger
 *   - Drizzle ORM SQL emission for every read + write
 *   - The transactional ladder in `markOrderFulfilled`
 *   - The cashback-split pinning math in `repo.createOrder`
 *   - Hono routing + middleware (auth, rate-limit, body-limit)
 *   - JWT minting + verification
 *
 * Gated on `LOOP_E2E_DB=1` so the standard unit-test run skips it.
 * Run via `npm run test:integration -w @loop/backend` (also requires
 * `docker compose up -d db` locally; CI uses a postgres service
 * container).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

// Mock the upstream-CTX seam BEFORE importing app.ts so the bound
// reference inside the procurement worker is the mock from the start.
vi.mock('../../ctx/operator-pool.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    operatorFetch: vi.fn(),
  };
});

vi.mock('../../orders/procurement-redemption.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    fetchRedemption: vi.fn(async () => ({ code: 'TEST-CODE-12345', pin: '1234' })),
  };
});

// Stub the merchants in-memory store so the order handler resolves
// the test merchant without running the CTX sync.
vi.mock('../../merchants/sync.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const stubMerchant = {
    id: 'amazon',
    name: 'Amazon',
    slug: 'amazon',
    enabled: true,
    denominations: { currency: 'USD', kind: 'min-max' as const, min: 1, max: 1000 },
    logo: null,
    locations: [],
  };
  return {
    ...actual,
    getMerchants: vi.fn(() => ({
      merchants: [stubMerchant],
      merchantsById: new Map([[stubMerchant.id, stubMerchant]]),
      merchantsBySlug: new Map([[stubMerchant.slug, stubMerchant]]),
      loadedAt: Date.now(),
    })),
  };
});

// Discord notifiers — fire-and-forget, no DB side effect; mocking
// keeps test logs quiet without affecting the assertions.
vi.mock('../../discord.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const noop = vi.fn();
  return {
    ...actual,
    notifyOrderCreated: noop,
    notifyOrderFulfilled: noop,
    notifyCashbackCredited: noop,
    notifyCashbackRecycled: noop,
    notifyFirstCashbackRecycled: noop,
    notifyAdminAudit: noop,
    notifyCashbackConfigChanged: noop,
    notifyAssetDrift: noop,
    notifyAssetDriftRecovered: noop,
    notifyCircuitBreaker: noop,
    notifyOperatorPoolExhausted: noop,
    notifyCtxSchemaDrift: noop,
    notifyHealthChange: noop,
    notifyPayoutFailed: noop,
    notifyStuckProcurementSwept: noop,
    notifyPaymentWatcherStuck: noop,
    notifyUsdcBelowFloor: noop,
    notifyAdminBulkRead: noop,
  };
});

import { db } from '../../db/client.js';
import {
  users,
  merchantCashbackConfigs,
  orders,
  creditTransactions,
  userCredits,
  pendingPayouts,
} from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { signLoopToken, DEFAULT_ACCESS_TTL_SECONDS } from '../../auth/tokens.js';
import { markOrderPaid } from '../../orders/transitions.js';
import { runProcurementTick } from '../../orders/procurement.js';
import { app } from '../../app.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';
import { operatorFetch } from '../../ctx/operator-pool.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

describeIf('flywheel integration — XLM order → fulfilment → cashback credited', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    vi.mocked(operatorFetch).mockReset();
  });

  afterAll(async () => {
    // Vitest with singleFork keeps the process alive between files;
    // tearDown is a no-op here because the postgres pool gets reused
    // by any sibling integration suite that lands later.
  });

  it('walks signup → XLM order → procurement → cashback ledger + payout intent', async () => {
    // ─── Seed the cashback config the order will pin against ──────────
    await db.insert(merchantCashbackConfigs).values({
      merchantId: 'amazon',
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      active: true,
      updatedBy: 'integration-test-seed',
    });

    // ─── Create user (also gives them a Stellar wallet so the
    //     ADR-015 payout intent fires on cashback). ─────────────────────
    // Fixture user wallet — exactly 56 chars (G + 55 base32) so the
    // STELLAR_PUBKEY_REGEX accepts it. Never broadcast to.
    const stellarAddress = 'GUSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const user = await findOrCreateUserByEmail('flywheel@test.local');
    await db
      .update(users)
      .set({ homeCurrency: 'USD', stellarAddress })
      .where(eq(users.id, user.id));

    // ─── Mint a Loop-signed access token. The auth middleware in
    //     `app.ts` verifies the signature + writes `auth.userId` to
    //     the request context, so this exercises the real signLoopToken
    //     + verifyLoopToken pair. ────────────────────────────────────────
    const access = signLoopToken({
      sub: user.id,
      email: user.email,
      typ: 'access',
      ttlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
    });

    // ─── POST /api/orders/loop with XLM payment method ────────────────
    const createRes = await app.request('http://localhost/api/orders/loop', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${access.token}`,
      },
      body: JSON.stringify({
        merchantId: 'amazon',
        amountMinor: 2500, // $25
        currency: 'USD',
        paymentMethod: 'xlm',
      }),
    });
    expect(createRes.status).toBe(200);
    const createBody = (await createRes.json()) as {
      orderId: string;
      payment: { method: string; memo: string };
    };
    expect(createBody.payment.method).toBe('xlm');
    expect(createBody.payment.memo).toBeTruthy();

    // ─── Assert the order row landed with cashback split pinned ────────
    const [orderRow] = await db.select().from(orders).where(eq(orders.id, createBody.orderId));
    expect(orderRow).toBeDefined();
    expect(orderRow!.state).toBe('pending_payment');
    expect(orderRow!.merchantId).toBe('amazon');
    expect(orderRow!.faceValueMinor).toBe(2500n);
    // Cashback split: 5% of $25 = $1.25 = 125 minor units. Pinned
    // at order-create time even if the merchant's config changes
    // later (ADR 011).
    expect(orderRow!.userCashbackMinor).toBe(125n);
    expect(orderRow!.wholesaleMinor).toBe(1750n); // 70% of 2500
    expect(orderRow!.loopMarginMinor).toBe(625n); // 25% of 2500

    // ─── Simulate the payment watcher seeing the deposit ──────────────
    const paid = await markOrderPaid(orderRow!.id);
    expect(paid).not.toBeNull();
    expect(paid!.state).toBe('paid');

    // ─── Procurement tick. Stub CTX upstream calls. ───────────────────
    vi.mocked(operatorFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'ctx-test-order-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const tickResult = await runProcurementTick({ limit: 5 });
    expect(tickResult.fulfilled).toBe(1);
    expect(tickResult.failed).toBe(0);

    // ─── Verify the multi-table txn in markOrderFulfilled landed ──────
    const [fulfilledRow] = await db.select().from(orders).where(eq(orders.id, orderRow!.id));
    expect(fulfilledRow!.state).toBe('fulfilled');
    expect(fulfilledRow!.ctxOrderId).toBe('ctx-test-order-1');
    expect(fulfilledRow!.fulfilledAt).not.toBeNull();

    // credit_transactions row — type='cashback', positive amount,
    // CHECK constraint `credit_transactions_amount_sign` passes
    // because cashback>0 is required. The audit's A2-610 / A2-611
    // empirical findings live in this exact write path.
    const txRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, user.id));
    expect(txRows.length).toBe(1);
    const tx = txRows[0]!;
    expect(tx.type).toBe('cashback');
    expect(tx.amountMinor).toBe(125n);
    expect(tx.currency).toBe('USD');
    expect(tx.referenceType).toBe('order');
    expect(tx.referenceId).toBe(fulfilledRow!.id);

    // user_credits balance — upserted on first cashback (this is
    // the user's first ledger row) so the row should equal exactly
    // the cashback amount.
    const [creditRow] = await db.select().from(userCredits).where(eq(userCredits.userId, user.id));
    expect(creditRow).toBeDefined();
    expect(creditRow!.balanceMinor).toBe(125n);
    expect(creditRow!.currency).toBe('USD');

    // pending_payouts intent row — ADR 015, written inside the
    // same txn as the ledger entry. Order id is on the row so
    // reconciliation can join back.
    const payoutRows = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.orderId, fulfilledRow!.id));
    expect(payoutRows.length).toBe(1);
    const payout = payoutRows[0]!;
    expect(payout.userId).toBe(user.id);
    expect(payout.state).toBe('pending');
    expect(payout.toAddress).toBe(stellarAddress);
    // Stroops = minor × 1e5 (1:1 fiat-pegged LOOP asset, 7 decimals).
    expect(payout.amountStroops).toBe(125n * 100_000n);
  });

  it('zero-cashback order still fulfils but writes no ledger row', async () => {
    // Same setup, but with a zero user cashback pct so the
    // CHECK-constraint-protected ledger write is skipped.
    await db.insert(merchantCashbackConfigs).values({
      merchantId: 'amazon',
      wholesalePct: '95.00',
      userCashbackPct: '0.00',
      loopMarginPct: '5.00',
      active: true,
      updatedBy: 'integration-test-seed',
    });

    const user = await findOrCreateUserByEmail('zero-cashback@test.local');
    const access = signLoopToken({
      sub: user.id,
      email: user.email,
      typ: 'access',
      ttlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
    });

    const createRes = await app.request('http://localhost/api/orders/loop', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${access.token}`,
      },
      body: JSON.stringify({
        merchantId: 'amazon',
        amountMinor: 1000,
        currency: 'USD',
        paymentMethod: 'xlm',
      }),
    });
    expect(createRes.status).toBe(200);
    const createBody = (await createRes.json()) as { orderId: string };

    await markOrderPaid(createBody.orderId);

    vi.mocked(operatorFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'ctx-test-order-zero' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const tickResult = await runProcurementTick({ limit: 5 });
    expect(tickResult.fulfilled).toBe(1);

    // Order fulfilled but no ledger row — `markOrderFulfilled` skips
    // the credit_transactions insert when userCashbackMinor=0 because
    // a zero-amount row would fail the `_amount_sign` CHECK. Verifies
    // the conditional in the txn ladder.
    const txCountResult = await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM credit_transactions WHERE user_id = ${user.id}`,
    );
    expect((txCountResult as unknown as Array<{ c: number }>)[0]!.c).toBe(0);
  });
});
