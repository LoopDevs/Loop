/**
 * Real-postgres + concurrency coverage for the credit-funded order
 * writer (TST-04).
 *
 * `orders/repo-credit-order.ts::insertCreditOrderTxn` is the ledger
 * writer on the credit-funded order path (ADR 010 / 015): in ONE
 * drizzle transaction it inserts the `orders` row, re-reads the
 * user's `user_credits` balance under a `FOR UPDATE` lock, writes the
 * negative `type='spend'` `credit_transactions` row, decrements the
 * balance via a SQL expression, and flips the order to `paid`. The
 * money-safety contract is:
 *
 *   - ATOMIC: a crash / guard-throw mid-write either leaves the user
 *     un-debited with NO order row (rolled back) or leaves the order
 *     `paid` alongside its debit + ledger row (committed). No
 *     intermediate states, no partial writes.
 *   - GUARDED: the in-txn `FOR UPDATE` re-read is the SOLE balance
 *     check on the credit path — `balance < chargeMinor` throws
 *     `InsufficientCreditError` and rolls the whole txn back.
 *   - CONSERVED: the spend ledger row carries exactly `-chargeMinor`,
 *     the balance drops by exactly `chargeMinor`, and the ledger row
 *     references the order it funded.
 *   - IDEMPOTENT: the `orders_user_idempotency_unique` partial index
 *     on `(user_id, idempotency_key)` prevents a retried / double-
 *     clicked request from writing a second order + a second debit.
 *   - CONCURRENCY-SAFE: the `FOR UPDATE` lock on the `user_credits`
 *     row serialises concurrent credit orders against the same
 *     balance — no oversell (balance can't go negative), no lost
 *     update (two affordable debits both land), no duplicate ledger
 *     rows.
 *
 * The unit suite (`orders/__tests__/repo.test.ts`) mocks drizzle's
 * transaction + query builder, so it can verify the call SHAPE but
 * cannot exercise the `FOR UPDATE` serialisation, the real CHECK
 * constraints / partial unique indexes, or the txn rollback. This
 * suite drives `insertCreditOrderTxn` directly against the live
 * `loop_test` postgres so the writes go through real SQL + real
 * concurrency.
 *
 * Gated on `LOOP_E2E_DB=1` like every sibling integration suite; run
 * via `npm run test:integration -w @loop/backend` (also needs
 * `docker compose up -d db` locally / a postgres service container in
 * CI).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

import { db } from '../../db/client.js';
import { orders, userCredits, creditTransactions } from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { isUniqueViolation } from '../../db/errors.js';
import { InsufficientCreditError } from '../../orders/repo-errors.js';
import {
  insertCreditOrderTxn,
  type CreditOrderBaseValues,
} from '../../orders/repo-credit-order.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

/** Seed a native user and return its id. */
async function seedUserId(email: string): Promise<string> {
  const user = await findOrCreateUserByEmail(email);
  return user.id;
}

/** Seed a `(user, USD)` credit row at the given balance (minor units). */
async function seedBalance(userId: string, balanceMinor: bigint): Promise<void> {
  await db.insert(userCredits).values({ userId, currency: 'USD', balanceMinor });
}

/**
 * A valid `CreditOrderBaseValues` for a $50.00 USD credit order.
 * Satisfies every relevant CHECK: percentages sum to 100 (<=100),
 * all minor amounts non-negative, `credit` payment method with a null
 * memo (payment-memo coherence), and USD (known charge currency). The
 * `chargeMinor` is positive so the derived spend amount `-chargeMinor`
 * satisfies the `credit_transactions_amount_sign` CHECK.
 */
function baseValues(
  userId: string,
  overrides: Partial<CreditOrderBaseValues> = {},
): CreditOrderBaseValues {
  return {
    userId,
    merchantId: 'merchant-credit-writer-test',
    faceValueMinor: 5000n,
    currency: 'USD',
    chargeMinor: 5000n,
    chargeCurrency: 'USD',
    paymentMethod: 'credit',
    paymentMemo: null,
    wholesalePct: '90.00',
    userCashbackPct: '5.00',
    loopMarginPct: '5.00',
    wholesaleMinor: 4500n,
    userCashbackMinor: 250n,
    loopMarginMinor: 250n,
    idempotencyKey: null,
    ...overrides,
  };
}

async function ordersForUser(userId: string): Promise<Array<typeof orders.$inferSelect>> {
  return db.select().from(orders).where(eq(orders.userId, userId));
}

async function spendRowsForUser(
  userId: string,
): Promise<Array<typeof creditTransactions.$inferSelect>> {
  return db
    .select()
    .from(creditTransactions)
    .where(and(eq(creditTransactions.userId, userId), eq(creditTransactions.type, 'spend')));
}

