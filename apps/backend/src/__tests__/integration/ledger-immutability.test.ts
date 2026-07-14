/**
 * FT-13 — DB-tier ledger immutability (real postgres, migration 0064).
 *
 * `credit_transactions` is the append-only financial ledger. Migration
 * 0064 adds `BEFORE UPDATE OR DELETE` and `BEFORE DELETE` triggers that
 * RAISE, so no writer — app or manual SQL — can mutate a booked ledger
 * row or delete a running-balance row out from under it. This drives
 * the REAL triggers against real postgres because they live in the DB,
 * not in any pure module.
 *
 * We assert BOTH the forbidden operations are rejected AND that the
 * legitimate money paths still work: a fresh ledger INSERT lands, and a
 * `user_credits.balance_minor` UPDATE (the running-balance projection
 * every transaction moves) is untouched by the fence.
 *
 * `LOOP_E2E_DB=1` gate, same per-test truncate as the sibling suites.
 * (Row-level UPDATE/DELETE triggers do NOT fire on TRUNCATE, so the
 * per-test reset is unaffected.)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

import { db } from '../../db/client.js';
import { users, creditTransactions, userCredits } from '../../db/schema.js';
import {
  ensureMigrated,
  truncateAllTables,
  seedUserCreditsWithBackingLedger,
} from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

async function seedUser(email: string): Promise<string> {
  const [row] = await db.insert(users).values({ email }).returning({ id: users.id });
  return row!.id;
}

async function insertLedgerRow(userId: string): Promise<string> {
  // DAT-01-inv1 (migration 0066): seed the booked ledger row together
  // with its matching 500 balance in ONE txn so the mirror is equal at
  // commit; return the ledger row id for the immutability (UPDATE/DELETE)
  // attempts below (those target the credit_transactions row only).
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(creditTransactions)
      .values({ userId, type: 'cashback', amountMinor: 500n, currency: 'GBP' })
      .returning({ id: creditTransactions.id });
    await tx.insert(userCredits).values({ userId, currency: 'GBP', balanceMinor: 500n });
    return row!.id;
  });
}

/**
 * Drives a query expected to be rejected by a DB trigger and returns
 * the RAISEd message + SQLSTATE. drizzle wraps the postgres-js error in
 * a DrizzleQueryError whose top-level `.message` is a generic
 * "Failed query…"; the trigger's real message + code live on the
 * `.cause` chain — walk it so the assertion sees the RAISE text.
 */
async function expectDbReject(p: Promise<unknown>): Promise<{ text: string; code: string }> {
  try {
    await p;
  } catch (e) {
    let text = '';
    let code = '';
    let cur: unknown = e;
    while (cur !== null && cur !== undefined) {
      const node = cur as { message?: string; code?: string; cause?: unknown };
      if (typeof node.message === 'string') text += ` ${node.message}`;
      if (typeof node.code === 'string' && code === '') code = node.code;
      cur = node.cause;
    }
    return { text, code };
  }
  throw new Error('expected the query to be rejected by the DB trigger, but it resolved');
}

