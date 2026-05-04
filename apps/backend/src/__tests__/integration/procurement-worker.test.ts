/**
 * Procurement-worker integration tests on real postgres.
 *
 * The procurement worker has two concurrency-sensitive surfaces whose
 * correctness only shows up under real postgres semantics:
 *
 *   1. **Per-row claim race** — `runProcurementTick()` selects up to
 *      N paid orders and walks them through `procureOne`, whose first
 *      step is the state-guarded UPDATE in `markOrderProcuring`. Two
 *      ticks running concurrently must not double-procure any row;
 *      the loser of the UPDATE gets null and counts as `skipped`.
 *      A unit test with mocked drizzle can't exercise the actual
 *      `WHERE state = 'paid'` arbitration — only postgres can.
 *
 *   2. **Stuck-procurement sweep predicate** — `sweepStuckProcurement
 *      (cutoff)` must flip ONLY `procuring` rows whose `procuredAt`
 *      is older than the cutoff. Off-by-one bugs (`<=` vs `<`, wrong
 *      timestamp source, missing state guard) would corrupt the live
 *      queue. The sweep also runs concurrently with active workers,
 *      and the state guard on the UPDATE is the only thing keeping
 *      a sweep + a `markOrderFulfilled` from racing on the same row.
 *
 * Both scenarios are walked here against `loop_test`. Mocked: CTX
 * upstream (operatorFetch + redemption fetch), discord, merchants
 * catalog. Real: postgres + every state guard + drizzle SQL emission.
 *
 * Gated on `LOOP_E2E_DB=1` like the sibling integration suites.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

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

vi.mock('../../merchants/sync.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const stubMerchant = {
    id: 'amazon',
    name: 'Amazon',
    slug: 'amazon',
    enabled: true,
    denominations: {
      currency: 'USD',
      type: 'min-max' as const,
      denominations: [],
      min: 1,
      max: 1000,
    },
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
import { users, merchantCashbackConfigs, orders } from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { runProcurementTick } from '../../orders/procurement.js';
import { sweepStuckProcurement } from '../../orders/transitions.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';
import { operatorFetch } from '../../ctx/operator-pool.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

/**
 * Inserts the cashback config + a user, then N orders pre-pinned to
 * `paid` (the state runProcurementTick consumes from). The orders are
 * built with `paymentMethod: 'credit'` so the
 * `orders_payment_memo_coherence` CHECK passes without us threading a
 * payment_memo through every seed call.
 */
async function seedPaidOrders(n: number): Promise<{ userId: string; orderIds: string[] }> {
  await db.insert(merchantCashbackConfigs).values({
    merchantId: 'amazon',
    wholesalePct: '70.00',
    userCashbackPct: '5.00',
    loopMarginPct: '25.00',
    active: true,
    updatedBy: 'integration-test-seed',
  });

  const stellarAddress = 'GUSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const user = await findOrCreateUserByEmail('procurement-worker@test.local');
  await db.update(users).set({ homeCurrency: 'USD', stellarAddress }).where(eq(users.id, user.id));

  const orderIds: string[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const [row] = await db
      .insert(orders)
      .values({
        userId: user.id,
        merchantId: 'amazon',
        faceValueMinor: 2500n,
        currency: 'USD',
        chargeMinor: 2500n,
        chargeCurrency: 'USD',
        // 'credit' skips the orders_payment_memo_coherence CHECK that
        // requires a payment_memo for chain-paid methods.
        paymentMethod: 'credit',
        wholesalePct: '70.00',
        userCashbackPct: '5.00',
        loopMarginPct: '25.00',
        wholesaleMinor: 1750n,
        userCashbackMinor: 125n,
        loopMarginMinor: 625n,
        state: 'paid',
        paidAt: new Date(now.getTime() + i),
      })
      .returning({ id: orders.id });
    if (row === undefined) throw new Error('seed: orders insert returned no row');
    orderIds.push(row.id);
  }
  return { userId: user.id, orderIds };
}

