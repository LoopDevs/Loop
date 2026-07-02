/**
 * Payout-worker integration tests on real postgres (ADR 016).
 *
 * The payout submit ladder has three concurrency-sensitive surfaces
 * the unit suite can't cover end-to-end:
 *
 *   1. **Idempotency pre-check convergence** — `payOne` calls
 *      `findOutboundPaymentByMemo` first; if Horizon already shows
 *      the payment, the row converges to `confirmed` without a
 *      second submit. Real postgres exercises the
 *      `pending → submitted → confirmed` state-guarded transition.
 *
 *   2. **A2-602 watchdog re-claim CAS race** — a row stuck in
 *      `submitted` past `staleSeconds` is re-picked by the next
 *      tick. Two concurrent workers calling `reclaimSubmittedPayout`
 *      with the same `expectedAttempts` must not both win the CAS
 *      — only one bumps `attempts` + `submittedAt`. The ON-attempts
 *      compare-and-set is the only thing keeping a sustained
 *      Horizon blackhole from double-submitting.
 *
 *   3. **A2-1921 fee-bump curve across retries** — each retry
 *      submits with `feeForAttempt(attempts, …)`, exponential bump
 *      so a congested network drains naturally instead of going
 *      terminal at base fee. The fee value flowing through the
 *      pipeline must reflect the post-increment attempts counter.
 *
 * What's mocked: `submitPayout` (Stellar SDK + Horizon submit) and
 * `findOutboundPaymentByMemo` (Horizon GET) — the only external
 * boundaries. Everything else is real: postgres state guards,
 * drizzle SQL, fee strategy, watchdog SQL predicate.
 *
 * Gated on `LOOP_E2E_DB=1` like the sibling integration suites.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

vi.mock('../../payments/payout-submit.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    submitPayout: vi.fn(),
  };
});

vi.mock('../../payments/horizon.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    findOutboundPaymentByMemo: vi.fn(async () => null),
    // CF-18: authoritative tx-hash lookup. Default "never landed" so a
    // row without a persisted hash never short-circuits; tests that
    // exercise the authoritative path override per-test.
    getOutboundPaymentByTxHash: vi.fn(async () => null),
  };
});

// The Phase-2 trustline pre-check ships in `payout-worker-pay-one.ts`
// (paired with `notifyPayoutAwaitingTrustline`). Integration test
// destinations are synthetic G-addresses with no Stellar account, so
// the live Horizon read would 404 and stall every submit. Stub it
// to "every trustline is established" so the existing pre-check /
// claim / submit / confirm tests still exercise the post-trustline
// path. The dedicated missing-trustline tests live in the unit
// suite (`payout-worker.test.ts`) where the mock can flip per-test.
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
    notifyAdminAudit: noop,
  };
});

import { db } from '../../db/client.js';
import { users, orders, pendingPayouts, userCredits } from '../../db/schema.js';
import { getAccountTrustlines } from '../../payments/horizon-trustlines.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { runPayoutTick } from '../../payments/payout-worker.js';
import { reclaimSubmittedPayout, listClaimablePayouts } from '../../credits/pending-payouts.js';
import { submitPayout, PayoutSubmitError } from '../../payments/payout-submit.js';
import { findOutboundPaymentByMemo, getOutboundPaymentByTxHash } from '../../payments/horizon.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

const DEFAULT_TICK_ARGS = {
  // Real Stellar testnet secret format (G…/S…) isn't needed because
  // submitPayout is mocked. The string must just survive the call;
  // the SDK's Keypair.fromSecret would reject it but we never get
  // that far.
  operatorSecret: 'STESTSECRET',
  operatorAccount: 'GTESTOPERATOR',
  horizonUrl: 'https://horizon-test.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  maxAttempts: 5,
};

/**
 * Inserts a payout row in the supplied state. Skips the cashback
 * config + order seed — the payout worker's queue read doesn't join
 * back to either.
 */