async function usdBalance(userId: string): Promise<bigint | null> {
  const rows = await db
    .select({ balanceMinor: userCredits.balanceMinor })
    .from(userCredits)
    .where(and(eq(userCredits.userId, userId), eq(userCredits.currency, 'USD')));
  return rows[0]?.balanceMinor ?? null;
}

describeIf('insertCreditOrderTxn — happy path (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  it('writes exactly one paid order + one spend ledger row and debits the balance by the charge', async () => {
    const userId = await seedUserId('credit-writer-happy@test.local');
    await seedBalance(userId, 10_000n);

    const result = await insertCreditOrderTxn(baseValues(userId, { chargeMinor: 5000n }));

    // Returned row is the PAID order (not the pending_payment insert).
    expect(result.state).toBe('paid');
    expect(result.paymentMethod).toBe('credit');
    expect(result.paidAt).not.toBeNull();
    expect(result.paymentReceivedAt).not.toBeNull();
    expect(result.chargeMinor).toBe(5000n);

    // Exactly one order row, in `paid`.
    const orderRows = await ordersForUser(userId);
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0]!.id).toBe(result.id);
    expect(orderRows[0]!.state).toBe('paid');

    // Exactly one spend ledger row, carrying the NEGATIVE charge and
    // referencing the order it funded (the reconciliation linkage).
    const spends = await spendRowsForUser(userId);
    expect(spends).toHaveLength(1);
    expect(spends[0]!.amountMinor).toBe(-5000n);
    expect(spends[0]!.currency).toBe('USD');
    expect(spends[0]!.referenceType).toBe('order');
    expect(spends[0]!.referenceId).toBe(result.id);

    // Balance debited by EXACTLY the charge: 10000 - 5000 = 5000.
    expect(await usdBalance(userId)).toBe(5000n);
  });

  it('conservation — final balance equals seeded balance plus the sum of ledger rows', async () => {
    const userId = await seedUserId('credit-writer-conservation@test.local');
    const seeded = 8_000n;
    const charge = 3_000n;
    await seedBalance(userId, seeded);

    await insertCreditOrderTxn(baseValues(userId, { chargeMinor: charge }));

    // Replay the append-only ledger: the materialised balance must
    // equal the seed plus the signed sum of every credit_transactions
    // row for this (user, currency). If the writer debited a different
    // amount than it booked, this reconciliation breaks.
    const ledger = await db
      .select({ amountMinor: creditTransactions.amountMinor })
      .from(creditTransactions)
      .where(and(eq(creditTransactions.userId, userId), eq(creditTransactions.currency, 'USD')));
    const ledgerSum = ledger.reduce((acc, r) => acc + r.amountMinor, 0n);

    expect(ledgerSum).toBe(-charge);
    expect(await usdBalance(userId)).toBe(seeded + ledgerSum);
    expect(await usdBalance(userId)).toBe(5_000n);
  });
});

describeIf('insertCreditOrderTxn — insufficient balance guard (atomic rollback)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  it('throws InsufficientCreditError and rolls back the order insert when balance < charge', async () => {
    const userId = await seedUserId('credit-writer-insufficient@test.local');
    await seedBalance(userId, 4_999n); // one minor unit short of the 5000 charge

    await expect(
      insertCreditOrderTxn(baseValues(userId, { chargeMinor: 5000n })),
    ).rejects.toBeInstanceOf(InsufficientCreditError);

    // Whole txn rolled back — NO order row, NO ledger row, balance
    // untouched. This is the "un-debited, no order" branch of the
    // atomicity contract.
    expect(await ordersForUser(userId)).toHaveLength(0);
    expect(await spendRowsForUser(userId)).toHaveLength(0);
    expect(await usdBalance(userId)).toBe(4_999n);
  });

  it('throws InsufficientCreditError when the user has NO credit row at all', async () => {
    const userId = await seedUserId('credit-writer-no-row@test.local');
    // No seedBalance — the FOR UPDATE re-read finds no row → treated as
    // a 0 balance, which is below any positive charge.

    await expect(
      insertCreditOrderTxn(baseValues(userId, { chargeMinor: 1n })),
    ).rejects.toBeInstanceOf(InsufficientCreditError);

    expect(await ordersForUser(userId)).toHaveLength(0);
    expect(await spendRowsForUser(userId)).toHaveLength(0);
    expect(await usdBalance(userId)).toBeNull();
  });
});

