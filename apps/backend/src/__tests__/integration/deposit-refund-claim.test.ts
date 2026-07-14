/**
 * Real-postgres integration test for the A6 refund CAS predicate.
 * The unit suite mocks the DB, so the money-critical claim WHERE —
 * `status='abandoned' OR (status='refunding' AND updated_at < NOW() -
 * 5min)` — and the concurrency of two racing claims are only exercised
 * here. This predicate is what makes the stale-reclaim safe (a fresh
 * refunding row is NOT re-claimed; a >5-min-stale one IS).
 *
 * INV-8 cross-check (money review 2026-07-08): the claim is now a
 * transaction that locks the bound order row FOR UPDATE and refuses
 * `'credit_refunded'` when a mirror-credit refund already exists for
 * the order this deposit paid. That serialization against
 * `applyAdminRefund` (which holds the same lock while inserting its
 * credit row) is real-Postgres-only behavior, so the race lives here.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  creditTransactions,
  orders,
  paymentWatcherSkips,
  userCredits,
  users,
} from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import {
  ensureMigrated,
  truncateAllTables,
  seedUserCreditsWithBackingLedger,
} from './db-test-setup.js';
import { claimForRefund } from '../../payments/deposit-refund.js';
import {
  applyAdminRefund,
  applyOrderAutoRefund,
  AUTO_REFUND_SYSTEM_ACTOR,
  RefundAlreadyIssuedError,
} from '../../credits/refunds.js';
import { DailyAdjustmentLimitError } from '../../credits/adjustments.js';
import { env } from '../../env.js';

const PAYMENT = { id: 'op-1', type: 'payment', from: 'GSENDER', amount: '1.0000000' };

async function insertSkip(
  status: string,
  updatedAt: Date,
  orderId: string | null = null,
): Promise<void> {
  await db.insert(paymentWatcherSkips).values({
    paymentId: 'op-1',
    memo: 'MEMO',
    reason: 'processing_error',
    payment: PAYMENT,
    status: status as 'abandoned' | 'refunding',
    updatedAt,
    ...(orderId !== null ? { orderId } : {}),
  });
}

async function statusOf(): Promise<string> {
  const [row] = await db
    .select({ status: paymentWatcherSkips.status })
    .from(paymentWatcherSkips)
    .where(sql`${paymentWatcherSkips.paymentId} = 'op-1'`);
  return row!.status;
}

/** Seed a failed xlm order whose paying deposit is (or is not) op-1. */
async function seedFailedOrder(payingId: string | null): Promise<{
  userId: string;
  orderId: string;
}> {
  const user = await findOrCreateUserByEmail(`claim-${Date.now()}-${Math.random()}@test.local`);
  await db.update(users).set({ homeCurrency: 'USD' }).where(eq(users.id, user.id));
  const [row] = await db
    .insert(orders)
    .values({
      userId: user.id,
      merchantId: 'amazon',
      faceValueMinor: 2500n,
      currency: 'USD',
      chargeMinor: 2500n,
      chargeCurrency: 'USD',
      paymentMethod: 'xlm',
      paymentMemo: 'MEMO',
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      wholesaleMinor: 1750n,
      userCashbackMinor: 125n,
      loopMarginMinor: 625n,
      state: 'failed',
      ...(payingId !== null ? { paymentReceivedHorizonId: payingId } : {}),
    })
    .returning({ id: orders.id });
  if (row === undefined) throw new Error('seed: orders insert returned no row');
  return { userId: user.id, orderId: row.id };
}

async function insertCreditRefund(userId: string, orderId: string): Promise<void> {
  // Models "this order was already refunded as credit": a +2500 refund
  // ledger row AND the +2500 balance it credited. DAT-01-inv1 (migration
  // 0066): both sides land in ONE transaction so the deferred mirror
  // trigger sees an equal mirror at commit (a lone refund ledger row with
  // no balance move was the one-sided drift it now rejects).
  await seedUserCreditsWithBackingLedger(db, {
    userId,
    currency: 'USD',
    balanceMinor: 2500n,
    type: 'refund',
    reason: null,
    referenceType: 'order',
    referenceId: orderId,
  });
}

beforeAll(async () => {
  await ensureMigrated();
});
beforeEach(async () => {
  await truncateAllTables();
});