async function seedPayout(args: {
  state: 'pending' | 'submitted';
  attempts?: number;
  submittedAt?: Date | null;
  // CF-18: persisted tx hash (set on re-pick rows whose prior attempt
  // recorded it before the network submit).
  txHash?: string | null;
}): Promise<{ payoutId: string; userId: string }> {
  const user = await findOrCreateUserByEmail(`payout-${Date.now()}-${Math.random()}@test.local`);
  await db.update(users).set({ homeCurrency: 'USD' }).where(eq(users.id, user.id));

  // Hardening A1/C10: the emission-conservation trigger requires the
  // mirror liability to cover the emitted amount — seed the matching
  // balance (500 minor × 100_000 stroops/minor = the row below).
  await db.insert(userCredits).values({
    userId: user.id,
    currency: 'USD',
    balanceMinor: 500n,
  });

  const [row] = await db
    .insert(pendingPayouts)
    .values({
      userId: user.id,
      // No order — emission payout (kind='emission', ADR 036) skips
      // the FK requirement on order_id.
      kind: 'emission',
      assetCode: 'USDLOOP',
      assetIssuer: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      toAddress: 'GUSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      amountStroops: 50_000_000n,
      memoText: `payout-${Date.now()}`,
      state: args.state,
      attempts: args.attempts ?? 0,
      submittedAt: args.submittedAt ?? null,
      txHash: args.txHash ?? null,
    })
    .returning({ id: pendingPayouts.id });
  if (row === undefined) throw new Error('seed: pending_payouts insert returned no row');
  return { payoutId: row.id, userId: user.id };
}

describeIf('payout-worker integration — idempotency pre-check convergence', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    vi.mocked(submitPayout).mockReset();
    vi.mocked(findOutboundPaymentByMemo).mockReset();
    vi.mocked(getOutboundPaymentByTxHash).mockReset();
    vi.mocked(getOutboundPaymentByTxHash).mockResolvedValue(null);
  });

  it('CF-18: re-pick of a submitted row with a persisted, landed tx hash converges via authoritative lookup', async () => {
    // The double-pay window (CF-18): a stuck `submitted` row re-picked by
    // the watchdog whose prior submit DID land but scrolled off the
    // bounded memo-scan window. The persisted hash + authoritative point
    // lookup converge it to `confirmed` without a memo scan or a second
    // submit, regardless of how interleaved the operator feed is.
    const { payoutId } = await seedPayout({
      state: 'submitted',
      attempts: 1,
      submittedAt: new Date(Date.now() - 600_000), // stale → re-picked
      txHash: 'persisted-landed-hash',
    });
    vi.mocked(getOutboundPaymentByTxHash).mockResolvedValueOnce({ landed: true });

    const tick = await runPayoutTick({ ...DEFAULT_TICK_ARGS, watchdogStaleSeconds: 300 });
    expect(tick.skippedAlreadyLanded).toBe(1);
    expect(submitPayout).not.toHaveBeenCalled();
    // The window-bound scan is never consulted — no window dependency.
    expect(findOutboundPaymentByMemo).not.toHaveBeenCalled();

    const [row] = await db.select().from(pendingPayouts).where(eq(pendingPayouts.id, payoutId));
    expect(row!.state).toBe('confirmed');
    expect(row!.txHash).toBe('persisted-landed-hash');
  });

  it('pending row + prior on-chain payment → converges to confirmed without re-submitting', async () => {
    // The pre-check finds a landed payment; the worker should mark
    // submitted (claim) and immediately confirm with the recovered
    // tx hash, without ever calling `submitPayout`.
    const { payoutId } = await seedPayout({ state: 'pending' });
    vi.mocked(findOutboundPaymentByMemo).mockResolvedValueOnce({
      txHash: 'recovered-tx-hash-abcdef',
      amount: '5.0000000',
      assetCode: 'USDLOOP',
    });

    const tick = await runPayoutTick(DEFAULT_TICK_ARGS);
    expect(tick.skippedAlreadyLanded).toBe(1);
    expect(tick.confirmed).toBe(0);
    expect(tick.failed).toBe(0);
    expect(submitPayout).not.toHaveBeenCalled();

    const [row] = await db.select().from(pendingPayouts).where(eq(pendingPayouts.id, payoutId));
    expect(row!.state).toBe('confirmed');
    expect(row!.txHash).toBe('recovered-tx-hash-abcdef');
  });

  it('happy path: pending → submitted → confirmed with fee = base on first attempt', async () => {
    const { payoutId } = await seedPayout({ state: 'pending' });
    vi.mocked(findOutboundPaymentByMemo).mockResolvedValueOnce(null);
    vi.mocked(submitPayout).mockResolvedValueOnce({
      txHash: 'fresh-submit-tx-hash',
      ledger: 99999,
    });

    const tick = await runPayoutTick(DEFAULT_TICK_ARGS);
    expect(tick.confirmed).toBe(1);
    expect(tick.skippedAlreadyLanded).toBe(0);

    // Fee on the first attempt = LOOP_PAYOUT_FEE_BASE_STROOPS
    // default (100). Verify by inspecting submitPayout's args.
    const call = vi.mocked(submitPayout).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call!.feeStroops).toBe('100');

    const [row] = await db.select().from(pendingPayouts).where(eq(pendingPayouts.id, payoutId));
    expect(row!.state).toBe('confirmed');
    expect(row!.txHash).toBe('fresh-submit-tx-hash');
    expect(row!.attempts).toBe(1);
  });
});

