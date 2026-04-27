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
vi.mock('../../payments/price-feed.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    stroopsPerCent: vi.fn(async () => 1n),
    usdcStroopsPerCent: vi.fn(async () => 100_000n),
  };
});

vi.mock('../../discord.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, notifyAdminAudit: vi.fn(), notifyAdminBulkRead: vi.fn() };
});

import { db } from '../../db/client.js';
import { users, orders, watcherCursors } from '../../db/schema.js';
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
});