describe('claimForRefund (A6 CAS predicate)', () => {
  it('claims an abandoned row (abandoned → refunding)', async () => {
    await insertSkip('abandoned', new Date());
    expect(await claimForRefund('op-1')).toBe('claimed');
    expect(await statusOf()).toBe('refunding');
  });

  it('does NOT re-claim a FRESH refunding row', async () => {
    await insertSkip('refunding', new Date()); // just now
    expect(await claimForRefund('op-1')).toBe('lost');
    expect(await statusOf()).toBe('refunding');
  });

  it('DOES re-claim a STALE refunding row (>5min old)', async () => {
    await insertSkip('refunding', new Date(Date.now() - 6 * 60 * 1000));
    expect(await claimForRefund('op-1')).toBe('claimed');
    expect(await statusOf()).toBe('refunding');
  });

  it('two concurrent claims: exactly one wins', async () => {
    await insertSkip('abandoned', new Date());
    const [a, b] = await Promise.all([claimForRefund('op-1'), claimForRefund('op-1')]);
    expect([a, b].filter((r) => r === 'claimed')).toHaveLength(1);
  });

  it('never claims a refunded or resolved row', async () => {
    await insertSkip('refunded', new Date(Date.now() - 60 * 60 * 1000));
    expect(await claimForRefund('op-1')).toBe('lost');
  });
});

describe('claimForRefund — INV-8 credit-refund exclusion (real FOR UPDATE)', () => {
  it("refuses the claim when the deposit's order was already refunded as credit", async () => {
    const { userId, orderId } = await seedFailedOrder('op-1');
    await insertSkip('abandoned', new Date(), orderId);
    await insertCreditRefund(userId, orderId);

    expect(await claimForRefund('op-1')).toBe('credit_refunded');
    expect(await statusOf()).toBe('abandoned');
  });

  it('refuses via the reverse paying-id lookup when the skip row has orderId=NULL', async () => {
    const { userId, orderId } = await seedFailedOrder('op-1');
    await insertSkip('abandoned', new Date(), null);
    await insertCreditRefund(userId, orderId);

    expect(await claimForRefund('op-1')).toBe('credit_refunded');
    expect(await statusOf()).toBe('abandoned');
  });

  it('still claims a DUPLICATE deposit (paying id differs) despite a credit refund', async () => {
    const { userId, orderId } = await seedFailedOrder('op-OTHER');
    await insertSkip('abandoned', new Date(), orderId);
    await insertCreditRefund(userId, orderId);

    expect(await claimForRefund('op-1')).toBe('claimed');
  });

  it('racing applyAdminRefund vs claimForRefund: exactly one refund path wins', async () => {
    const { userId, orderId } = await seedFailedOrder('op-1');
    await insertSkip('abandoned', new Date(), orderId);

    const [adminOutcome, claimOutcome] = await Promise.all([
      applyAdminRefund({
        userId,
        currency: 'USD',
        amountMinor: 2500n,
        orderId,
        adminUserId: 'admin-race-test',
      }).then(
        () => 'refunded' as const,
        (err: unknown) => {
          if (err instanceof RefundAlreadyIssuedError) return 'blocked' as const;
          throw err;
        },
      ),
      claimForRefund('op-1'),
    ]);

    // Whichever writer commits first is visible to the other under the
    // order-row lock: admin wins → claim refuses; claim wins → admin
    // throws RefundAlreadyIssuedError. Never both, never neither.
    const adminWon = adminOutcome === 'refunded';
    const claimWon = claimOutcome === 'claimed';
    expect([adminWon, claimWon].filter(Boolean)).toHaveLength(1);
    if (adminWon) expect(claimOutcome).toBe('credit_refunded');
    if (claimWon) expect(adminOutcome).toBe('blocked');
  });
});

