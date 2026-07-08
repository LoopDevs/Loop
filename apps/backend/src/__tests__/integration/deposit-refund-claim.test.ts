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
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { creditTransactions, orders, paymentWatcherSkips, users } from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';
import { claimForRefund } from '../../payments/deposit-refund.js';
import { applyAdminRefund, RefundAlreadyIssuedError } from '../../credits/refunds.js';

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
  await db.insert(creditTransactions).values({
    userId,
    type: 'refund',
    amountMinor: 2500n,
    currency: 'USD',
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
