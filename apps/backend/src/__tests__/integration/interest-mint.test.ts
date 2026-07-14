/**
 * Interest-mint integration tests on real postgres (ADR 031 / ADR 036
 * Phase D, Q6-6).
 *
 * `credits/__tests__/interest-mint.test.ts` (the unit suite) mocks the
 * DB entirely, so it can pin the accrual/carry MATH and the call
 * shape but cannot prove three things that only show up against a
 * real ledger:
 *
 *   1. **The per-user idempotency fence actually reads what a prior
 *      run committed.** `mintOneUser` orders by `period_cursor DESC
 *      LIMIT 1` on `interest_mint_snapshots` to find the carry AND to
 *      detect "already processed this period" — a real crash-
 *      recovery re-run (cursor unadvanced, some users already
 *      minted) needs a real committed row from a real prior
 *      transaction to skip correctly. A mock can only assert the
 *      query shape, not that postgres actually returns the row.
 *   2. **The real Drizzle-wrapped unique-violation shape.** AUDIT-2
 *      finding D: the mint's crash-recovery catch used to
 *      string-match `err.message`, which never matches postgres-js's
 *      real error (the constraint violation lives on `err.cause`,
 *      not the top-level message — see `db/errors.ts`). The unit
 *      test can only construct a HAND-BUILT fake wrapped error; this
 *      suite provokes a REAL `23505` from the REAL
 *      `interest_mint_snapshots_user_asset_period_unique` index and
 *      classifies THAT.
 *   3. **The fleet-wide advisory lock (S4-3) actually excludes a
 *      second machine.** `withAdvisoryLock` takes a real
 *      `pg_try_advisory_lock` on a dedicated reserved connection —
 *      only a second real postgres session can prove a concurrent
 *      holder is excluded.
 *
 * What's mocked: `getAccountTrustlines` (Horizon) — the only external
 * boundary. Everything else — the users table, the two idempotency
 * unique indexes, the snapshot CHECK constraints, the advisory lock,
 * the mirror (`credit_transactions` + `user_credits`), and the
 * `pending_payouts` mint-intent row — is real postgres, real Hono-
 * adjacent (well, no HTTP layer here — this worker has no route) app
 * code.
 *
 * GBPLOOP issuer + secret are a real (but synthetic, never funded)
 * Stellar keypair generated fresh per test process in
 * `vitest-integration-setup.ts` — required so `resolveIssuerSigners()`
 * (env.ts's ADR-031 cross-field boot check re-asserted at read time)
 * actually resolves a signer for GBPLOOP; without it
 * `runInterestMintTick` filters GBPLOOP out of the mintable-asset
 * list and every test below would vacuously no-op.
 *
 * Gated on `LOOP_E2E_DB=1` like the sibling integration suites.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Keypair } from '@stellar/stellar-sdk';
import type * as HorizonTrustlinesModule from '../../payments/horizon-trustlines.js';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

const { trustlineBalances } = vi.hoisted(() => ({
  // account (wallet address) -> GBPLOOP balance in stroops. Absent =
  // no trustline (mirrors a fresh/unfunded wallet).
  trustlineBalances: new Map<string, bigint>(),
}));

vi.mock('../../payments/horizon-trustlines.js', async (importActual) => {
  const actual = await importActual<typeof HorizonTrustlinesModule>();
  return {
    ...actual,
    getAccountTrustlines: vi.fn(async (account: string) => {
      const balanceStroops = trustlineBalances.get(account);
      if (balanceStroops === undefined) {
        return {
          account,
          accountExists: false,
          trustlines: new Map(),
          asOfMs: Date.now(),
        };
      }
      const issuer = process.env['LOOP_STELLAR_GBPLOOP_ISSUER']!;
      return {
        account,
        accountExists: true,
        trustlines: new Map([
          [
            `GBPLOOP::${issuer}`,
            { code: 'GBPLOOP', issuer, balanceStroops, limitStroops: 10n ** 15n },
          ],
        ]),
        asOfMs: Date.now(),
      };
    }),
  };
});

import { db, withAdvisoryLock } from '../../db/client.js';
import {
  users,
  interestMintSnapshots,
  creditTransactions,
  userCredits,
  pendingPayouts,
  watcherCursors,
} from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';
import { computeLedgerDriftSql } from '../../credits/ledger-invariant.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getAccountTrustlines } from '../../payments/horizon-trustlines.js';
import {
  runInterestMintTick,
  utcPeriodCursor,
  INTEREST_MINT_CURSOR_NAME,
} from '../../credits/interest-mint.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

const DAY_1 = new Date('2026-01-01T02:00:00Z');
const DAY_2 = new Date('2026-01-02T02:00:00Z');
const PERIOD_1 = utcPeriodCursor(DAY_1);
const PERIOD_2 = utcPeriodCursor(DAY_2);

/**
 * Test-only mirror of `interestMintLockKey()` (private,
 * `credits/interest-mint.ts`) — deliberately NOT exported (that
 * module keeps its lock-key derivation internal), so the S4-3
 * single-flight test below re-derives the identical bigint from the
 * SAME inputs (byte-for-byte) to take the SAME real Postgres advisory
 * lock from a second connection. Pure hash math, no production
 * behavior depends on this copy.
 */