describeIf('procurement-worker integration — concurrent claim race', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    vi.mocked(operatorFetch).mockReset();
  });

  it('two concurrent ticks pick distinct orders — no double-procure', async () => {
    // Seed 6 paid orders; run two concurrent ticks each with limit=6.
    // The state-guarded UPDATE in `markOrderProcuring` is the only
    // thing keeping both ticks from procuring the same row. Without
    // it, postgres would let both UPDATEs land and the second
    // `markOrderFulfilled` would race.
    const { orderIds } = await seedPaidOrders(6);

    // Mock CTX to return a unique id per call — 12 ids cover the
    // worst case (both ticks fully draining the queue, which can't
    // happen but the slack is fine).
    let ctxCounter = 0;
    vi.mocked(operatorFetch).mockImplementation(async () => {
      ctxCounter += 1;
      return new Response(JSON.stringify({ id: `ctx-test-order-${ctxCounter}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const [tickA, tickB] = await Promise.all([
      runProcurementTick({ limit: 6 }),
      runProcurementTick({ limit: 6 }),
    ]);

    // Total fulfilled across both ticks must equal exactly the seed
    // count — no double-procure, no missed row.
    expect(tickA.fulfilled + tickB.fulfilled).toBe(orderIds.length);
    expect(tickA.failed + tickB.failed).toBe(0);

    // Each order must be in `fulfilled` state with a unique
    // ctx_order_id. If two ticks raced on a row, the second
    // `markOrderProcuring` returns null → `skipped` and the row would
    // still have one ctx_order_id, but the failure mode we're really
    // catching is "both ticks pass the guard and both run procureOne".
    const finalRows = await db
      .select({ id: orders.id, state: orders.state, ctxOrderId: orders.ctxOrderId })
      .from(orders);
    expect(finalRows.length).toBe(orderIds.length);
    for (const row of finalRows) {
      expect(row.state).toBe('fulfilled');
      expect(row.ctxOrderId).toMatch(/^ctx-test-order-\d+$/);
    }
    const ctxIds = finalRows.map((r) => r.ctxOrderId);
    expect(new Set(ctxIds).size).toBe(ctxIds.length);
  });

  it('runProcurementTick is FIFO by paid_at across ticks', async () => {
    // The batch driver orders by `asc(paidAt)` so an incident backlog
    // drains oldest-first — the user who waited longest is fulfilled
    // first. Verify with 3 orders whose paid_at values are seeded in
    // reverse order.
    const { userId } = await seedPaidOrders(0);
    const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
    const expected: string[] = [];
    for (let i = 0; i < 3; i++) {
      // Seed in reverse paid_at order — newest first, so the natural
      // insertion order doesn't accidentally satisfy the assertion.
      const paidAt = new Date(baseTime + (2 - i) * 1000);
      const [row] = await db
        .insert(orders)
        .values({
          userId,
          merchantId: 'amazon',
          faceValueMinor: 1000n,
          currency: 'USD',
          chargeMinor: 1000n,
          chargeCurrency: 'USD',
          paymentMethod: 'credit',
          wholesalePct: '70.00',
          userCashbackPct: '5.00',
          loopMarginPct: '25.00',
          wholesaleMinor: 700n,
          userCashbackMinor: 50n,
          loopMarginMinor: 250n,
          state: 'paid',
          paidAt,
        })
        .returning({ id: orders.id });
      if (row === undefined) throw new Error('seed: orders insert returned no row');
      // Push at index = the order's paid-time rank (oldest first).
      expected[2 - i] = row.id;
    }

    const fetchOrder: string[] = [];
    let ctxCounter = 0;
    vi.mocked(operatorFetch).mockImplementation(async (...args: unknown[]) => {
      ctxCounter += 1;
      // Inspect the URL the worker is fetching — the order id isn't
      // in the URL but the fetch order itself is observable through
      // the call ordering. Capture it via a side-channel on the
      // current paid-not-yet-procuring rows.
      const [row] = await db
        .select({ id: orders.id, paidAt: orders.paidAt })
        .from(orders)
        .where(eq(orders.state, 'procuring'))
        .orderBy(sql`${orders.procuredAt} DESC`)
        .limit(1);
      if (row !== undefined) fetchOrder.push(row.id);
      void args;
      return new Response(JSON.stringify({ id: `ctx-fifo-${ctxCounter}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const tick = await runProcurementTick({ limit: 5 });
    expect(tick.fulfilled).toBe(3);
    expect(fetchOrder).toEqual(expected);
  });
});

describeIf('procurement-worker integration — stuck-procurement sweep', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  /**
   * Inserts an order pre-flipped to `state` with the supplied
   * `procuredAt`. Skips the cashback-config seed — the sweep doesn't
   * read it.
   */
  async function seedOrderInState(args: {
    userId: string;
    state: 'paid' | 'procuring' | 'fulfilled';
    procuredAt: Date | null;
  }): Promise<string> {
    const [row] = await db
      .insert(orders)
      .values({
        userId: args.userId,
        merchantId: 'amazon',
        faceValueMinor: 2500n,
        currency: 'USD',
        chargeMinor: 2500n,
        chargeCurrency: 'USD',
        paymentMethod: 'credit',
        wholesalePct: '70.00',
        userCashbackPct: '5.00',
        loopMarginPct: '25.00',
        wholesaleMinor: 1750n,
        userCashbackMinor: 125n,
        loopMarginMinor: 625n,
        state: args.state,
        paidAt: args.procuredAt ?? new Date(),
        procuredAt: args.procuredAt,
        ctxOperatorId: args.state === 'procuring' ? 'pool' : null,
      })
      .returning({ id: orders.id });
    if (row === undefined) throw new Error('seed: orders insert returned no row');
    return row.id;
  }

  it('flips only stale procuring rows — leaves recent + paid + fulfilled untouched', async () => {
    const user = await findOrCreateUserByEmail('sweep@test.local');

    const cutoff = new Date('2026-01-01T01:00:00Z');
    // Stale: procuredAt 30 min before cutoff → should sweep.
    const staleId = await seedOrderInState({
      userId: user.id,
      state: 'procuring',
      procuredAt: new Date(cutoff.getTime() - 30 * 60 * 1000),
    });
    // Recent: procuredAt 5 min AFTER cutoff → should NOT sweep.
    const recentId = await seedOrderInState({
      userId: user.id,
      state: 'procuring',
      procuredAt: new Date(cutoff.getTime() + 5 * 60 * 1000),
    });
    // Paid (no procuredAt) — outside the sweep's WHERE entirely.
    const paidId = await seedOrderInState({
      userId: user.id,
      state: 'paid',
      procuredAt: null,
    });
    // Fulfilled — terminal, must never be touched.
    const fulfilledId = await seedOrderInState({
      userId: user.id,
      state: 'fulfilled',
      procuredAt: new Date(cutoff.getTime() - 60 * 60 * 1000),
    });

    const swept = await sweepStuckProcurement(cutoff);
    expect(swept).toBe(1);

    const [stale] = await db.select().from(orders).where(eq(orders.id, staleId));
    expect(stale!.state).toBe('failed');
    expect(stale!.failureReason).toBe('procurement_timeout');
    expect(stale!.failedAt).not.toBeNull();

    const [recent] = await db.select().from(orders).where(eq(orders.id, recentId));
    expect(recent!.state).toBe('procuring');
    expect(recent!.failureReason).toBeNull();

    const [paid] = await db.select().from(orders).where(eq(orders.id, paidId));
    expect(paid!.state).toBe('paid');

    const [fulfilled] = await db.select().from(orders).where(eq(orders.id, fulfilledId));
    expect(fulfilled!.state).toBe('fulfilled');
  });

  it('idempotent — second sweep over the same cutoff is a no-op', async () => {
    const user = await findOrCreateUserByEmail('sweep-idempotent@test.local');
    const cutoff = new Date('2026-01-01T01:00:00Z');
    await seedOrderInState({
      userId: user.id,
      state: 'procuring',
      procuredAt: new Date(cutoff.getTime() - 30 * 60 * 1000),
    });

    const first = await sweepStuckProcurement(cutoff);
    expect(first).toBe(1);

    // Second sweep: row is now `failed`, the state guard rejects it.
    const second = await sweepStuckProcurement(cutoff);
    expect(second).toBe(0);
  });
});
