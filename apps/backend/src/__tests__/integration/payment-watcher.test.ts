/**
 * Payment-watcher integration tests on real postgres.
 *
 * The watcher is the bridge between Stellar deposits and order
 * fulfillment — without it, no XLM/USDC order ever transitions from
 * `pending_payment` to `paid`, the procurement worker has nothing
 * to do, and no cashback fires. The unit suite mocks every DB
 * boundary; this validates:
 *
 *   - **Cursor persistence** — the `watcher_cursors` upsert (full
 *     unique on `name`, no partial index) is the resume point on
 *     restart. A bug in the upsert would cause re-processing of
 *     every payment forever or, worse, no cursor advance at all.
 *   - **Memo → order match** — `findPendingOrderByMemo` is what
 *     binds an inbound Stellar payment to a specific order. SQL
 *     drift here means correctly-paid users sit forever in
 *     pending_payment because their memo never finds the order.
 *   - **State-guarded `markOrderPaid`** — same race-safe pattern as
 *     procurement: the WHERE-state guard is the lock. A second
 *     watcher tick (or a concurrent worker) hitting the same
 *     payment cannot double-advance.
 *
 * Mocks: `listAccountPayments` (Horizon GET — only external
 * boundary). Real: postgres, drizzle SQL, every state guard, the
 * memo lookup, the cursor upsert.
 *
 * Gated on `LOOP_E2E_DB=1` like the sibling integration suites.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

vi.mock('../../payments/horizon.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    listAccountPayments: vi.fn(),
  };
});

// XLM oracle stub: 1 cent = 1 stroop (i.e. trivially-cheap XLM so any
// real-world fixture amount covers the order). The amount-sufficient
// path consults this for paymentMethod='xlm'; without the stub the
// test environment has no oracle wired and rejects every XLM payment.
//
// A4-106: amount-sufficient now uses `requiredStroopsForCharge` (the
// per-charge ceiling helper) instead of multiplying chargeMinor by
// `stroopsPerCent`, so the test stub must cover both. Returning
// `chargeMinor` cents of stroops keeps the trivial-coverage shape:
// 1 cent ⇒ 1 stroop, so 2500-cent ($25) order requires 2500 stroops
// and the 100-XLM (1e9 stroops) fixture covers it comfortably.
vi.mock('../../payments/price-feed.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    stroopsPerCent: vi.fn(async () => 1n),
    requiredStroopsForCharge: vi.fn(async (chargeMinor: bigint) => chargeMinor),
    usdcStroopsPerCent: vi.fn(async () => 100_000n),
  };
});

vi.mock('../../discord.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, notifyAdminAudit: vi.fn(), notifyAdminBulkRead: vi.fn() };
});

import { db } from '../../db/client.js';
import {
  users,
  orders,
  watcherCursors,
  userCredits,
  creditTransactions,
  pendingPayouts,
  paymentWatcherSkips,
} from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { runPaymentWatcherTick } from '../../payments/watcher.js';
import { listAccountPayments, type HorizonPayment } from '../../payments/horizon.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

const ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/**
 * Builds a synthetic XLM payment in the shape the watcher's Zod
 * schema accepts. Default amount of 100 XLM is enough to cover any
 * USD-faced order under the seed's $25-amount default.
 */
function xlmPayment(args: {
  id: string;
  pagingToken: string;
  memo: string;
  amount?: string;
}): HorizonPayment {
  return {
    id: args.id,
    paging_token: args.pagingToken,
    type: 'payment',
    to: ACCOUNT,
    asset_type: 'native',
    amount: args.amount ?? '100.0000000',
    transaction_hash: `tx-${args.id}`,
    transaction: { memo: args.memo, memo_type: 'text', successful: true },
  };
}

interface SeededOrder {
  userId: string;
  orderId: string;
  memo: string;
}

async function seedPendingOrder(memo: string): Promise<SeededOrder> {
  const user = await findOrCreateUserByEmail(`watcher-${Date.now()}-${Math.random()}@test.local`);
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
      paymentMemo: memo,
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      wholesaleMinor: 1750n,
      userCashbackMinor: 125n,
      loopMarginMinor: 625n,
      state: 'pending_payment',
    })
    .returning({ id: orders.id });
  if (row === undefined) throw new Error('seed: orders insert returned no row');
  return { userId: user.id, orderId: row.id, memo };
}