describeIf('insertCreditOrderTxn — idempotency (order-key fence)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  it('a sequential re-run with the same idempotency key does NOT double-write', async () => {
    const userId = await seedUserId('credit-writer-idem-seq@test.local');
    await seedBalance(userId, 10_000n);
    const key = 'idem-key-seq-1';

    const first = await insertCreditOrderTxn(
      baseValues(userId, { chargeMinor: 5000n, idempotencyKey: key }),
    );
    expect(first.state).toBe('paid');

    // Second attempt with the SAME (user, key) trips the partial
    // unique index at the order insert — the whole txn rolls back, so
    // no second order + no second debit lands.
    let secondErr: unknown = null;
    await insertCreditOrderTxn(
      baseValues(userId, { chargeMinor: 5000n, idempotencyKey: key }),
    ).catch((e: unknown) => {
      secondErr = e;
    });
    expect(secondErr).not.toBeNull();
    expect(isUniqueViolation(secondErr, 'orders_user_idempotency_unique')).toBe(true);

    // Exactly ONE order + ONE spend; balance debited exactly once.
    expect(await ordersForUser(userId)).toHaveLength(1);
    expect(await spendRowsForUser(userId)).toHaveLength(1);
    expect(await usdBalance(userId)).toBe(5_000n);
  });

  it('two CONCURRENT inserts with the same idempotency key: exactly one wins, no double-debit', async () => {
    const userId = await seedUserId('credit-writer-idem-conc@test.local');
    // Balance covers BOTH orders — so a second write is stopped by the
    // idempotency fence, NOT by an insufficient balance. This isolates
    // the idempotency guarantee from the balance guard.
    await seedBalance(userId, 20_000n);
    const key = 'idem-key-conc-1';

    const settled = await Promise.allSettled([
      insertCreditOrderTxn(baseValues(userId, { chargeMinor: 5000n, idempotencyKey: key })),
      insertCreditOrderTxn(baseValues(userId, { chargeMinor: 5000n, idempotencyKey: key })),
    ]);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser fails on the ORDER idempotency index specifically.
    expect(
      isUniqueViolation(
        (rejected[0] as PromiseRejectedResult).reason,
        'orders_user_idempotency_unique',
      ),
    ).toBe(true);

    // Despite the concurrency + a balance that COULD fund two orders,
    // exactly one order + one debit landed.
    expect(await ordersForUser(userId)).toHaveLength(1);
    expect(await spendRowsForUser(userId)).toHaveLength(1);
    expect(await usdBalance(userId)).toBe(15_000n);
  });
});

describeIf('insertCreditOrderTxn — concurrency (FOR UPDATE balance lock)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  it('no oversell — two concurrent orders against a one-order balance: exactly one wins', async () => {
    const userId = await seedUserId('credit-writer-oversell@test.local');
    // Balance funds EXACTLY one 5000 order. The two orders use
    // distinct (null) idempotency keys, so the ONLY thing that can
    // stop the second is the FOR UPDATE balance re-read.
    await seedBalance(userId, 5_000n);

    const settled = await Promise.allSettled([
      insertCreditOrderTxn(baseValues(userId, { chargeMinor: 5000n })),
      insertCreditOrderTxn(baseValues(userId, { chargeMinor: 5000n })),
    ]);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    // Exactly one commits; the loser blocks on the row lock, re-reads
    // the now-zero balance, and throws InsufficientCreditError.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientCreditError);

    // The loser's order insert rolled back — exactly ONE order row
    // survives, and exactly ONE spend. Balance is drained to zero and
    // NEVER goes negative (which the user_credits_non_negative CHECK
    // would also have caught, but the lock prevents it landing at all).
    const orderRows = await ordersForUser(userId);
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0]!.state).toBe('paid');
    expect(await spendRowsForUser(userId)).toHaveLength(1);
    expect(await usdBalance(userId)).toBe(0n);
  });

  it('no lost update — two concurrent AFFORDABLE orders both debit; balance drops by both charges', async () => {
    const userId = await seedUserId('credit-writer-both@test.local');
    // Balance funds BOTH orders exactly. If the writer decremented from
    // a stale JS-read balance instead of the SQL expression under the
    // lock, one debit would be lost and the balance would settle at
    // 5000 instead of 0.
    await seedBalance(userId, 10_000n);

    const settled = await Promise.allSettled([
      insertCreditOrderTxn(baseValues(userId, { chargeMinor: 5000n })),
      insertCreditOrderTxn(baseValues(userId, { chargeMinor: 5000n })),
    ]);

    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);

    // Two orders, two spend rows, both debits applied — balance == 0.
    expect(await ordersForUser(userId)).toHaveLength(2);
    const spends = await spendRowsForUser(userId);
    expect(spends).toHaveLength(2);
    expect(spends.every((s) => s.amountMinor === -5000n)).toBe(true);
    expect(await usdBalance(userId)).toBe(0n);

    // Conservation under concurrency: balance == seed + sum(ledger).
    const ledgerSum = spends.reduce((acc, r) => acc + r.amountMinor, 0n);
    expect(10_000n + ledgerSum).toBe(0n);
  });
});
