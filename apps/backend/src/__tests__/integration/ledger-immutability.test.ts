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
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

async function seedUser(email: string): Promise<string> {
  const [row] = await db.insert(users).values({ email }).returning({ id: users.id });
  return row!.id;
}

async function insertLedgerRow(userId: string): Promise<string> {
  const [row] = await db
    .insert(creditTransactions)
    .values({ userId, type: 'cashback', amountMinor: 500n, currency: 'GBP' })
    .returning({ id: creditTransactions.id });
  return row!.id;
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
    const [spend] = await db
      .insert(creditTransactions)
      .values({ userId, type: 'spend', amountMinor: -200n, currency: 'GBP' })
      .returning({ id: creditTransactions.id });
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
    await db.insert(userCredits).values({ userId, currency: 'GBP', balanceMinor: 500n });

    // This is the move every transaction makes — it must NOT be blocked.
    await db
      .update(userCredits)
      .set({ balanceMinor: 800n })
      .where(eq(userCredits.userId, userId));

    const after = await db
      .select({ bal: userCredits.balanceMinor })
      .from(userCredits)
      .where(eq(userCredits.userId, userId));
    expect(after[0]?.bal).toBe(800n);
  });

  it('rejects a DELETE of a user_credits balance row (would orphan the ledger)', async () => {
    const userId = await seedUser(`ft13-ucdel-${crypto.randomUUID()}@test.local`);
    await db.insert(userCredits).values({ userId, currency: 'GBP', balanceMinor: 500n });

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