describeIf('payment-watcher integration — memo match + state transition', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    vi.mocked(listAccountPayments).mockReset();
  });

  it('matched memo + sufficient amount → markOrderPaid + cursor advance', async () => {
    const seeded = await seedPendingOrder('order-memo-1');
    vi.mocked(listAccountPayments).mockResolvedValueOnce({
      records: [xlmPayment({ id: 'p1', pagingToken: 'tok-001', memo: seeded.memo })],
      nextCursor: null,
    });

    const result = await runPaymentWatcherTick({ account: ACCOUNT });
    expect(result.scanned).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.paid).toBe(1);

    const [row] = await db.select().from(orders).where(eq(orders.id, seeded.orderId));
    expect(row!.state).toBe('paid');
    expect(row!.paidAt).not.toBeNull();

    // Cursor advanced to the page's last paging_token.
    const [cursor] = await db
      .select()
      .from(watcherCursors)
      .where(eq(watcherCursors.name, 'stellar-deposits'));
    expect(cursor?.cursor).toBe('tok-001');
  });

  it('subsequent tick resumes from the persisted cursor', async () => {
    // First tick writes cursor; second tick must pass the cursor
    // back to listAccountPayments. The watcher's call signature
    // includes `cursor: <stored>` only when the row exists.
    await db.insert(watcherCursors).values({ name: 'stellar-deposits', cursor: 'tok-resume-from' });
    vi.mocked(listAccountPayments).mockResolvedValueOnce({ records: [], nextCursor: null });

    await runPaymentWatcherTick({ account: ACCOUNT });
    const call = vi.mocked(listAccountPayments).mock.calls[0]?.[0];
    expect(call?.cursor).toBe('tok-resume-from');
  });

  it('payment with no matching order → counted as unmatchedMemo, no transition', async () => {
    // No order seeded with this memo. The watcher should record the
    // unmatched payment without falling over.
    vi.mocked(listAccountPayments).mockResolvedValueOnce({
      records: [xlmPayment({ id: 'p2', pagingToken: 'tok-002', memo: 'orphan-memo' })],
      nextCursor: null,
    });

    const result = await runPaymentWatcherTick({ account: ACCOUNT });
    expect(result.unmatchedMemo).toBe(1);
    expect(result.paid).toBe(0);

    const ordersList = await db.select().from(orders);
    expect(ordersList).toHaveLength(0);
  });

  it('insufficient amount → matched but skipped, order stays pending_payment', async () => {
    const seeded = await seedPendingOrder('order-memo-3');
    // Order is 25 USD, requires equivalent XLM. 0.0000001 XLM is
    // nowhere near enough; isAmountSufficient rejects + the order
    // stays pending. Real schema CHECK doesn't fire because the
    // amount is on the inbound payment, not the order row.
    vi.mocked(listAccountPayments).mockResolvedValueOnce({
      records: [
        xlmPayment({ id: 'p3', pagingToken: 'tok-003', memo: seeded.memo, amount: '0.0000001' }),
      ],
      nextCursor: null,
    });

    const result = await runPaymentWatcherTick({ account: ACCOUNT });
    expect(result.matched).toBe(1);
    expect(result.skippedAmount).toBe(1);
    expect(result.paid).toBe(0);

    const [row] = await db.select().from(orders).where(eq(orders.id, seeded.orderId));
    expect(row!.state).toBe('pending_payment');
  });

  it('two ticks against the same payment — second is a no-op (state guard)', async () => {
    // Mirror of the procurement-worker concurrent-claim test. The
    // payment-watcher doesn't lock-and-claim; it relies on
    // `markOrderPaid`'s state-guarded UPDATE. A second tick hitting
    // the same payment finds the order already in `paid`, the UPDATE
    // returns null, paid count stays 0 on the second tick.
    const seeded = await seedPendingOrder('order-memo-double');
    const payment = xlmPayment({
      id: 'p-double',
      pagingToken: 'tok-double',
      memo: seeded.memo,
    });
    vi.mocked(listAccountPayments).mockResolvedValue({ records: [payment], nextCursor: null });

    const t1 = await runPaymentWatcherTick({ account: ACCOUNT });
    expect(t1.paid).toBe(1);
    // Second tick: same Horizon record, but the order is now `paid`
    // so `findPendingOrderByMemo` returns null. The watcher counts
    // it as `unmatchedMemo` and the markOrderPaid path never runs.
    // This is the live-watcher idempotency: a Horizon backfill or a
    // cursor-rewound replay never double-credits the order.
    const t2 = await runPaymentWatcherTick({ account: ACCOUNT });
    expect(t2.unmatchedMemo).toBe(1);
    expect(t2.paid).toBe(0);

    const [row] = await db.select().from(orders).where(eq(orders.id, seeded.orderId));
    expect(row!.state).toBe('paid');
  });

  it('empty page with no records leaves cursor unchanged', async () => {
    // No payments + no nextCursor → no upsert. A bug that wrote a
    // null cursor would corrupt the resume point on the next tick.
    vi.mocked(listAccountPayments).mockResolvedValueOnce({ records: [], nextCursor: null });
    await runPaymentWatcherTick({ account: ACCOUNT });
    const cursors = await db.select().from(watcherCursors);
    expect(cursors).toHaveLength(0);
  });

  // ─── T0-1: stop stranding late deposits after order expiry ──────────

  async function seedOrderInState(memo: string, state: 'expired' | 'paid'): Promise<SeededOrder> {
    const seeded = await seedPendingOrder(memo);
    await db.update(orders).set({ state }).where(eq(orders.id, seeded.orderId));
    return seeded;
  }
  async function skipFor(
    memo: string,
  ): Promise<typeof paymentWatcherSkips.$inferSelect | undefined> {
    const rows = await db
      .select()
      .from(paymentWatcherSkips)
      .where(eq(paymentWatcherSkips.memo, memo));
    return rows[0];
  }

  it('T0-1: deposit whose order EXPIRED unpaid → recorded as order_gone, then abandoned (A6-refundable)', async () => {
    const seeded = await seedOrderInState('t01-expired', 'expired');
    vi.mocked(listAccountPayments).mockResolvedValueOnce({
      records: [xlmPayment({ id: 'late-1', pagingToken: 'tok-late-1', memo: seeded.memo })],
      nextCursor: null,
    });
    const t1 = await runPaymentWatcherTick({ account: ACCOUNT });
    // The pre-T0-1 bug counted this but NEVER recorded it → funds stranded,
    // unreachable by any refund. Now it's a durable, refundable skip row.
    expect(t1.unmatchedMemo).toBe(1);
    const recorded = await skipFor(seeded.memo);
    expect(recorded).toBeDefined();
    expect(recorded!.reason).toBe('order_gone');
    expect(recorded!.orderId).toBe(seeded.orderId);
    expect(recorded!.paymentId).toBe('late-1');
    expect(recorded!.status).toBe('pending');

    // Next tick's sweep re-evaluates the row → order_gone → abandoned:
    // the exact state the A6 refund flow claims from (auto-refund off).
    vi.mocked(listAccountPayments).mockResolvedValueOnce({ records: [], nextCursor: null });
    await runPaymentWatcherTick({ account: ACCOUNT });
    const abandoned = await skipFor(seeded.memo);
    expect(abandoned!.status).toBe('abandoned');
    expect(abandoned!.reason).toBe('order_gone');
  });

  it('T0-1 safety: a memo matching NO order is counted only, never recorded (no unattributable refunds)', async () => {
    vi.mocked(listAccountPayments).mockResolvedValueOnce({
      records: [xlmPayment({ id: 'unk-1', pagingToken: 'tok-unk-1', memo: 'no-such-order-memo' })],
      nextCursor: null,
    });
    const result = await runPaymentWatcherTick({ account: ACCOUNT });
    expect(result.unmatchedMemo).toBe(1);
    expect(await db.select().from(paymentWatcherSkips)).toHaveLength(0);
  });

  it('T0-1 safety: deposit whose order was PAID is counted only, NOT recorded (double-spend guard)', async () => {
    // A paid order does not persist which payment paid it, so recording a
    // deposit against it as refundable risks refunding the ORIGINAL paying
    // deposit re-read after a cursor regression → double-spend. Deliberately
    // not recorded here; the duplicate-against-paid case is T0-1b.
    const seeded = await seedOrderInState('t01-paid', 'paid');
    vi.mocked(listAccountPayments).mockResolvedValueOnce({
      records: [xlmPayment({ id: 'dup-1', pagingToken: 'tok-dup-1', memo: seeded.memo })],
      nextCursor: null,
    });
    const result = await runPaymentWatcherTick({ account: ACCOUNT });
    expect(result.unmatchedMemo).toBe(1);
    expect(await db.select().from(paymentWatcherSkips)).toHaveLength(0);
  });
});