describeIf('payout-worker integration — A2-602 watchdog re-claim CAS', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    vi.mocked(submitPayout).mockReset();
    vi.mocked(findOutboundPaymentByMemo).mockReset();
    vi.mocked(getOutboundPaymentByTxHash).mockReset();
    vi.mocked(getOutboundPaymentByTxHash).mockResolvedValue(null);
  });

  it('two concurrent reclaims on the same stale row — only one wins the CAS on attempts', async () => {
    // The CAS-on-attempts in `reclaimSubmittedPayout` is the only
    // arbiter when two workers see the same stale `submitted` row.
    // Without it, both would bump attempts + submittedAt, and both
    // proceed to `submitPayout` — exactly the double-spend the
    // watchdog must NOT introduce.
    const { payoutId } = await seedPayout({
      state: 'submitted',
      attempts: 1,
      // A stale stamp older than the default 300s window.
      submittedAt: new Date(Date.now() - 600_000),
    });

    const [first, second] = await Promise.all([
      reclaimSubmittedPayout({ id: payoutId, expectedAttempts: 1 }),
      reclaimSubmittedPayout({ id: payoutId, expectedAttempts: 1 }),
    ]);

    const winners = [first, second].filter((r) => r !== null);
    expect(winners.length).toBe(1);
    expect(winners[0]!.attempts).toBe(2);

    const [row] = await db.select().from(pendingPayouts).where(eq(pendingPayouts.id, payoutId));
    expect(row!.attempts).toBe(2);
    expect(row!.state).toBe('submitted');
  });

  it('watchdog SQL predicate skips submitted rows whose submittedAt is recent', async () => {
    // Recent submitted row (< staleSeconds) — should NOT be re-picked
    // by the watchdog. A bug in the predicate's `make_interval` math
    // or the boundary (`<` vs `<=`) would cause the worker to spin
    // up a fresh submit on a tx that's still in flight.
    await seedPayout({
      state: 'submitted',
      attempts: 1,
      submittedAt: new Date(Date.now() - 60_000), // 60s — well under default 300s
    });
    vi.mocked(findOutboundPaymentByMemo).mockResolvedValue(null);

    const tick = await runPayoutTick({ ...DEFAULT_TICK_ARGS, watchdogStaleSeconds: 300 });
    expect(tick.picked).toBe(0);
    expect(submitPayout).not.toHaveBeenCalled();
  });

  it('stale submitted row is re-claimed and re-submitted with bumped fee', async () => {
    // Watchdog flow: row sits in `submitted` past staleSeconds, the
    // next tick re-picks it, the CAS-claim bumps attempts to 2, and
    // submitPayout is called with the attempt-2 fee (200 stroops by
    // default — base × multiplier 2). This is the integration glue
    // that closes A2-1921 + A2-602.
    const { payoutId } = await seedPayout({
      state: 'submitted',
      attempts: 1,
      submittedAt: new Date(Date.now() - 600_000),
    });
    vi.mocked(findOutboundPaymentByMemo).mockResolvedValueOnce(null);
    vi.mocked(submitPayout).mockResolvedValueOnce({
      txHash: 'watchdog-retry-tx-hash',
      ledger: 100_001,
    });

    const tick = await runPayoutTick({ ...DEFAULT_TICK_ARGS, watchdogStaleSeconds: 300 });
    expect(tick.confirmed).toBe(1);

    const submitCall = vi.mocked(submitPayout).mock.calls[0]?.[0];
    // attempts AFTER the CAS-claim is 2 → fee is base * multiplier =
    // 100 * 2 = 200.
    expect(submitCall!.feeStroops).toBe('200');

    const [row] = await db.select().from(pendingPayouts).where(eq(pendingPayouts.id, payoutId));
    expect(row!.state).toBe('confirmed');
    expect(row!.attempts).toBe(2);
  });
});

