/**
 * PAYOUT-TXHASHNULL-STRAND — auto-recovery of a stranded, never-submitted
 * exhausted payout (real postgres).
 *
 * A `submitted` row with `attempts >= maxAttempts` AND `tx_hash IS NULL`
 * matched NEITHER `listClaimablePayouts` clause (the watchdog clause needs
 * `attempts < max`; the exhausted-reclaim clause needs `tx_hash IS NOT
 * NULL`), so it wedged in `submitted` forever — recoverable stranded funds.
 * It arises only from a hard crash BETWEEN the attempts-bump commit and the
 * `onSigned` hash-persist, repeated until the budget exhausts.
 *
 * DOUBLE-PAY SAFETY: `tx_hash IS NULL` ⟺ `onSigned` never committed ⟺ NO
 * tx ever reached the network (`recordPayoutTxHash` commits strictly BEFORE
 * `server.submitTransaction` — payout-submit.ts), so nothing moved on-chain
 * and resetting is safe. A non-null `tx_hash` means something WAS anchored
 * → it must NEVER be reset by this path.
 *
 * These tests drive the real worker tick + real drizzle SQL against real
 * postgres; only the Stellar SDK submit + Horizon reads are mocked (the
 * external boundaries), same seams as the sibling payout-worker suite.
 *
 * `LOOP_E2E_DB=1` gate, same per-test truncate as the sibling suites.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

vi.mock('../../payments/payout-submit.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, submitPayout: vi.fn() };
});
vi.mock('../../payments/horizon.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    findOutboundPaymentByMemo: vi.fn(async () => null),
    getOutboundPaymentByTxHash: vi.fn(async () => null),
  };
});
// Synthetic G-addresses have no live Stellar account; stub the trustline
// probe to "established" so the submit path is reached (same as the sibling
// payout-worker integration suite).
class AlwaysTrustingMap extends Map<
  string,
  { code: string; issuer: string; balanceStroops: bigint; limitStroops: bigint }
> {
  override get(
    key: string,
  ): { code: string; issuer: string; balanceStroops: bigint; limitStroops: bigint } | undefined {
    const [code, issuer] = key.split('::');
    if (code === undefined || issuer === undefined) return undefined;
    return { code, issuer, balanceStroops: 0n, limitStroops: 1_000_000_000_000_000n };
  }
}
vi.mock('../../payments/horizon-trustlines.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getAccountTrustlines: vi.fn(async (account: string) => ({
      account,
      accountExists: true,
      trustlines: new AlwaysTrustingMap(),
      asOfMs: Date.now(),
    })),
  };
});
vi.mock('../../discord.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const noop = vi.fn();
  return {
    ...actual,
    notifyPayoutFailed: noop,
    notifyPayoutAwaitingTrustline: noop,
    notifyPayoutTxHashOverwriteRefused: noop,
    notifyAdminAudit: noop,
  };
});

import { db } from '../../db/client.js';
import { users, pendingPayouts } from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { runPayoutTick } from '../../payments/payout-worker.js';
import {
  listClaimablePayouts,
  resetStrandedSubmittedToPending,
} from '../../credits/pending-payouts.js';
import { submitPayout } from '../../payments/payout-submit.js';
import { findOutboundPaymentByMemo, getOutboundPaymentByTxHash } from '../../payments/horizon.js';
import {
  ensureMigrated,
  truncateAllTables,
  seedUserCreditsWithBackingLedger,
} from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

const MAX_ATTEMPTS = 5;
const DEFAULT_TICK_ARGS = {
  operatorSecret: 'STESTSECRET',
  operatorAccount: 'GTESTOPERATOR',
  horizonUrl: 'https://horizon-test.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  maxAttempts: MAX_ATTEMPTS,
  watchdogStaleSeconds: 300,
};

async function seedPayout(args: {
  state: 'submitted';
  attempts: number;
  submittedAt: Date;
  txHash: string | null;
}): Promise<string> {
  const user = await findOrCreateUserByEmail(`strand-${Date.now()}-${Math.random()}@test.local`);
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
      memoText: `strand-${Date.now()}-${Math.random()}`,
      state: args.state,
      attempts: args.attempts,
      submittedAt: args.submittedAt,
      txHash: args.txHash,
    })
    .returning({ id: pendingPayouts.id });
  if (row === undefined) throw new Error('seed: pending_payouts insert returned no row');
  return row.id;
}

async function readRow(
  id: string,
): Promise<{ state: string; attempts: number; txHash: string | null; submittedAt: Date | null }> {
  const [row] = await db
    .select({
      state: pendingPayouts.state,
      attempts: pendingPayouts.attempts,
      txHash: pendingPayouts.txHash,
      submittedAt: pendingPayouts.submittedAt,
    })
    .from(pendingPayouts)
    .where(eq(pendingPayouts.id, id));
  if (row === undefined) throw new Error('row vanished');
  return row;
}

const STALE = (): Date => new Date(Date.now() - 600_000); // 10 min ago

describeIf('PAYOUT-TXHASHNULL-STRAND (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
    vi.mocked(submitPayout).mockReset();
    vi.mocked(findOutboundPaymentByMemo).mockReset().mockResolvedValue(null);
    vi.mocked(getOutboundPaymentByTxHash).mockReset().mockResolvedValue(null);
  });

  it('auto-re-picks a submitted+attempts>=max+txHash-null row and RESETS it to pending', async () => {
    const id = await seedPayout({
      state: 'submitted',
      attempts: MAX_ATTEMPTS, // exhausted
      submittedAt: STALE(),
      txHash: null, // nothing ever submitted on-chain
    });

    const tick = await runPayoutTick(DEFAULT_TICK_ARGS);

    // Recovered, not re-submitted: no Stellar tx issued this tick.
    expect(vi.mocked(submitPayout)).not.toHaveBeenCalled();
    expect(tick.picked).toBe(1);
    expect(tick.retriedLater).toBe(1);

    // Reset to a fresh pending row: state pending, attempts 0, submittedAt cleared.
    const row = await readRow(id);
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.txHash).toBeNull();
    expect(row.submittedAt).toBeNull();
  });

  it('listClaimablePayouts re-picks the stranded row only once it is stale', async () => {
    const staleId = await seedPayout({
      state: 'submitted',
      attempts: MAX_ATTEMPTS,
      submittedAt: STALE(),
      txHash: null,
    });
    const freshId = await seedPayout({
      state: 'submitted',
      attempts: MAX_ATTEMPTS,
      submittedAt: new Date(), // NOT stale — a live worker may still be mid-submit
      txHash: null,
    });

    const claimable = await listClaimablePayouts({
      limit: 20,
      staleSeconds: 300,
      maxAttempts: MAX_ATTEMPTS,
    });
    const ids = claimable.map((r) => r.id);

    expect(ids).toContain(staleId);
    expect(ids).not.toContain(freshId);
  });

  it('NEVER resets a row whose tx hash is non-null (no double-pay)', async () => {
    // A row with a persisted hash means a tx WAS anchored (and may have
    // landed). The strand CAS must refuse it outright.
    const id = await seedPayout({
      state: 'submitted',
      attempts: MAX_ATTEMPTS,
      submittedAt: STALE(),
      txHash: 'anchored-hash',
    });

    const reset = await resetStrandedSubmittedToPending(id);
    expect(reset).toBeNull();

    // Row is untouched — still submitted, still anchored, attempts intact.
    const row = await readRow(id);
    expect(row.state).toBe('submitted');
    expect(row.txHash).toBe('anchored-hash');
    expect(row.attempts).toBe(MAX_ATTEMPTS);
  });

  it('a non-null-txHash exhausted row goes through the resolve path, never the strand reset', async () => {
    // Its prior tx actually landed (deep-lag convergence): the exhausted-
    // reclaim path converges it to `confirmed`. It is NEVER reset to pending
    // and NEVER re-submitted (double-pay guard).
    const id = await seedPayout({
      state: 'submitted',
      attempts: MAX_ATTEMPTS,
      submittedAt: STALE(),
      txHash: 'landed-hash',
    });
    vi.mocked(getOutboundPaymentByTxHash).mockResolvedValue({ landed: true });

    await runPayoutTick(DEFAULT_TICK_ARGS);

    expect(vi.mocked(submitPayout)).not.toHaveBeenCalled();
    const row = await readRow(id);
    expect(row.state).toBe('confirmed');
    expect(row.txHash).toBe('landed-hash');
  });
});