function interestMintLockKeyForTest(): bigint {
  const digest = createHash('sha256').update('loop:interest-mint-worker').digest();
  const raw =
    (BigInt(digest[0]!) << 56n) |
    (BigInt(digest[1]!) << 48n) |
    (BigInt(digest[2]!) << 40n) |
    (BigInt(digest[3]!) << 32n) |
    (BigInt(digest[4]!) << 24n) |
    (BigInt(digest[5]!) << 16n) |
    (BigInt(digest[6]!) << 8n) |
    BigInt(digest[7]!);
  return BigInt.asIntN(64, raw);
}

/** Creates an activated-wallet user. Home currency is irrelevant to
 * mint eligibility (that's asset-holding-driven, not preference-
 * driven) so it's left at the schema default. */
async function seedActivatedUser(): Promise<{ id: string; walletAddress: string }> {
  const email = `interest-mint-${crypto.randomUUID()}@test.local`;
  const user = await findOrCreateUserByEmail(email);
  const walletAddress = Keypair.random().publicKey();
  await db
    .update(users)
    .set({
      walletProvider: 'privy',
      walletId: `wallet-${crypto.randomUUID()}`,
      walletAddress,
      walletProvisioning: 'activated',
    })
    .where(eq(users.id, user.id));
  return { id: user.id, walletAddress };
}

async function snapshotsFor(
  userId: string,
): Promise<(typeof interestMintSnapshots.$inferSelect)[]> {
  return db
    .select()
    .from(interestMintSnapshots)
    .where(
      and(eq(interestMintSnapshots.userId, userId), eq(interestMintSnapshots.assetCode, 'GBPLOOP')),
    )
    .orderBy(interestMintSnapshots.periodCursor);
}

async function creditRowsFor(userId: string): Promise<(typeof creditTransactions.$inferSelect)[]> {
  return db
    .select()
    .from(creditTransactions)
    .where(and(eq(creditTransactions.userId, userId), eq(creditTransactions.type, 'interest')));
}

async function payoutRowsFor(userId: string): Promise<(typeof pendingPayouts.$inferSelect)[]> {
  return db
    .select()
    .from(pendingPayouts)
    .where(and(eq(pendingPayouts.userId, userId), eq(pendingPayouts.kind, 'interest_mint')));
}

async function balanceOf(userId: string): Promise<bigint | undefined> {
  const [row] = await db
    .select()
    .from(userCredits)
    .where(and(eq(userCredits.userId, userId), eq(userCredits.currency, 'GBP')));
  return row?.balanceMinor;
}

async function cursor(): Promise<string | null> {
  const [row] = await db
    .select()
    .from(watcherCursors)
    .where(eq(watcherCursors.name, INTEREST_MINT_CURSOR_NAME));
  return row?.cursor ?? null;
}

