/**
 * DAT-06 — ledger-invariant zero-sum orphan detection (real postgres).
 *
 * `computeLedgerDriftSql`'s transaction-side anchor emits orphan rows
 * (`credit_transactions` with no matching `user_credits` row). Before
 * DAT-06 a zero-sum orphan (offsetting rows, e.g. `+100`/`-100`)
 * surfaced as `{balance:0, ledger:0, delta:0}` — numerically identical
 * to a clean ledger, so it read as clean and got dismissed. The
 * `orphan` flag now qualifies it as drift regardless of the collapsed
 * net sum. This test drives the REAL SQL against real postgres because
 * the collapse (`SUM(amount_minor)` grouping) is a property of the
 * query, not of the pure mirror.
 *
 * `LOOP_E2E_DB=1` gate, same per-test truncate as the sibling suites.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

import { db } from '../../db/client.js';
import { users, creditTransactions, userCredits } from '../../db/schema.js';
import { computeLedgerDriftSql } from '../../credits/ledger-invariant.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

async function seedUser(email: string): Promise<string> {
  const [row] = await db.insert(users).values({ email }).returning({ id: users.id });
  return row!.id;
}

describeIf('DAT-06 ledger-invariant zero-sum orphan (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  it('flags a zero-sum orphan (offsetting rows, no user_credits row) as drift with orphan=true', async () => {
    const userId = await seedUser(`dat06-orphan-${crypto.randomUUID()}@test.local`);
    // Orphan: two offsetting credit_transactions, NO user_credits row.
    await db.insert(creditTransactions).values([
      { userId, type: 'cashback', amountMinor: 100n, currency: 'GBP' },
      { userId, type: 'spend', amountMinor: -100n, currency: 'GBP' },
    ]);

    const drift = await computeLedgerDriftSql(db);

    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      userId,
      currency: 'GBP',
      balanceMinor: '0',
      ledgerSumMinor: '0',
      deltaMinor: '0',
      orphan: true,
    });
  });

  it('disambiguates an orphan from a genuine balance_minor=0 mismatch (orphan flag)', async () => {
    // A materialised balance row of 0 that disagrees with a non-zero
    // ledger sum. Same `balanceMinor:"0"` as an orphan, but a real row
    // exists — so it must NOT carry orphan=true.
    const userId = await seedUser(`dat06-zerobal-${crypto.randomUUID()}@test.local`);
    await db.insert(userCredits).values({ userId, currency: 'GBP', balanceMinor: 0n });
    await db
      .insert(creditTransactions)
      .values({ userId, type: 'cashback', amountMinor: 50n, currency: 'GBP' });

    const drift = await computeLedgerDriftSql(db);

    expect(drift).toHaveLength(1);
    expect(drift[0]?.deltaMinor).toBe('-50');
    expect(drift[0]?.orphan).toBeUndefined();
  });
});