// ─── ADR 036: loop_asset redemption — debit + issuer-return burn ──────────

const USDLOOP_ISSUER = process.env['LOOP_STELLAR_USDLOOP_ISSUER']!;

/** USDLOOP payment fixture — issuer-pinned 12-char alphanum asset. */
function usdloopPayment(args: {
  id: string;
  pagingToken: string;
  memo: string;
  amount?: string;
}): HorizonPayment {
  return {
    id: args.id,
    paging_token: args.pagingToken,
    type: 'payment',
    to: ACCOUNT,
    asset_type: 'credit_alphanum12',
    asset_code: 'USDLOOP',
    asset_issuer: USDLOOP_ISSUER,
    // 2500 minor × 100_000 stroops/minor = 250_000_000 stroops = 25.0.
    amount: args.amount ?? '25.0000000',
    transaction_hash: `tx-${args.id}`,
    transaction: { memo: args.memo, memo_type: 'text', successful: true },
  };
}

async function seedLoopAssetOrder(memo: string): Promise<SeededOrder> {
  const user = await findOrCreateUserByEmail(`redeem-${Date.now()}-${Math.random()}@test.local`);
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
      paymentMethod: 'loop_asset',
      paymentMemo: memo,
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      wholesaleMinor: 1750n,
      userCashbackMinor: 125n,
      loopMarginMinor: 625n,
      state: 'pending_payment',
    })
    .returning({ id: orders.id });
  if (row === undefined) throw new Error('seed: orders insert returned no row');
  return { userId: user.id, orderId: row.id, memo };
}