describeIf('payout-worker integration — fee-bump curve across attempts', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    vi.mocked(submitPayout).mockReset();
    vi.mocked(findOutboundPaymentByMemo).mockReset();
    vi.mocked(getOutboundPaymentByTxHash).mockReset();
    vi.mocked(getOutboundPaymentByTxHash).mockResolvedValue(null);
  });

  it('transient failures escalate fee across watchdog re-pickups', async () => {
    // Two ticks across a single payout that hits transient failures
    // each time. Verify that the fee on the second submit is higher
    // than the first — the `feeForAttempt` curve is fed
    // `claimed.attempts` from the row, which is the post-increment
    // counter from `markPayoutSubmitted` / `reclaimSubmittedPayout`.
    const { payoutId } = await seedPayout({ state: 'pending' });
    vi.mocked(findOutboundPaymentByMemo).mockResolvedValue(null);

    // First submit: transient_horizon. Worker leaves the row in
    // `submitted` with attempts=1 + a fresh submittedAt.
    vi.mocked(submitPayout).mockRejectedValueOnce(
      new PayoutSubmitError('transient_horizon', 'first attempt blackhole'),
    );
    const tick1 = await runPayoutTick(DEFAULT_TICK_ARGS);
    expect(tick1.retriedLater).toBe(1);

    const [afterFirst] = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.id, payoutId));
    expect(afterFirst!.state).toBe('submitted');
    expect(afterFirst!.attempts).toBe(1);

    // Backdate the row so the watchdog re-picks it on the next tick.
    // The default staleSeconds is 300; we set submittedAt to 10 min
    // ago so the SQL predicate fires.
    await db
      .update(pendingPayouts)
      .set({ submittedAt: sql`NOW() - interval '10 minutes'` })
      .where(eq(pendingPayouts.id, payoutId));

    // Second submit succeeds.
    vi.mocked(submitPayout).mockResolvedValueOnce({
      txHash: 'second-attempt-tx-hash',
      ledger: 100_010,
    });
    const tick2 = await runPayoutTick(DEFAULT_TICK_ARGS);
    expect(tick2.confirmed).toBe(1);

    const calls = vi.mocked(submitPayout).mock.calls;
    expect(calls.length).toBe(2);
    // Attempt 1 → 100 stroops (base). Attempt 2 → 200 (base × 2).
    expect(calls[0]![0].feeStroops).toBe('100');
    expect(calls[1]![0].feeStroops).toBe('200');

    const [final] = await db.select().from(pendingPayouts).where(eq(pendingPayouts.id, payoutId));
    expect(final!.state).toBe('confirmed');
    expect(final!.attempts).toBe(2);
  });
});

