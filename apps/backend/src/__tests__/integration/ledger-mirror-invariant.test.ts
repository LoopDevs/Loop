/**
 * DAT-01-inv1 — DB-tier enforcement of the balance/ledger MIRROR
 * invariant (INV-1, real postgres, migration 0066).
 *
 * ADR 009 declares `user_credits.balance_minor` is a materialised sum of
 * the immutable `credit_transactions` ledger: for each (user, currency),
 * balance_minor == COALESCE(SUM(amount_minor), 0). Migration 0066 fences
 * that equality at the DB boundary with a `CONSTRAINT TRIGGER ...
 * DEFERRABLE INITIALLY DEFERRED` on BOTH sides of the mirror
 * (credit_transactions INSERT + user_credits INSERT/UPDATE), evaluated at
 * COMMIT. This suite drives the REAL trigger against real postgres —
 * it lives in the DB, not in any pure module.
 *
 * The load-bearing cases:
 *   1. A LEGITIMATE matched write (ledger INSERT + balance INSERT/UPDATE
 *      in ONE txn) COMMITS — even though the mirror is transiently
 *      UNEQUAL between the two statements. This is the critical
 *      regression guard: it proves the check is DEFERRED to commit and
 *      does NOT false-trigger on the intermediate state (an immediate
 *      per-statement trigger would abort the first statement).
 *   2. A DIVERGENT commit — a ledger row with no matching balance move,
 *      OR a balance move with no matching ledger row — is REJECTED at
 *      COMMIT with SQLSTATE 23M01.
 *   3. A zero-sum orphan (offsetting ledger rows, no balance row) still
 *      commits (0 == 0) — the constraint is equality, not "a balance row
 *      must exist".
 *   4. The per-test TRUNCATE reset does not fire the constraint trigger
 *      (row-op triggers, constraint or otherwise, never fire on TRUNCATE).
 *
 * `LOOP_E2E_DB=1` gate, same per-test truncate as the sibling suites.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

import { db } from '../../db/client.js';
import { users, creditTransactions, userCredits } from '../../db/schema.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

async function seedUser(tag: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `dat01-${tag}-${crypto.randomUUID()}@test.local` })
    .returning({ id: users.id });
  return row!.id;
}

async function ledgerSum(userId: string, currency: string): Promise<bigint> {
  const rows = await db
    .select({ amountMinor: creditTransactions.amountMinor })
    .from(creditTransactions)
    .where(and(eq(creditTransactions.userId, userId), eq(creditTransactions.currency, currency)));
  return rows.reduce((acc, r) => acc + r.amountMinor, 0n);
}

async function balanceOf(userId: string, currency: string): Promise<bigint | null> {
  const rows = await db
    .select({ balanceMinor: userCredits.balanceMinor })
    .from(userCredits)
    .where(and(eq(userCredits.userId, userId), eq(userCredits.currency, currency)));
  return rows[0]?.balanceMinor ?? null;
}

/**
 * Drives a query expected to be rejected by the deferred mirror trigger
 * at COMMIT and returns the RAISEd message + SQLSTATE. drizzle wraps the
 * postgres-js error; the trigger's real message + code live on the
 * `.cause` chain — walk it. (Same helper shape as ledger-immutability.)
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
  throw new Error('expected the commit to be rejected by the mirror trigger, but it resolved');
}

describeIf('DAT-01-inv1 balance/ledger mirror invariant (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  it('commits a legitimate matched write (ledger INSERT + balance INSERT in one txn) despite the transient intermediate imbalance', async () => {
    const userId = await seedUser('matched');

    // ONE transaction: append the ledger row FIRST (mirror is now 500 vs
    // 0 — transiently UNEQUAL), THEN materialise the balance row. An
    // IMMEDIATE trigger would abort at the first statement; the DEFERRED
    // trigger only checks at COMMIT, where the mirror balances.
    await db.transaction(async (tx) => {
      await tx
        .insert(creditTransactions)
        .values({ userId, type: 'cashback', amountMinor: 500n, currency: 'GBP' });
      await tx.insert(userCredits).values({ userId, currency: 'GBP', balanceMinor: 500n });
    });

    expect(await balanceOf(userId, 'GBP')).toBe(500n);
    expect(await ledgerSum(userId, 'GBP')).toBe(500n);
  });

  it('commits a subsequent matched write (new ledger row + balance UPDATE in one txn)', async () => {
    const userId = await seedUser('matched-update');
    await db.transaction(async (tx) => {
      await tx
        .insert(creditTransactions)
        .values({ userId, type: 'cashback', amountMinor: 500n, currency: 'GBP' });
      await tx.insert(userCredits).values({ userId, currency: 'GBP', balanceMinor: 500n });
    });

    // Spend 200 in one txn: ledger -200 + balance 500 -> 300.
    await db.transaction(async (tx) => {
      await tx
        .insert(creditTransactions)
        .values({ userId, type: 'spend', amountMinor: -200n, currency: 'GBP' });
      await tx
        .update(userCredits)
        .set({ balanceMinor: 300n })
        .where(and(eq(userCredits.userId, userId), eq(userCredits.currency, 'GBP')));
    });

    expect(await balanceOf(userId, 'GBP')).toBe(300n);
    expect(await ledgerSum(userId, 'GBP')).toBe(300n);
  });

  it('rejects a ledger INSERT with no matching balance move at COMMIT (23M01)', async () => {
    const userId = await seedUser('ledger-only');
    // A lone ledger append (autocommit) — its own transaction. balance is
    // 0 (no row), ledger sums to 500 -> the deferred check RAISEs at the
    // implicit commit.
    const rejection = await expectDbReject(
      db
        .insert(creditTransactions)
        .values({ userId, type: 'cashback', amountMinor: 500n, currency: 'GBP' }),
    );
    expect(rejection.code).toBe('23M01');
    expect(rejection.text).toMatch(/mirror invariant \(INV-1\)/i);

    // Aborted: nothing persisted.
    expect(await ledgerSum(userId, 'GBP')).toBe(0n);
    expect(await balanceOf(userId, 'GBP')).toBeNull();
  });

  it('rejects a balance UPDATE with no matching ledger row at COMMIT (23M01)', async () => {
    const userId = await seedUser('balance-only');
    // Establish a consistent starting state (balance 100 + ledger 100).
    await db.transaction(async (tx) => {
      await tx
        .insert(creditTransactions)
        .values({ userId, type: 'cashback', amountMinor: 100n, currency: 'GBP' });
      await tx.insert(userCredits).values({ userId, currency: 'GBP', balanceMinor: 100n });
    });

    // Now move the balance to 999 WITHOUT a matching ledger row -> the
    // running balance diverges from the immutable ledger -> rejected.
    const rejection = await expectDbReject(
      db
        .update(userCredits)
        .set({ balanceMinor: 999n })
        .where(and(eq(userCredits.userId, userId), eq(userCredits.currency, 'GBP'))),
    );
    expect(rejection.code).toBe('23M01');
    expect(rejection.text).toMatch(/mirror invariant \(INV-1\)/i);

    // The abort rolled it back — the balance still mirrors the ledger.
    expect(await balanceOf(userId, 'GBP')).toBe(100n);
    expect(await ledgerSum(userId, 'GBP')).toBe(100n);
  });

  it('commits a zero-sum orphan (offsetting ledger rows, no balance row) — equality, not row-existence', async () => {
    const userId = await seedUser('zero-sum');
    // Two offsetting rows in one txn, NO user_credits row. balance (0)
    // == ledger sum (0), so the mirror holds and the commit lands.
    await db.transaction(async (tx) => {
      await tx
        .insert(creditTransactions)
        .values({ userId, type: 'cashback', amountMinor: 100n, currency: 'GBP' });
      await tx
        .insert(creditTransactions)
        .values({ userId, type: 'spend', amountMinor: -100n, currency: 'GBP' });
    });

    expect(await ledgerSum(userId, 'GBP')).toBe(0n);
    expect(await balanceOf(userId, 'GBP')).toBeNull();
  });

  it('does not fire the constraint trigger on TRUNCATE (per-test reset stays clean)', async () => {
    const userId = await seedUser('truncate');
    await db.transaction(async (tx) => {
      await tx
        .insert(creditTransactions)
        .values({ userId, type: 'cashback', amountMinor: 700n, currency: 'GBP' });
      await tx.insert(userCredits).values({ userId, currency: 'GBP', balanceMinor: 700n });
    });

    // A TRUNCATE removes rows without firing row-op triggers — including
    // this constraint trigger — so the harness reset never RAISEs and
    // both tables come back empty.
    await db.execute(sql`TRUNCATE credit_transactions, user_credits CASCADE`);

    expect(await ledgerSum(userId, 'GBP')).toBe(0n);
    expect(await balanceOf(userId, 'GBP')).toBeNull();
  });
});