describeIf('payment-watcher integration — loop_asset redemption (A4-110 + ADR 036)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    vi.mocked(listAccountPayments).mockReset();
  });

  it('debits the mirror AND enqueues the issuer-return burn in the same txn', async () => {
    const seeded = await seedLoopAssetOrder('redeem-memo-1');
    // The redeeming user holds 3000 minor of mirrored USD balance.
    await db.insert(creditTransactions).values({
      userId: seeded.userId,
      type: 'cashback',
      amountMinor: 3000n,
      currency: 'USD',
      referenceType: 'order',
      referenceId: crypto.randomUUID(),
    });
    await db.insert(userCredits).values({
      userId: seeded.userId,
      currency: 'USD',
      balanceMinor: 3000n,
    });
    vi.mocked(listAccountPayments).mockResolvedValueOnce({
      records: [usdloopPayment({ id: 'lp1', pagingToken: 'tok-loop-1', memo: seeded.memo })],
      nextCursor: null,
    });

    const result = await runPaymentWatcherTick({ account: ACCOUNT });
    expect(result.paid).toBe(1);

    const [order] = await db.select().from(orders).where(eq(orders.id, seeded.orderId));
    expect(order!.state).toBe('paid');

    // Mirror debited by the charge.
    const [credit] = await db
      .select()
      .from(userCredits)
      .where(eq(userCredits.userId, seeded.userId));
    expect(credit?.balanceMinor).toBe(500n); // 3000 - 2500

    // Spend ledger row referencing the order.
    const spends = (
      await db.select().from(creditTransactions).where(eq(creditTransactions.userId, seeded.userId))
    ).filter((r) => r.type === 'spend');
    expect(spends).toHaveLength(1);
    expect(spends[0]!.amountMinor).toBe(-2500n);
    expect(spends[0]!.referenceId).toBe(seeded.orderId);

    // ADR 036: the burn row landed in the same txn — kind='burn',
    // destination = the USDLOOP issuer, amount at the 1:1 peg.
    const burns = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.orderId, seeded.orderId));
    expect(burns).toHaveLength(1);
    expect(burns[0]!.kind).toBe('burn');
    expect(burns[0]!.assetCode).toBe('USDLOOP');
    expect(burns[0]!.assetIssuer).toBe(USDLOOP_ISSUER);
    expect(burns[0]!.toAddress).toBe(USDLOOP_ISSUER);
    expect(burns[0]!.amountStroops).toBe(2500n * 100_000n);
    expect(burns[0]!.state).toBe('pending');
  });

  it('missing user_credits row → NEITHER half applies (txn atomicity) and the deposit is parked for retry', async () => {
    const seeded = await seedLoopAssetOrder('redeem-memo-2');
    // No user_credits row — state corruption per A4-110. The
    // markOrderPaid txn must roll back the state flip, the debit
    // and the burn enqueue together.
    vi.mocked(listAccountPayments).mockResolvedValueOnce({
      records: [usdloopPayment({ id: 'lp2', pagingToken: 'tok-loop-2', memo: seeded.memo })],
      nextCursor: null,
    });

    const result = await runPaymentWatcherTick({ account: ACCOUNT });
    expect(result.paid).toBe(0);

    const [order] = await db.select().from(orders).where(eq(orders.id, seeded.orderId));
    expect(order!.state).toBe('pending_payment');

    const ledgerRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, seeded.userId));
    expect(ledgerRows).toHaveLength(0);

    const burns = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.orderId, seeded.orderId));
    expect(burns).toHaveLength(0);
  });
});
