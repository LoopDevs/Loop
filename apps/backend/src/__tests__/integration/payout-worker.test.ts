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
import { eq, sql } from 'drizzle-orm';

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
  };
});

vi.mock('../../discord.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const noop = vi.fn();
  return {
    ...actual,
    notifyPayoutFailed: noop,
    notifyAdminAudit: noop,
  };
});

import { db } from '../../db/client.js';
import { users, pendingPayouts } from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { runPayoutTick } from '../../payments/payout-worker.js';
import { reclaimSubmittedPayout } from '../../credits/pending-payouts.js';
import { submitPayout, PayoutSubmitError } from '../../payments/payout-submit.js';
import { findOutboundPaymentByMemo } from '../../payments/horizon.js';
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
}): Promise<{ payoutId: string; userId: string }> {
  const user = await findOrCreateUserByEmail(`payout-${Date.now()}-${Math.random()}@test.local`);
  await db.update(users).set({ homeCurrency: 'USD' }).where(eq(users.id, user.id));

  const [row] = await db
    .insert(pendingPayouts)
    .values({
      userId: user.id,
      // No order — withdrawal-style payout with kind='withdrawal'
      // skips the FK requirement on order_id.
      kind: 'withdrawal',
      assetCode: 'USDLOOP',
      assetIssuer: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      toAddress: 'GUSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      amountStroops: 50_000_000n,
      memoText: `payout-${Date.now()}`,
      state: args.state,
      attempts: args.attempts ?? 0,
      submittedAt: args.submittedAt ?? null,
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