describe('applyAdminRefund — same-path concurrency (A5-4 P2)', () => {
  it('two concurrent applyAdminRefund calls for the SAME order: exactly one succeeds, the other is blocked', async () => {
    // A5-4 money-review P2: the order-refund handler's own race test
    // (order-refund.test.ts) only simulates the CAS-miss outcome
    // against a mocked DB. The real guard is two-layered — the
    // `orders` row FOR UPDATE lock inside applyAdminRefund serializes
    // concurrent callers for the same order, and whichever loses the
    // lock then hits migration 0013's partial unique index
    // (`credit_transactions_reference_unique`) on its own INSERT,
    // mapped to RefundAlreadyIssuedError via `isUniqueViolation`. Only
    // a real Postgres proves the lock + unique index actually
    // serialize two genuinely-concurrent admin-refund callers (e.g.
    // two operators double-clicking, or a retried request racing the
    // original) rather than double-crediting the user.
    const { userId, orderId } = await seedFailedOrder(null);

    const refundOnce = (): Promise<'refunded' | 'blocked'> =>
      applyAdminRefund({
        userId,
        currency: 'USD',
        amountMinor: 2500n,
        orderId,
        adminUserId: 'admin-race-test',
      }).then(
        () => 'refunded' as const,
        (err: unknown) => {
          if (err instanceof RefundAlreadyIssuedError) return 'blocked' as const;
          throw err;
        },
      );

    const [a, b] = await Promise.all([refundOnce(), refundOnce()]);

    expect([a, b].filter((r) => r === 'refunded')).toHaveLength(1);
    expect([a, b].filter((r) => r === 'blocked')).toHaveLength(1);

    // The ledger carries exactly one refund row for this order, for
    // exactly the charged amount — never a double-credit.
    const refundRows = await db
      .select({ amountMinor: creditTransactions.amountMinor })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.type, 'refund'),
          eq(creditTransactions.referenceType, 'order'),
          eq(creditTransactions.referenceId, orderId),
        ),
      );
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]?.amountMinor).toBe(2500n);

    const [balance] = await db
      .select({ balanceMinor: userCredits.balanceMinor })
      .from(userCredits)
      .where(and(eq(userCredits.userId, userId), eq(userCredits.currency, 'USD')));
    expect(balance?.balanceMinor).toBe(2500n);
  });
});

/**
 * MNY-11-onchainrail: the on-chain refund rail (`applyOrderAutoRefund`
 * for xlm/usdc) BYPASSED the fleet-wide daily refund cap that gates the
 * credit rail — it writes no `credit_transactions` row, so it was
 * invisible to the cap sum AND never checked it. These real-postgres
 * tests prove the fix: both rails now count against and are gated by one
 * shared budget (`ADMIN_DAILY_ADJUSTMENT_CAP_MINOR`, per currency, per
 * UTC day). The cap query, the orders <-> payment_watcher_skips join,
 * and the advisory lock are DB-only behavior, so they live here.
 */