describeIf('payout-worker integration — CF-14 FOR UPDATE SKIP LOCKED claim', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('a concurrent claim SKIPs rows another transaction holds locked (no same-row double-process)', async () => {
    // Seed two claimable `pending` rows. Open a transaction (instance
    // A) that SELECTs them `FOR UPDATE SKIP LOCKED` and holds the
    // lock; while it's held, a second claim (instance B, via the real
    // `listClaimablePayouts` in its own implicit txn) must SKIP both
    // locked rows and return nothing — proving two instances never get
    // the same row in-flight, which is the read→claim race CF-14 closes.
    const a = await seedPayout({ state: 'pending' });
    const b = await seedPayout({ state: 'pending' });

    // Coordinate the two transactions with explicit gates so the
    // assertion runs deterministically while instance A still holds
    // the locks (rather than relying on timing).
    let releaseA: () => void = () => undefined;
    const aHoldsLocks = new Promise<void>((resolve) => {
      // resolve once A has acquired its locks
      releaseA = resolve;
    });
    let allowAToCommit: () => void = () => undefined;
    const aMayCommit = new Promise<void>((resolve) => {
      allowAToCommit = resolve;
    });

    const instanceA = db.transaction(async (tx) => {
      const locked = await tx
        .select({ id: pendingPayouts.id })
        .from(pendingPayouts)
        .where(eq(pendingPayouts.state, 'pending'))
        .for('update', { skipLocked: true });
      // A holds locks on both rows now.
      expect(locked.map((r) => r.id).sort()).toEqual([a.payoutId, b.payoutId].sort());
      releaseA();
      // Hold the transaction (and its row locks) open until B has run.
      await aMayCommit;
    });

    await aHoldsLocks;

    // Instance B claims while A holds the locks → SKIP LOCKED hides
    // both rows from B.
    const bRows = await listClaimablePayouts({ limit: 20, staleSeconds: 300, maxAttempts: 5 });
    expect(bRows).toHaveLength(0);

    allowAToCommit();
    await instanceA;

    // After A commits and releases, a fresh claim sees both rows again
    // (single-instance behaviour is unchanged — the lock only ever
    // affects what a concurrent instance sees).
    const afterRelease = await listClaimablePayouts({
      limit: 20,
      staleSeconds: 300,
      maxAttempts: 5,
    });
    expect(afterRelease.map((r) => r.id).sort()).toEqual([a.payoutId, b.payoutId].sort());
  });

  it('two concurrent claims partition the queue — no row id appears in both result sets', async () => {
    // Six claimable rows, two instances each claiming a batch of three.
    // `FOR UPDATE SKIP LOCKED` must hand each instance a DISJOINT set —
    // the union covers six distinct rows with no overlap. This is the
    // cross-instance single-flight property the plain `SELECT` lacked
    // (both would have returned the same first three rows).
    //
    // Deterministic via explicit transaction gating rather than racing
    // two `Promise.all` selects: A acquires + holds its locked batch,
    // THEN B acquires its batch while A still holds — so B is forced to
    // SKIP A's rows. This pins the partition behaviour without relying
    // on the two queries happening to overlap in wall-clock time.
    const seeded = [];
    for (let i = 0; i < 6; i++) {
      // Sequential seed so created_at ordering is stable.
      seeded.push(await seedPayout({ state: 'pending' }));
    }
    const seededIds = seeded.map((s) => s.payoutId).sort();

    let releaseA: () => void = () => undefined;
    const aHoldsLocks = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let allowAToCommit: () => void = () => undefined;
    const aMayCommit = new Promise<void>((resolve) => {
      allowAToCommit = resolve;
    });

    let idsA: string[] = [];
    const instanceA = db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: pendingPayouts.id })
        .from(pendingPayouts)
        .where(eq(pendingPayouts.state, 'pending'))
        .orderBy(asc(pendingPayouts.createdAt))
        .limit(3)
        .for('update', { skipLocked: true });
      idsA = rows.map((r) => r.id);
      releaseA();
      await aMayCommit;
    });

    await aHoldsLocks;

    // B claims its own batch of 3 while A holds the first 3 → SKIP
    // LOCKED forces B onto the remaining rows.
    const setB = await listClaimablePayouts({ limit: 3, staleSeconds: 300, maxAttempts: 5 });
    const idsB = setB.map((r) => r.id);

    allowAToCommit();
    await instanceA;

    expect(idsA).toHaveLength(3);
    expect(idsB).toHaveLength(3);
    const overlap = idsA.filter((id) => idsB.includes(id));
    expect(overlap).toEqual([]); // no row claimed by both instances

    // Together the two disjoint batches cover all six distinct seeded rows.
    const union = [...idsA, ...idsB].sort();
    expect(new Set(union).size).toBe(6);
    expect(union).toEqual(seededIds);
  });

  it('single instance: behaviour is unchanged — all claimable rows are returned', async () => {
    // Regression guard: the lock must not change what a lone worker
    // sees. One instance still gets every claimable row in FIFO order.
    const a = await seedPayout({ state: 'pending' });
    const b = await seedPayout({ state: 'pending' });

    const rows = await listClaimablePayouts({ limit: 20, staleSeconds: 300, maxAttempts: 5 });
    expect(rows.map((r) => r.id).sort()).toEqual([a.payoutId, b.payoutId].sort());
  });
});