describeIf('FT-13 ledger immutability (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  it('rejects an UPDATE of a booked credit_transactions row and leaves it untouched', async () => {
    const userId = await seedUser(`ft13-upd-${crypto.randomUUID()}@test.local`);
    const id = await insertLedgerRow(userId);

    const rejection = await expectDbReject(
      db.execute(sql`UPDATE credit_transactions SET amount_minor = 999999 WHERE id = ${id}`),
    );
    expect(rejection.text).toMatch(/append-only/i);
    expect(rejection.code).toBe('23001'); // restrict_violation

    // The abort rolled the whole statement back — the row is unchanged.
    const after = await db
      .select({ amt: creditTransactions.amountMinor })
      .from(creditTransactions)
      .where(eq(creditTransactions.id, id));
    expect(after).toHaveLength(1);
    expect(after[0]?.amt).toBe(500n);
  });

  it('rejects a DELETE of a booked credit_transactions row and leaves it in place', async () => {
    const userId = await seedUser(`ft13-del-${crypto.randomUUID()}@test.local`);
    const id = await insertLedgerRow(userId);

    const rejection = await expectDbReject(
      db.execute(sql`DELETE FROM credit_transactions WHERE id = ${id}`),
    );
    expect(rejection.text).toMatch(/append-only/i);
    expect(rejection.code).toBe('23001'); // restrict_violation

    const after = await db
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(eq(creditTransactions.id, id));
    expect(after).toHaveLength(1);
  });

  it('still allows a fresh append (INSERT) to the ledger', async () => {
    const userId = await seedUser(`ft13-ins-${crypto.randomUUID()}@test.local`);
    const id = await insertLedgerRow(userId);
    // A second, offsetting append (the ONLY legitimate way to correct
    // the ledger) also lands — immutability blocks mutation, not growth.
    // Under the DAT-01-inv1 mirror invariant a legitimate append is a
    // MATCHED write, so pair the -200 spend with its balance move (→300)
    // in one txn; it commits, proving the fresh INSERT is still allowed.
    const spend = await db.transaction(async (tx) => {
      const [s] = await tx
        .insert(creditTransactions)
        .values({ userId, type: 'spend', amountMinor: -200n, currency: 'GBP' })
        .returning({ id: creditTransactions.id });
      await tx
        .update(userCredits)
        .set({ balanceMinor: 300n })
        .where(eq(userCredits.userId, userId));
      return s;
    });
    expect(id).toBeTruthy();
    expect(spend?.id).toBeTruthy();
    const rows = await db
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId));
    expect(rows).toHaveLength(2);
  });

  it('still allows a legitimate user_credits balance UPDATE (running-balance projection)', async () => {
    const userId = await seedUser(`ft13-bal-${crypto.randomUUID()}@test.local`);
    // Consistent starting mirror: balance 500 backed by a matching 500
    // opening-balance ledger row (DAT-01-inv1, migration 0066).
    await seedUserCreditsWithBackingLedger(db, { userId, currency: 'GBP', balanceMinor: 500n });

    // The move every transaction makes — a running-balance UPDATE — must
    // NOT be blocked by the 0064 immutability fence (which guards
    // credit_transactions mutation + user_credits DELETE, never a balance
    // UPDATE). Under the DAT-01-inv1 mirror invariant a LEGITIMATE balance
    // move is a MATCHED write: append a +300 ledger row AND update the
    // balance to 800 in ONE transaction. It commits — proving 0064 leaves
    // the balance UPDATE untouched — and the mirror stays equal
    // (800 == 500 + 300).
    await db.transaction(async (tx) => {
      await tx
        .insert(creditTransactions)
        .values({ userId, type: 'cashback', amountMinor: 300n, currency: 'GBP' });
      await tx
        .update(userCredits)
        .set({ balanceMinor: 800n })
        .where(eq(userCredits.userId, userId));
    });

    const after = await db
      .select({ bal: userCredits.balanceMinor })
      .from(userCredits)
      .where(eq(userCredits.userId, userId));
    expect(after[0]?.bal).toBe(800n);
  });

  it('rejects a DELETE of a user_credits balance row (would orphan the ledger)', async () => {
    const userId = await seedUser(`ft13-ucdel-${crypto.randomUUID()}@test.local`);
    // Consistent starting mirror (DAT-01-inv1): balance 500 backed by a
    // matching 500 ledger row. The DELETE below is rejected by the 0064
    // no-delete fence BEFORE it could orphan that ledger.
    await seedUserCreditsWithBackingLedger(db, { userId, currency: 'GBP', balanceMinor: 500n });

    const rejection = await expectDbReject(
      db.execute(sql`DELETE FROM user_credits WHERE user_id = ${userId} AND currency = 'GBP'`),
    );
    expect(rejection.text).toMatch(/forbidden/i);
    expect(rejection.code).toBe('23001'); // restrict_violation

    const after = await db
      .select({ bal: userCredits.balanceMinor })
      .from(userCredits)
      .where(eq(userCredits.userId, userId));
    expect(after).toHaveLength(1);
    expect(after[0]?.bal).toBe(500n);
  });
});
