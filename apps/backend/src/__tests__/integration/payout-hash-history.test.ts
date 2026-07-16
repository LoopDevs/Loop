/**
 * PAYOUT-HASHHISTORY — durable tx-hash anchor + append-only history
 * (real postgres).
 *
 * `pending_payouts.tx_hash` is the DURABLE ANCHOR to the funds that FIRST
 * moved (CF-18: persisted in `onSigned`, BEFORE the network submit). Under
 * deep Horizon ingestion lag the FT-05 expiry guard can clear (a landed tx
 * still reads 404 past its timebound) and the re-submit path signs a fresh
 * hash — the OLD behaviour OVERWROTE the anchor, losing the durable link to
 * value already on-chain.
 *
 * `recordPayoutTxHash` now REFUSES to overwrite a differing non-null anchor
 * and appends every signed hash to the append-only `payout_tx_hashes`
 * ledger, so the anchor is preserved AND the full submit history is
 * queryable for reconciliation. These tests drive the real transition
 * against real postgres (only the migration + drizzle state guards + the
 * new table are involved — no Horizon / SDK boundary).
 *
 * `LOOP_E2E_DB=1` gate, same per-test truncate as the sibling suites.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

import { db } from '../../db/client.js';
import { users, pendingPayouts, payoutTxHashes } from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { recordPayoutTxHash, markPayoutConfirmed } from '../../credits/pending-payouts.js';
import {
  ensureMigrated,
  truncateAllTables,
  seedUserCreditsWithBackingLedger,
} from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

/**
 * Seeds a `submitted` emission payout row (attempts as given, no tx hash).
 * Mirrors the sibling payout-worker suite's seed: an emission of 500 minor
 * backed by a matching mirror balance so the emission-conservation trigger
 * is satisfied.
 */
async function seedSubmittedPayout(attempts: number): Promise<string> {
  const user = await findOrCreateUserByEmail(`hashhist-${Date.now()}-${Math.random()}@test.local`);
  await db.update(users).set({ homeCurrency: 'USD' }).where(eq(users.id, user.id));
  await seedUserCreditsWithBackingLedger(db, {
    userId: user.id,
    currency: 'USD',
    balanceMinor: 500n,
  });
  const [row] = await db
    .insert(pendingPayouts)
    .values({
      userId: user.id,
      kind: 'emission',
      assetCode: 'USDLOOP',
      assetIssuer: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      toAddress: 'GUSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      amountStroops: 50_000_000n,
      memoText: `hashhist-${Date.now()}`,
      state: 'submitted',
      attempts,
      submittedAt: new Date(),
    })
    .returning({ id: pendingPayouts.id });
  if (row === undefined) throw new Error('seed: pending_payouts insert returned no row');
  return row.id;
}

async function readTxHash(id: string): Promise<string | null> {
  const [row] = await db
    .select({ txHash: pendingPayouts.txHash })
    .from(pendingPayouts)
    .where(eq(pendingPayouts.id, id));
  return row?.txHash ?? null;
}

async function readHistory(
  id: string,
): Promise<Array<{ txHash: string; reason: string; attempt: number }>> {
  return db
    .select({
      txHash: payoutTxHashes.txHash,
      reason: payoutTxHashes.reason,
      attempt: payoutTxHashes.attempt,
    })
    .from(payoutTxHashes)
    .where(eq(payoutTxHashes.payoutId, id))
    .orderBy(asc(payoutTxHashes.recordedAt));
}

describeIf('PAYOUT-HASHHISTORY (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  it('first hash write stamps the anchor and records history (happy path unchanged)', async () => {
    const id = await seedSubmittedPayout(3);

    const res = await recordPayoutTxHash({ id, txHash: 'hash-A' });

    expect(res.row).not.toBeNull();
    expect(res.overwriteRefused).toBe(false);
    expect(res.existingTxHash).toBeNull();

    // Anchor stamped on the row — exactly the pre-change happy path.
    expect(await readTxHash(id)).toBe('hash-A');

    // History carries the first hash, tagged + attempt-stamped.
    const history = await readHistory(id);
    expect(history).toEqual([{ txHash: 'hash-A', reason: 'first-submit', attempt: 3 }]);
  });

  it('a second DIFFERING hash write does NOT overwrite the anchor; history records both', async () => {
    const id = await seedSubmittedPayout(1);
    await recordPayoutTxHash({ id, txHash: 'hash-A' });

    // Simulate the re-submit path signing a fresh hash on the same row.
    const res = await recordPayoutTxHash({ id, txHash: 'hash-B' });

    // Refusal signalled to the caller (which pages ops).
    expect(res.row).not.toBeNull();
    expect(res.overwriteRefused).toBe(true);
    expect(res.existingTxHash).toBe('hash-A');

    // THE FIX: the durable anchor is PRESERVED (not overwritten with hash-B).
    expect(await readTxHash(id)).toBe('hash-A');

    // History records BOTH hashes; the second is tagged as a refused resubmit.
    const history = await readHistory(id);
    expect(history).toEqual([
      { txHash: 'hash-A', reason: 'first-submit', attempt: 1 },
      { txHash: 'hash-B', reason: 'resubmit-refused', attempt: 1 },
    ]);
  });

  it('re-recording the SAME anchor hash is idempotent (no duplicate history row)', async () => {
    const id = await seedSubmittedPayout(2);
    await recordPayoutTxHash({ id, txHash: 'hash-A' });

    const res = await recordPayoutTxHash({ id, txHash: 'hash-A' });

    expect(res.overwriteRefused).toBe(false);
    expect(await readTxHash(id)).toBe('hash-A');
    // The (payout_id, tx_hash) unique makes the repeat an ON CONFLICT no-op.
    expect(await readHistory(id)).toEqual([
      { txHash: 'hash-A', reason: 'first-submit', attempt: 2 },
    ]);
  });

  it('a row no longer in `submitted` races to null (submit aborts) and writes no history', async () => {
    const id = await seedSubmittedPayout(1);
    // Move the row out of `submitted` (a concurrent confirm).
    await markPayoutConfirmed({ id, txHash: 'confirmed-hash' });

    const res = await recordPayoutTxHash({ id, txHash: 'hash-A' });

    expect(res.row).toBeNull();
    expect(res.overwriteRefused).toBe(false);
    // markPayoutConfirmed set the confirmed hash; recordPayoutTxHash left it.
    expect(await readTxHash(id)).toBe('confirmed-hash');
    // No history row was appended for a row we did not own.
    const history = await db
      .select({ txHash: payoutTxHashes.txHash })
      .from(payoutTxHashes)
      .where(and(eq(payoutTxHashes.payoutId, id)));
    expect(history).toEqual([]);
  });
});
