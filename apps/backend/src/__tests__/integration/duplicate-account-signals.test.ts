/**
 * Duplicate-account funding-source detection — real-postgres integration
 * (ADR 045 §2, finding DOM-related).
 *
 * Proves that `RELATED_USER_LIMIT` bounds the number of distinct related
 * USERS the detector considers, NOT the raw order-row count. The pre-fix
 * query put the `LIMIT` on the un-aggregated order rows, so a single
 * related user with more orders-from-the-shared-source than the limit
 * filled every slot and silently hid the other related users — the exact
 * signal the detector exists to surface. The fix (`SELECT DISTINCT ON
 * (user_id) ... LIMIT n`) caps distinct users instead.
 *
 * Gated on `LOOP_E2E_DB=1` like the sibling integration suites.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

// The detector pages Discord on a fresh signal; stub it so the test
// asserts behaviour without a live webhook.
const { notifyMock } = vi.hoisted(() => ({ notifyMock: vi.fn() }));
vi.mock('../../discord.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, notifyDuplicateAccountSignal: notifyMock };
});

import { db } from '../../db/client.js';
import { orders, fraudSignals } from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { checkDuplicateFundingSource } from '../../fraud/duplicate-account-signals.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

/** Inserts one paid, on-chain-funded order and returns its id. */
async function seedPaidOrder(userId: string, sourceAccount: string, memo: string): Promise<string> {
  const [row] = await db
    .insert(orders)
    .values({
      userId,
      merchantId: 'amazon',
      faceValueMinor: 5000n,
      currency: 'USD',
      chargeMinor: 5000n,
      chargeCurrency: 'USD',
      paymentMethod: 'xlm',
      paymentMemo: memo,
      // The detector matches on payment_received_payment->>'from'.
      paymentReceivedPayment: { from: sourceAccount },
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      wholesaleMinor: 3500n,
      userCashbackMinor: 250n,
      loopMarginMinor: 1250n,
      state: 'paid',
    })
    .returning({ id: orders.id });
  return row!.id;
}

describeIf('checkDuplicateFundingSource — distinct-user cap (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    notifyMock.mockReset();
  });

  it('caps DISTINCT related users, not order rows — a many-order related user does not crowd out others', async () => {
    const u0 = await findOrCreateUserByEmail('dup-trigger@test.local');
    const u1 = await findOrCreateUserByEmail('dup-heavy@test.local');
    const u2 = await findOrCreateUserByEmail('dup-single@test.local');
    const SRC = 'GSHAREDWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    // U1 has 6 orders from the shared source — one MORE than
    // RELATED_USER_LIMIT (5) — all inserted BEFORE U2's single order, so
    // the pre-fix `LIMIT 5` on order rows returns only U1's orders and
    // never reaches U2.
    for (let i = 0; i < 6; i++) {
      await seedPaidOrder(u1.id, SRC, `memo-u1-${i}`);
    }
    // U2 has exactly one order from the same source, inserted LAST.
    await seedPaidOrder(u2.id, SRC, 'memo-u2-0');
    // The triggering order belongs to U0, also funded from the source.
    const triggerOrderId = await seedPaidOrder(u0.id, SRC, 'memo-u0-0');

    await checkDuplicateFundingSource({
      userId: u0.id,
      orderId: triggerOrderId,
      sourceAccount: SRC,
    });

    const signals = await db
      .select({ userId: fraudSignals.userId, relatedUserId: fraudSignals.relatedUserId })
      .from(fraudSignals);

    // Both related users must be flagged against U0 — the many-order U1
    // must NOT crowd out the single-order U2.
    expect(signals).toHaveLength(2);
    const related = new Set<string>();
    for (const s of signals) {
      related.add(s.userId);
      if (s.relatedUserId !== null) related.add(s.relatedUserId);
    }
    related.delete(u0.id);
    expect(related).toEqual(new Set([u1.id, u2.id]));
    // A fresh signal per distinct related user pages ops once each.
    expect(notifyMock).toHaveBeenCalledTimes(2);
  });

  it('still honours the cap as a bound on distinct USERS (>5 related users → 5 flagged)', async () => {
    const u0 = await findOrCreateUserByEmail('dup-cap-trigger@test.local');
    const SRC = 'GCAPWALLETBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    // Seven distinct related users, one order each — the cap should
    // surface exactly RELATED_USER_LIMIT (5) of them, bounding the fan-out.
    const related: string[] = [];
    for (let i = 0; i < 7; i++) {
      const u = await findOrCreateUserByEmail(`dup-cap-${i}@test.local`);
      related.push(u.id);
      await seedPaidOrder(u.id, SRC, `memo-cap-${i}`);
    }
    const triggerOrderId = await seedPaidOrder(u0.id, SRC, 'memo-cap-trigger');

    await checkDuplicateFundingSource({
      userId: u0.id,
      orderId: triggerOrderId,
      sourceAccount: SRC,
    });

    const signals = await db.select({ id: fraudSignals.id }).from(fraudSignals);
    expect(signals).toHaveLength(5);
  });
});
