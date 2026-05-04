/**
 * Phase-mode toggle integration test on real postgres.
 *
 * Proves the `LOOP_PHASE_1_ONLY` flag-flip is safe by walking the
 * same order lifecycle in BOTH modes and asserting the documented
 * divergence:
 *
 *   - Phase 1 (`LOOP_PHASE_1_ONLY=true`):
 *       chargeMinor = requestedChargeMinor − cashback
 *       order.userCashbackMinor = 0
 *       fulfillment writes NO `pending_payouts` row
 *       fulfillment writes NO `credit_transactions` cashback row
 *
 *   - Phase 2 (`LOOP_PHASE_1_ONLY=false`):
 *       chargeMinor = requestedChargeMinor (no discount)
 *       order.userCashbackMinor = configured share
 *       fulfillment writes one `pending_payouts` row
 *       fulfillment writes one `credit_transactions` cashback row
 *
 * The flywheel suite covers Phase 2 alone (env defaults to false).
 * Repo unit tests cover both modes at the function-call level.
 * Neither catches a bug where the txn ladder in `markOrderFulfilled`
 * conditionally inserts a payout intent under one mode and not the
 * other — only a real-postgres walk does. Adding that walk here is
 * the load-bearing assertion before flipping the production flag.
 *
 * Gated on `LOOP_E2E_DB=1` like the sibling integration suites.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

vi.mock('../../ctx/operator-pool.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, operatorFetch: vi.fn() };
});

vi.mock('../../orders/procurement-redemption.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, fetchRedemption: vi.fn(async () => ({ code: 'TEST-CODE', pin: '1234' })) };
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
  orders,
  pendingPayouts,
  creditTransactions,
  merchantCashbackConfigs,
} from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { signLoopToken, DEFAULT_ACCESS_TTL_SECONDS } from '../../auth/tokens.js';
import { app } from '../../app.js';
import { env } from '../../env.js';
import { markOrderPaid } from '../../orders/transitions.js';
import { runProcurementTick } from '../../orders/procurement.js';
import { operatorFetch } from '../../ctx/operator-pool.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

const STELLAR_FIXTURE_ADDRESS = 'GUSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

async function seedAmazonCashbackConfig(): Promise<void> {
  await db.insert(merchantCashbackConfigs).values({
    merchantId: 'amazon',
    wholesalePct: '70.00',
    userCashbackPct: '5.00',
    loopMarginPct: '25.00',
    active: true,
    updatedBy: 'phase-mode-test-seed',
  });
}

async function seedUserWithStellar(email: string): Promise<{ id: string; bearer: string }> {
  const user = await findOrCreateUserByEmail(email);
  await db
    .update(users)
    .set({ homeCurrency: 'USD', stellarAddress: STELLAR_FIXTURE_ADDRESS })
    .where(eq(users.id, user.id));
  const access = signLoopToken({
    sub: user.id,
    email: user.email,
    typ: 'access',
    ttlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
  });
  return { id: user.id, bearer: access.token };
}

async function placeOrderAndFulfil(args: {
  userBearer: string;
  ctxOrderId: string;
}): Promise<string> {
  const createRes = await app.request('http://localhost/api/orders/loop', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.userBearer}`,
    },
    body: JSON.stringify({
      merchantId: 'amazon',
      amountMinor: 2500, // $25 → 5% cashback = $1.25 = 125 minor
      currency: 'USD',
      paymentMethod: 'xlm',
    }),
  });
  expect(createRes.status).toBe(200);
  const { orderId } = (await createRes.json()) as { orderId: string };

  await markOrderPaid(orderId);

  vi.mocked(operatorFetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ id: args.ctxOrderId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const tick = await runProcurementTick({ limit: 5 });
  expect(tick.fulfilled).toBe(1);
  expect(tick.failed).toBe(0);
  return orderId;
}

describeIf('phase-mode toggle — full order walk diverges as documented', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    vi.clearAllMocks();
  });

  it('Phase 1 (`LOOP_PHASE_1_ONLY=true`): discount applied, no payout intent, no cashback ledger row', async () => {
    const previous = env.LOOP_PHASE_1_ONLY;
    env.LOOP_PHASE_1_ONLY = true;
    try {
      await seedAmazonCashbackConfig();
      const me = await seedUserWithStellar('phase1@test.local');
      const orderId = await placeOrderAndFulfil({
        userBearer: me.bearer,
        ctxOrderId: 'ctx-phase1',
      });

      const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(order!.state).toBe('fulfilled');
      // 2500 face value − 125 cashback (5%) = 2375 chargeMinor; userCashbackMinor 0.
      expect(order!.faceValueMinor).toBe(2500n);
      expect(order!.chargeMinor).toBe(2375n);
      expect(order!.userCashbackMinor).toBe(0n);

      // No pending_payouts row — the fulfillment txn skips the insert
      // when userCashbackMinor=0.
      const payouts = await db
        .select()
        .from(pendingPayouts)
        .where(eq(pendingPayouts.orderId, orderId));
      expect(payouts).toHaveLength(0);

      // No cashback credit_transactions row either — the same gate
      // skips the ledger write so the on-chain emission is fully off.
      const txs = await db
        .select()
        .from(creditTransactions)
        .where(eq(creditTransactions.userId, me.id));
      expect(txs).toHaveLength(0);
    } finally {
      env.LOOP_PHASE_1_ONLY = previous;
    }
  });

  it('Phase 2 (`LOOP_PHASE_1_ONLY=false`): no discount, payout intent + cashback ledger row written', async () => {
    const previous = env.LOOP_PHASE_1_ONLY;
    env.LOOP_PHASE_1_ONLY = false;
    try {
      await seedAmazonCashbackConfig();
      const me = await seedUserWithStellar('phase2@test.local');
      const orderId = await placeOrderAndFulfil({
        userBearer: me.bearer,
        ctxOrderId: 'ctx-phase2',
      });

      const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(order!.state).toBe('fulfilled');
      // No discount; charge equals face value, cashback emission armed.
      expect(order!.chargeMinor).toBe(2500n);
      expect(order!.userCashbackMinor).toBe(125n);

      // Exactly one pending_payouts row, in `pending` state, addressed
      // at the user's linked wallet.
      const payouts = await db
        .select()
        .from(pendingPayouts)
        .where(eq(pendingPayouts.orderId, orderId));
      expect(payouts).toHaveLength(1);
      expect(payouts[0]!.state).toBe('pending');
      expect(payouts[0]!.toAddress).toBe(STELLAR_FIXTURE_ADDRESS);
      expect(payouts[0]!.amountStroops).toBe(125n * 100_000n);

      // One cashback credit_transactions row.
      const txs = await db
        .select()
        .from(creditTransactions)
        .where(eq(creditTransactions.userId, me.id));
      expect(txs).toHaveLength(1);
      expect(txs[0]!.type).toBe('cashback');
      expect(txs[0]!.amountMinor).toBe(125n);
      expect(txs[0]!.referenceId).toBe(orderId);
    } finally {
      env.LOOP_PHASE_1_ONLY = previous;
    }
  });

  it('flipping back-to-back across two orders by the same user produces the divergent shapes', async () => {
    // Walks one order in each mode through the SAME user account so a
    // bug where the Phase-1 path leaves residue (e.g. a stale payout
    // intent) that the Phase-2 path picks up would surface here.
    await seedAmazonCashbackConfig();
    const me = await seedUserWithStellar('phase-flip@test.local');

    const previous = env.LOOP_PHASE_1_ONLY;
    try {
      env.LOOP_PHASE_1_ONLY = true;
      const phase1OrderId = await placeOrderAndFulfil({
        userBearer: me.bearer,
        ctxOrderId: 'ctx-flip-p1',
      });

      env.LOOP_PHASE_1_ONLY = false;
      const phase2OrderId = await placeOrderAndFulfil({
        userBearer: me.bearer,
        ctxOrderId: 'ctx-flip-p2',
      });

      const phase1Payouts = await db
        .select()
        .from(pendingPayouts)
        .where(eq(pendingPayouts.orderId, phase1OrderId));
      expect(phase1Payouts).toHaveLength(0);

      const phase2Payouts = await db
        .select()
        .from(pendingPayouts)
        .where(eq(pendingPayouts.orderId, phase2OrderId));
      expect(phase2Payouts).toHaveLength(1);

      // The user's ledger only carries the Phase-2 cashback row;
      // the Phase-1 order didn't write one.
      const txs = await db
        .select()
        .from(creditTransactions)
        .where(eq(creditTransactions.userId, me.id));
      expect(txs).toHaveLength(1);
      expect(txs[0]!.referenceId).toBe(phase2OrderId);
    } finally {
      env.LOOP_PHASE_1_ONLY = previous;
    }
  });
});