describe('MNY-11-onchainrail — on-chain refund rail honours the shared daily cap (real postgres)', () => {
  /**
   * A schema-valid Horizon payment snapshot whose id matches the order's
   * paying deposit — the on-chain rail parses + identity-checks it
   * BEFORE the cap gate, so it must be well-formed even for the
   * cap-rejected paths.
   */
  function snapshot(payingId: string): Record<string, unknown> {
    return {
      id: payingId,
      paging_token: `pt-${payingId}`,
      type: 'payment',
      from: 'GSENDER',
      to: 'GDEPOSIT',
      asset_type: 'native',
      amount: '2.0000000',
      transaction_hash: `tx-${payingId}`,
      transaction: { memo: 'MEMO', memo_type: 'text', successful: true },
    };
  }

  /** A failed USD order paid on-chain, with its paying-deposit snapshot. */
  async function seedOnChainOrder(
    payingId: string,
    chargeMinor: bigint,
  ): Promise<{ userId: string; orderId: string }> {
    const user = await findOrCreateUserByEmail(`mny11-${payingId}-${Math.random()}@test.local`);
    await db.update(users).set({ homeCurrency: 'USD' }).where(eq(users.id, user.id));
    const [row] = await db
      .insert(orders)
      .values({
        userId: user.id,
        merchantId: 'amazon',
        faceValueMinor: chargeMinor,
        currency: 'USD',
        chargeMinor,
        chargeCurrency: 'USD',
        paymentMethod: 'usdc',
        paymentMemo: 'MEMO',
        wholesalePct: '70.00',
        userCashbackPct: '5.00',
        loopMarginPct: '25.00',
        wholesaleMinor: 0n,
        userCashbackMinor: 0n,
        loopMarginMinor: 0n,
        state: 'failed',
        paymentReceivedHorizonId: payingId,
        paymentReceivedPayment: snapshot(payingId),
      })
      .returning({ id: orders.id });
    if (row === undefined) throw new Error('seed: orders insert returned no row');
    return { userId: user.id, orderId: row.id };
  }

  /** Record an already-landed on-chain refund of `order`'s paying deposit. */
  async function insertRefundedDepositSkip(payingId: string, orderId: string): Promise<void> {
    await db.insert(paymentWatcherSkips).values({
      paymentId: payingId,
      memo: 'MEMO',
      orderId,
      reason: 'order_gone',
      payment: snapshot(payingId),
      status: 'refunded',
      updatedAt: new Date(),
    });
  }

  let previousCap: bigint;
  beforeEach(() => {
    previousCap = env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR;
  });
  afterEach(() => {
    env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = previousCap;
  });

  it('a prior on-chain refund consumes the shared budget → a further on-chain refund past the cap is REJECTED before any value leaves', async () => {
    env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 3000n;

    // A prior on-chain order-refund already landed today (2000 of budget).
    const prior = await seedOnChainOrder('pay-prior', 2000n);
    await insertRefundedDepositSkip('pay-prior', prior.orderId);

    // A second failed on-chain order wants a 2000 refund; only 1000 of
    // the 3000 budget remains → the on-chain rail must now refuse it.
    const next = await seedOnChainOrder('pay-next', 2000n);
    await expect(
      applyOrderAutoRefund({
        userId: next.userId,
        currency: 'USD',
        amountMinor: 2000n,
        orderId: next.orderId,
        paymentMethod: 'usdc',
        paymentMemo: 'MEMO',
        paymentReceivedHorizonId: 'pay-next',
        paymentReceivedPayment: snapshot('pay-next'),
        reason: 'order failed after CTX paid: timeout',
      }),
    ).rejects.toBeInstanceOf(DailyAdjustmentLimitError);

    // RED PROOF: the gate fires BEFORE the guard txn records the
    // refundable-deposit skip row, so nothing is queued for on-chain
    // send. Pre-fix, the on-chain rail skipped the cap entirely and a
    // skip row for 'pay-next' WAS recorded here.
    const skip = await db
      .select({ paymentId: paymentWatcherSkips.paymentId })
      .from(paymentWatcherSkips)
      .where(eq(paymentWatcherSkips.paymentId, 'pay-next'));
    expect(skip).toHaveLength(0);
  });

  it('an on-chain refund consumes the SAME budget the credit rail checks → a credit refund past the cap is rejected', async () => {
    env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 3000n;

    // 2000 already spent on-chain today.
    const onChain = await seedOnChainOrder('pay-oc', 2000n);
    await insertRefundedDepositSkip('pay-oc', onChain.orderId);

    // A credit-rail refund for a DIFFERENT order wants 2000; only 1000
    // remains → the credit rail must now see the on-chain consumption
    // and refuse. Pre-fix, the credit-rail cap counted only
    // credit_transactions (0 used) and this refund WOULD have landed.
    const credit = await seedOnChainOrder('pay-cr', 2000n);
    await expect(
      applyAdminRefund({
        userId: credit.userId,
        currency: 'USD',
        amountMinor: 2000n,
        orderId: credit.orderId,
        adminUserId: 'admin-mny11',
      }),
    ).rejects.toBeInstanceOf(DailyAdjustmentLimitError);

    const refundRows = await db
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.type, 'refund'),
          eq(creditTransactions.referenceId, credit.orderId),
        ),
      );
    expect(refundRows).toHaveLength(0);
  });

  // The counted STATE must be the one written UNDER the advisory lock,
  // not the refunding/refunded state `refundDeposit` sets AFTER the lock
  // releases — otherwise a second caller grabs the lock the instant the
  // first commits (magnitude still uncounted) and both pass a near-full
  // budget. `recordFailedOrderRefundableDeposit` writes the paying
  // deposit as `abandoned` + the auto-refund actor prefix inside the
  // guard txn; that is what must count.
  it('an in-flight on-chain refund (recorded abandoned+prefix under the lock, not yet sent) already counts against the budget', async () => {
    env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 1000n;
    const inflight = await seedOnChainOrder('pay-inflight', 600n);
    await db.insert(paymentWatcherSkips).values({
      paymentId: 'pay-inflight',
      memo: 'MEMO',
      orderId: inflight.orderId,
      reason: 'order_gone',
      payment: snapshot('pay-inflight'),
      status: 'abandoned',
      lastError: `${AUTO_REFUND_SYSTEM_ACTOR}: order failed after CTX paid: timeout`,
      updatedAt: new Date(),
    });
    // 600 already reserved on-chain; a 500 refund now exceeds the
    // remaining 400 → gated. RED against counting only refunding/refunded
    // (the abandoned intent would read as 0 used).
    const other = await seedOnChainOrder('pay-other-1', 600n);
    await expect(
      applyAdminRefund({
        userId: other.userId,
        currency: 'USD',
        amountMinor: 500n,
        orderId: other.orderId,
        adminUserId: 'admin-mny11',
      }),
    ).rejects.toBeInstanceOf(DailyAdjustmentLimitError);
  });

  it('a released (definitively-failed) on-chain refund does NOT consume budget — no reservation leak', async () => {
    env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 1000n;
    const failed = await seedOnChainOrder('pay-failed', 600n);
    // releaseClaim leaves the paying-deposit skip `abandoned` with
    // last_error OVERWRITTEN to the submit error (auto-refund prefix
    // gone) — value never moved, so it must not eat budget.
    await db.insert(paymentWatcherSkips).values({
      paymentId: 'pay-failed',
      memo: 'MEMO',
      orderId: failed.orderId,
      reason: 'order_gone',
      payment: snapshot('pay-failed'),
      status: 'abandoned',
      lastError: 'terminal_tx_failed: op_no_destination',
      updatedAt: new Date(),
    });
    // The full 1000 budget is still available.
    const other = await seedOnChainOrder('pay-other-2', 1000n);
    const res = await applyAdminRefund({
      userId: other.userId,
      currency: 'USD',
      amountMinor: 1000n,
      orderId: other.orderId,
      adminUserId: 'admin-mny11',
    });
    expect(res.amountMinor).toBe(1000n);
  });

  it('two concurrent on-chain refunds racing a near-cap budget: EXACTLY ONE is gated (total refunded <= cap)', async () => {
    env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 1000n;
    // Fail-fast the on-chain submit (no operator signer) so the
    // cap-PASSING racer resolves without a network hit — the cap gate
    // fires strictly before refundDeposit, which is all we assert on.
    const prevSecret = env.LOOP_STELLAR_OPERATOR_SECRET;
    env.LOOP_STELLAR_OPERATOR_SECRET = undefined;
    try {
      const a = await seedOnChainOrder('pay-race-a', 600n);
      const b = await seedOnChainOrder('pay-race-b', 600n);
      const race = (o: { userId: string; orderId: string }, payingId: string): Promise<unknown> =>
        applyOrderAutoRefund({
          userId: o.userId,
          currency: 'USD',
          amountMinor: 600n,
          orderId: o.orderId,
          paymentMethod: 'usdc',
          paymentMemo: 'MEMO',
          paymentReceivedHorizonId: payingId,
          paymentReceivedPayment: snapshot(payingId),
          reason: 'order failed after CTX paid: timeout',
        }).then(
          () => null,
          (err: unknown) => err,
        );

      // Both acquire the shared advisory lock in sequence around the same
      // commit window: the first commits its abandoned+prefix skip, the
      // second (blocked on the lock until then) must see it and be capped.
      const [ra, rb] = await Promise.all([race(a, 'pay-race-a'), race(b, 'pay-race-b')]);

      const capRejects = [ra, rb].filter((r) => r instanceof DailyAdjustmentLimitError);
      expect(capRejects).toHaveLength(1);

      // Only the winner recorded a refundable-deposit skip; the gated
      // racer refused before any on-chain write. Pre-fix (or counting
      // only refunding/refunded), BOTH pass and BOTH record → 1200 refund
      // attempts past a 1000 cap.
      const skips = await db
        .select({ paymentId: paymentWatcherSkips.paymentId })
        .from(paymentWatcherSkips)
        .where(inArray(paymentWatcherSkips.paymentId, ['pay-race-a', 'pay-race-b']));
      expect(skips).toHaveLength(1);
    } finally {
      env.LOOP_STELLAR_OPERATOR_SECRET = prevSecret;
    }
  });
});