describeIf('interest-mint integration — real postgres (Q6-6)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    trustlineBalances.clear();
    vi.mocked(getAccountTrustlines).mockClear();
  });

  // Hardening C7 (mirrors admin-writes.test.ts / flywheel.test.ts):
  // every money-writing flow in this suite must leave the mirror
  // consistent with the credit_transactions sum. Interest-mint moves
  // BOTH the on-chain-intent (pending_payouts) and the mirror in one
  // txn — this is the INV-1 check that a broken mirror-write would
  // trip.
  afterEach(async () => {
    expect(await computeLedgerDriftSql(db)).toEqual([]);
  });

  it('mints for an eligible GBPLOOP holder: snapshot + ledger + mirror + payout row, cursor advances', async () => {
    const user = await seedActivatedUser();
    // 3,650 GBPLOOP at 100% APY/365 nights -> exactly 100,000,000
    // stroops accrual == 1000 minor units, 0 carry. Chosen for clean
    // whole-number assertions, not realism.
    trustlineBalances.set(user.walletAddress, 36_500_000_000n);

    const result = await runInterestMintTick({ now: DAY_1, apyBps: 10_000 });

    expect(result.skippedLocked).toBe(false);
    expect(result.alreadyProcessed).toBe(false);
    expect(result.eligibleUsers).toBe(1);
    expect(result.minted).toBe(1);
    expect(result.accruedOnly).toBe(0);
    expect(result.skippedZeroBalance).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.totalsMinor['GBP']).toBe(1000n);

    const snaps = await snapshotsFor(user.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      periodCursor: PERIOD_1,
      balanceStroops: 36_500_000_000n,
      accrualStroops: 100_000_000n,
      carryBeforeStroops: 0n,
      carryAfterStroops: 0n,
      mintedMinor: 1000n,
      currency: 'GBP',
    });

    const ledgerRows = await creditRowsFor(user.id);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({
      amountMinor: 1000n,
      currency: 'GBP',
      periodCursor: PERIOD_1,
      referenceType: null,
      referenceId: null,
    });

    expect(await balanceOf(user.id)).toBe(1000n);

    const payouts = await payoutRowsFor(user.id);
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({
      assetCode: 'GBPLOOP',
      toAddress: user.walletAddress,
      amountStroops: 100_000_000n,
      state: 'pending',
    });

    expect(await cursor()).toBe(PERIOD_1);
  });

  it('accrues a sub-minor amount into carry without minting, then mints once the carry crosses a whole minor unit across two nights', async () => {
    const user = await seedActivatedUser();
    // 328.5 GBPLOOP at 100% APY/365 -> 90,000 stroops/night, below the
    // 100,000-stroop (1 minor unit) mint threshold on its own.
    trustlineBalances.set(user.walletAddress, 32_850_000n);

    const night1 = await runInterestMintTick({ now: DAY_1, apyBps: 10_000 });
    expect(night1.minted).toBe(0);
    expect(night1.accruedOnly).toBe(1);
    expect(night1.totalsMinor['GBP']).toBeUndefined();

    const afterNight1 = await snapshotsFor(user.id);
    expect(afterNight1).toHaveLength(1);
    expect(afterNight1[0]).toMatchObject({
      periodCursor: PERIOD_1,
      accrualStroops: 90_000n,
      carryBeforeStroops: 0n,
      carryAfterStroops: 90_000n,
      mintedMinor: 0n,
    });
    // Accrue-only nights write no ledger/mirror/payout rows.
    expect(await creditRowsFor(user.id)).toHaveLength(0);
    expect(await balanceOf(user.id)).toBeUndefined();
    expect(await payoutRowsFor(user.id)).toHaveLength(0);

    // Second night: same on-chain balance (the night-1 mint never
    // landed on-chain — nothing submits pending_payouts in this
    // suite), same 90,000-stroop accrual. 90,000 (carry) + 90,000
    // (accrual) = 180,000 -> mints 1 minor unit, carries 80,000
    // forward. This is the real DB round-trip of the carry
    // mechanism — `mintOneUser` reads the night-1 row back via a
    // real `ORDER BY period_cursor DESC LIMIT 1` query.
    const night2 = await runInterestMintTick({ now: DAY_2, apyBps: 10_000 });
    expect(night2.minted).toBe(1);
    expect(night2.totalsMinor['GBP']).toBe(1n);

    const afterNight2 = await snapshotsFor(user.id);
    expect(afterNight2).toHaveLength(2);
    expect(afterNight2[1]).toMatchObject({
      periodCursor: PERIOD_2,
      accrualStroops: 90_000n,
      carryBeforeStroops: 90_000n,
      carryAfterStroops: 80_000n,
      mintedMinor: 1n,
    });
    expect(await balanceOf(user.id)).toBe(1n);
    expect(await payoutRowsFor(user.id)).toHaveLength(1);
  });

  it('skips a zero-balance / no-trustline holder without writing any row', async () => {
    const user = await seedActivatedUser();
    // No entry in trustlineBalances -> accountExists: false.

    const result = await runInterestMintTick({ now: DAY_1, apyBps: 10_000 });

    expect(result.eligibleUsers).toBe(1);
    expect(result.skippedZeroBalance).toBe(1);
    expect(result.minted).toBe(0);
    expect(result.accruedOnly).toBe(0);
    expect(await snapshotsFor(user.id)).toHaveLength(0);
    expect(await creditRowsFor(user.id)).toHaveLength(0);
    expect(await payoutRowsFor(user.id)).toHaveLength(0);
    // Cursor still advances -- a night with zero eligible mints is not an error.
    expect(await cursor()).toBe(PERIOD_1);
  });

  it('a same-period re-run at the tick level is a cheap no-op (cursor fast path) -- no double mint', async () => {
    const user = await seedActivatedUser();
    trustlineBalances.set(user.walletAddress, 36_500_000_000n);

    const first = await runInterestMintTick({ now: DAY_1, apyBps: 10_000 });
    expect(first.minted).toBe(1);

    vi.mocked(getAccountTrustlines).mockClear();
    const second = await runInterestMintTick({ now: DAY_1, apyBps: 10_000 });

    expect(second.alreadyProcessed).toBe(true);
    expect(second.eligibleUsers).toBe(0);
    expect(second.minted).toBe(0);
    // The cursor fast-path returns before the eligible-users query --
    // Horizon is never even consulted a second time.
    expect(getAccountTrustlines).not.toHaveBeenCalled();

    expect(await snapshotsFor(user.id)).toHaveLength(1);
    expect(await creditRowsFor(user.id)).toHaveLength(1);
    expect(await balanceOf(user.id)).toBe(1000n);
  });

  it('crash-recovery: a user already minted for the period (cursor unadvanced) is not double-minted while a fresh user in the same tick still mints', async () => {
    // Simulates a crash between committing user A's per-user
    // transaction and either (a) processing user B or (b) writing the
    // cursor -- the exact scenario `docs/invariants.md` INV-3
    // describes. Seed user A's rows directly (as if a prior, crashed
    // tick already committed them) and deliberately leave the watcher
    // cursor unset, so the resumed tick re-enters the period and must
    // rely on `mintOneUser`'s per-row idempotency handling (not the
    // cheap cursor fast path, which a separate test above already
    // covers) to avoid a double mint.
    //
    // Defense-in-depth note (confirmed empirically while proving this
    // test non-vacuous): the graceful "skipped_already" outcome is
    // produced by EITHER of two layers -- the SELECT-based `prior`
    // read (the normal, cheap path here) OR, if that read were ever
    // disabled, the real `interest_mint_snapshots` unique index
    // firing on the duplicate INSERT and being caught + classified by
    // `isUniqueViolationOnAny` (AUDIT-2-D's fix, exercised directly
    // and in isolation by the dedicated real-unique-violation test
    // below). Disabling ONLY the SELECT read does not turn this test
    // red -- the catch-based classifier still saves it, which is the
    // point of having two layers. Disabling BOTH does turn it red
    // (confirmed: the DB unique constraint still rolls back the
    // duplicate write -- no double mint -- but the outcome surfaces
    // as an uncaught error instead of a graceful skip). So this test
    // pins the outcome money-safety cares about (no double mint, no
    // error on a benign resume) rather than one specific code path.
    const userA = await seedActivatedUser();
    const issuer = process.env['LOOP_STELLAR_GBPLOOP_ISSUER']!;
    await db.insert(interestMintSnapshots).values({
      userId: userA.id,
      assetCode: 'GBPLOOP',
      assetIssuer: issuer,
      currency: 'GBP',
      periodCursor: PERIOD_1,
      balanceStroops: 36_500_000_000n,
      accrualStroops: 100_000_000n,
      carryBeforeStroops: 0n,
      carryAfterStroops: 0n,
      mintedMinor: 1000n,
    });
    // DAT-01-inv1 (migration 0066): the prior-period interest ledger row
    // and the balance it minted must land in ONE transaction so the
    // deferred mirror-invariant trigger sees an equal mirror at commit
    // (the interest row IS the intended crash-recovery ledger content, so
    // it's seeded directly rather than via the generic opening-balance
    // helper).
    await db.transaction(async (tx) => {
      await tx.insert(creditTransactions).values({
        userId: userA.id,
        type: 'interest',
        amountMinor: 1000n,
        currency: 'GBP',
        referenceType: null,
        referenceId: null,
        periodCursor: PERIOD_1,
      });
      await tx
        .insert(userCredits)
        .values({ userId: userA.id, currency: 'GBP', balanceMinor: 1000n });
    });
    await db.insert(pendingPayouts).values({
      userId: userA.id,
      kind: 'interest_mint',
      assetCode: 'GBPLOOP',
      assetIssuer: issuer,
      toAddress: userA.walletAddress,
      amountStroops: 100_000_000n,
      memoText: 'pre-seeded crash-recovery fixture',
    });
    // Same on-chain balance so a broken fence would try to mint again.
    trustlineBalances.set(userA.walletAddress, 36_500_000_000n);

    const userB = await seedActivatedUser();
    trustlineBalances.set(userB.walletAddress, 36_500_000_000n);

    const result = await runInterestMintTick({ now: DAY_1, apyBps: 10_000 });

    expect(result.alreadyProcessed).toBe(false); // cursor was never advanced for this period
    expect(result.eligibleUsers).toBe(2);
    expect(result.skippedAlready).toBe(1);
    expect(result.minted).toBe(1);
    expect(result.errors).toBe(0);

    // User A: no NEW row, no double-credit.
    expect(await snapshotsFor(userA.id)).toHaveLength(1);
    expect(await creditRowsFor(userA.id)).toHaveLength(1);
    expect(await balanceOf(userA.id)).toBe(1000n);
    expect(await payoutRowsFor(userA.id)).toHaveLength(1);

    // User B: fresh mint, full row set.
    expect(await snapshotsFor(userB.id)).toHaveLength(1);
    expect(await balanceOf(userB.id)).toBe(1000n);
    expect(await payoutRowsFor(userB.id)).toHaveLength(1);

    expect(await cursor()).toBe(PERIOD_1);
  });

  it('the real unique-violation shape: a genuine duplicate snapshot insert throws a Drizzle-wrapped 23505 that isUniqueViolation correctly classifies (AUDIT-2-D)', async () => {
    // Directly provokes the real DB error the mocked unit test could
    // only fake -- proves `isUniqueViolation` (db/errors.ts) walks
    // the REAL `err.cause` chain from postgres-js's actual driver
    // error, not just a hand-built shape.
    const user = await seedActivatedUser();
    const issuer = process.env['LOOP_STELLAR_GBPLOOP_ISSUER']!;
    const row = {
      userId: user.id,
      assetCode: 'GBPLOOP' as const,
      assetIssuer: issuer,
      currency: 'GBP' as const,
      periodCursor: PERIOD_1,
      balanceStroops: 100_000n,
      accrualStroops: 50_000n,
      carryBeforeStroops: 0n,
      carryAfterStroops: 50_000n,
      mintedMinor: 0n,
    };
    await db.insert(interestMintSnapshots).values(row);

    let thrown: unknown = null;
    await db
      .insert(interestMintSnapshots)
      .values(row)
      .catch((err: unknown) => {
        thrown = err;
      });

    expect(thrown).not.toBeNull();
    expect(isUniqueViolation(thrown, 'interest_mint_snapshots_user_asset_period_unique')).toBe(
      true,
    );
    // A DIFFERENT constraint name must not match -- the classifier is
    // specific, not "any 23505 is fine" (the whole point of AUDIT-2-D
    // naming the exact constraints rather than matching any 23505).
    expect(isUniqueViolation(thrown, 'credit_transactions_interest_period_unique')).toBe(false);

    // Still exactly one row -- the duplicate never landed.
    expect(await snapshotsFor(user.id)).toHaveLength(1);
  });

  it('single-flight: a real Postgres advisory-lock holder on a second connection excludes the tick, which writes nothing (S4-3)', async () => {
    const user = await seedActivatedUser();
    trustlineBalances.set(user.walletAddress, 36_500_000_000n);

    const lockKey = interestMintLockKeyForTest();
    const outer = await withAdvisoryLock(lockKey, async () => {
      // While this (real, reserved-connection) session holds the
      // exact lock key `runInterestMintTick` takes internally, a
      // concurrent tick must find it already held and skip.
      const result = await runInterestMintTick({ now: DAY_1, apyBps: 10_000 });
      expect(result.skippedLocked).toBe(true);
      expect(result.minted).toBe(0);
      expect(result.eligibleUsers).toBe(0);
      return 'held';
    });

    expect(outer).toEqual({ ran: true, value: 'held' });
    expect(getAccountTrustlines).not.toHaveBeenCalled();
    expect(await snapshotsFor(user.id)).toHaveLength(0);
    expect(await cursor()).toBeNull();

    // Sanity: with the lock released, the same tick now proceeds.
    const after = await runInterestMintTick({ now: DAY_1, apyBps: 10_000 });
    expect(after.skippedLocked).toBe(false);
    expect(after.minted).toBe(1);
  });

  it('CON-04: a hung sweep hits the lease deadline, RELEASES the fleet-wide lock, and does NOT advance the cursor', async () => {
    const user = await seedActivatedUser();
    trustlineBalances.set(user.walletAddress, 36_500_000_000n);

    // Make the per-user Horizon read hang so the sweep can never
    // complete — the exact "blackholed Horizon" shape the lease guards
    // against. `mockImplementationOnce` hangs only THIS call; the base
    // mock impl is restored for the sanity re-run below and later tests.
    vi.mocked(getAccountTrustlines).mockImplementationOnce(() => new Promise(() => {}));

    // A short lease: pre-fix (no lease) the fleet-wide lock is held for
    // the whole run, so this call would never resolve (the hung sweep
    // holds the lock forever) — the test would time out. Post-fix the
    // race settles at the lease and the lock is freed.
    const result = await runInterestMintTick({ now: DAY_1, apyBps: 10_000, leaseMs: 200 });

    expect(result.leaseTimedOut).toBe(true);
    expect(result.skippedLocked).toBe(false);
    expect(result.minted).toBe(0);
    // The hung sweep never reached any DB write, and the cursor is left
    // unadvanced so the next tick re-runs the period.
    expect(await snapshotsFor(user.id)).toHaveLength(0);
    expect(await cursor()).toBeNull();

    // Proof the fleet-wide lock was actually released despite the
    // orphaned in-flight sweep: a second session can now take it.
    const reacquired = await withAdvisoryLock(interestMintLockKeyForTest(), async () => 'ok');
    expect(reacquired).toEqual({ ran: true, value: 'ok' });
  });
});