describeIf('payout-worker integration — ADR 036 issuer-return burns', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    vi.mocked(submitPayout).mockReset();
    vi.mocked(findOutboundPaymentByMemo).mockReset();
    vi.mocked(getAccountTrustlines).mockClear();
  });

  /**
   * Seeds a `kind='burn'` row the way markOrderPaid writes it: tied
   * to a redeemed order, destination = the asset's issuer.
   */
  async function seedBurnPayout(): Promise<{ payoutId: string }> {
    const user = await findOrCreateUserByEmail(`burn-${Date.now()}-${Math.random()}@test.local`);
    await db.update(users).set({ homeCurrency: 'USD' }).where(eq(users.id, user.id));
    const [order] = await db
      .insert(orders)
      .values({
        userId: user.id,
        merchantId: 'amazon',
        faceValueMinor: 2500n,
        currency: 'USD',
        chargeMinor: 2500n,
        chargeCurrency: 'USD',
        paymentMethod: 'loop_asset',
        paymentMemo: `burn-memo-${Date.now()}-${Math.random()}`,
        wholesalePct: '70.00',
        userCashbackPct: '5.00',
        loopMarginPct: '25.00',
        wholesaleMinor: 1750n,
        userCashbackMinor: 125n,
        loopMarginMinor: 625n,
        state: 'paid',
      })
      .returning({ id: orders.id });
    const issuer = process.env['LOOP_STELLAR_USDLOOP_ISSUER']!;
    const [row] = await db
      .insert(pendingPayouts)
      .values({
        userId: user.id,
        orderId: order!.id,
        kind: 'burn',
        assetCode: 'USDLOOP',
        assetIssuer: issuer,
        toAddress: issuer,
        amountStroops: 2500n * 100_000n,
        memoText: `burn-${Date.now()}`,
        state: 'pending',
      })
      .returning({ id: pendingPayouts.id });
    if (row === undefined) throw new Error('seed: burn pending_payouts insert returned no row');
    return { payoutId: row.id };
  }

  it('submits the burn to the issuer destination without a trustline probe', async () => {
    const { payoutId } = await seedBurnPayout();
    vi.mocked(findOutboundPaymentByMemo).mockResolvedValueOnce(null);
    vi.mocked(submitPayout).mockResolvedValueOnce({ txHash: 'burn-tx-hash', ledger: 12345 });

    const tick = await runPayoutTick(DEFAULT_TICK_ARGS);
    expect(tick.confirmed).toBe(1);
    expect(tick.failed).toBe(0);

    // The submit targeted the issuer (the burn destination).
    const call = vi.mocked(submitPayout).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call!.intent.to).toBe(process.env['LOOP_STELLAR_USDLOOP_ISSUER']);
    expect(call!.intent.assetIssuer).toBe(process.env['LOOP_STELLAR_USDLOOP_ISSUER']);

    // ADR 036: no trustline probe for an issuer-return — the issuer
    // never holds a trustline to its own asset.
    expect(getAccountTrustlines).not.toHaveBeenCalled();

    const [row] = await db.select().from(pendingPayouts).where(eq(pendingPayouts.id, payoutId));
    expect(row!.state).toBe('confirmed');
    expect(row!.txHash).toBe('burn-tx-hash');
  });
});

describeIf('withAdvisoryLock — real postgres single-flight (hardening A8)', () => {
  it('a second concurrent acquire of the same key does NOT run its fn', async () => {
    const { withAdvisoryLock } = await import('../../db/client.js');
    const KEY = 918273645123456789n % 2n ** 63n;

    let firstRunning = false;
    let secondRan = false;

    // Hold the lock in the first call until the second has attempted.
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withAdvisoryLock(KEY, async () => {
      firstRunning = true;
      await firstGate; // stay in the critical section
      return 'first';
    });

    // Spin until the first is inside its fn (holds the lock).
    for (let i = 0; i < 100 && !firstRunning; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(firstRunning).toBe(true);

    const second = await withAdvisoryLock(KEY, async () => {
      secondRan = true;
      return 'second';
    });
    expect(second.ran).toBe(false); // lock held → skipped
    expect(secondRan).toBe(false); // fn never ran

    releaseFirst();
    const firstResult = await first;
    expect(firstResult).toEqual({ ran: true, value: 'first' });

    // After release, the key is free again.
    const third = await withAdvisoryLock(KEY, async () => 'third');
    expect(third).toEqual({ ran: true, value: 'third' });
  });

  it('a throwing fn still releases the lock (next acquire succeeds)', async () => {
    const { withAdvisoryLock } = await import('../../db/client.js');
    const KEY = 424242424242424242n % 2n ** 63n;
    await expect(
      withAdvisoryLock(KEY, async () => {
        throw new Error('tick blew up mid-submit');
      }),
    ).rejects.toThrow('tick blew up');
    // The lock must be free again — if the finally didn't unlock, this
    // would return { ran: false }.
    const after = await withAdvisoryLock(KEY, async () => 'recovered');
    expect(after).toEqual({ ran: true, value: 'recovered' });
  });

  it('a DIFFERENT key is not blocked by a held lock', async () => {
    const { withAdvisoryLock } = await import('../../db/client.js');
    const KEY_A = 111222333444555666n % 2n ** 63n;
    const KEY_B = 666555444333222111n % 2n ** 63n;
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const a = withAdvisoryLock(KEY_A, async () => {
      await gate;
      return 'a';
    });
    // Give A a moment to acquire.
    await new Promise((r) => setTimeout(r, 20));
    const b = await withAdvisoryLock(KEY_B, async () => 'b');
    expect(b).toEqual({ ran: true, value: 'b' }); // independent key runs
    releaseA();
    await a;
  });
});
