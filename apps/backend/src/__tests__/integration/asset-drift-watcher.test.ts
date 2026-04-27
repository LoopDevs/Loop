/**
 * Asset-drift watcher integration tests on real postgres (ADR 015).
 *
 * The watcher's correctness relies on the ledger sum on the off-chain
 * side matching the on-chain LOOP-asset circulation. A unit test
 * mocks `sumOutstandingLiability` and proves the state-machine logic;
 * this suite validates the **end-to-end signal**: real
 * `user_credits` rows, real drizzle SQL, real per-currency bucketing,
 * fed through the per-asset transition state machine.
 *
 * Surfaces covered:
 *
 *   - **Ledger sum aggregation across currencies** — the watcher
 *     must bucket USD vs GBP vs EUR; a SQL bug that mixed currencies
 *     would silently misreport drift. Three rows in three currencies
 *     are written, and per-asset drift is asserted independently.
 *   - **ok → over → ok transitions notify exactly once each** — the
 *     in-memory state machine fires Discord only on transitions, so
 *     a sustained-incident tick stream doesn't flood the channel.
 *
 * Mocked: `getLoopAssetCirculation` (Horizon GET) + Discord. Real:
 * postgres + drizzle + the in-memory state Map + the per-currency
 * `sumOutstandingLiability` SQL.
 *
 * Gated on `LOOP_E2E_DB=1` like the sibling integration suites.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

vi.mock('../../payments/horizon-circulation.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getLoopAssetCirculation: vi.fn(),
  };
});

vi.mock('../../discord.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    notifyAssetDrift: vi.fn(),
    notifyAssetDriftRecovered: vi.fn(),
  };
});

import { db } from '../../db/client.js';
import { userCredits } from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import {
  runAssetDriftTick,
  __resetAssetDriftWatcherForTests,
} from '../../payments/asset-drift-watcher.js';
import { getLoopAssetCirculation } from '../../payments/horizon-circulation.js';
import { notifyAssetDrift, notifyAssetDriftRecovered } from '../../discord.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

/** 1e5 stroops per minor unit — LOOP assets are 1:1 with fiat at 7 decimals. */
const STROOPS_PER_MINOR = 100_000n;

describeIf('asset-drift watcher integration — real ledger aggregation', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    __resetAssetDriftWatcherForTests();
    vi.mocked(getLoopAssetCirculation).mockReset();
    vi.mocked(notifyAssetDrift).mockReset();
    vi.mocked(notifyAssetDriftRecovered).mockReset();
  });

  it('drift uses the per-currency user_credits sum, not a global total', async () => {
    // Three users, three currencies, three balances. The watcher
    // should bucket the sums per fiat — a bug that summed across
    // currencies would report drift = (USD + GBP + EUR) for each
    // asset, which would dwarf any real on-chain figure and false-
    // page the channel.
    const userUsd = await findOrCreateUserByEmail('usd-holder@test.local');
    const userGbp = await findOrCreateUserByEmail('gbp-holder@test.local');
    const userEur = await findOrCreateUserByEmail('eur-holder@test.local');
    await db.insert(userCredits).values([
      { userId: userUsd.id, currency: 'USD', balanceMinor: 1000n }, // 10.00 USD
      { userId: userGbp.id, currency: 'GBP', balanceMinor: 500n }, //  5.00 GBP
      { userId: userEur.id, currency: 'EUR', balanceMinor: 200n }, //  2.00 EUR
    ]);

    // On-chain: each issuer has exactly the matching ledger amount —
    // drift = 0 for each. If the watcher mixed currencies, drift
    // would be (1000 + 500 + 200 - amount_of_one_currency)*1e5 — wildly
    // outside the threshold.
    const onChainPerCode: Record<string, bigint> = {
      USDLOOP: 1000n * STROOPS_PER_MINOR,
      GBPLOOP: 500n * STROOPS_PER_MINOR,
      EURLOOP: 200n * STROOPS_PER_MINOR,
    };
    vi.mocked(getLoopAssetCirculation).mockImplementation(async (code, issuer) => ({
      stroops: onChainPerCode[code] ?? 0n,
      assetCode: code,
      issuer,
      asOfMs: Date.now(),
    }));

    const tick = await runAssetDriftTick({ thresholdStroops: 1_000_000n });
    expect(tick.checked).toBe(3);
    expect(tick.skipped).toBe(0);
    for (const sample of tick.samples) {
      expect(sample.driftStroops).toBe(0n);
      expect(sample.over).toBe(false);
    }
    expect(notifyAssetDrift).not.toHaveBeenCalled();
  });

  it('ok → over → ok fires exactly one Discord page per transition', async () => {
    // First tick: drift = 0, state stays ok (initial = unknown,
    // transitions to ok without paging). Second tick: shrink the
    // on-chain side so abs(drift) > threshold, page fires. Third
    // tick: restore on-chain to match ledger, recovery page fires.
    // Fourth tick: still ok, no further page.
    const user = await findOrCreateUserByEmail('drift-holder@test.local');
    await db.insert(userCredits).values({ userId: user.id, currency: 'USD', balanceMinor: 1000n });
    const onChainPerCode = new Map<string, bigint>();
    onChainPerCode.set('USDLOOP', 1000n * STROOPS_PER_MINOR);
    onChainPerCode.set('GBPLOOP', 0n);
    onChainPerCode.set('EURLOOP', 0n);
    vi.mocked(getLoopAssetCirculation).mockImplementation(async (code, issuer) => ({
      stroops: onChainPerCode.get(code) ?? 0n,
      assetCode: code,
      issuer,
      asOfMs: Date.now(),
    }));

    // Tick 1: drift = 0 for USDLOOP (matches ledger), 0 for GBPLOOP
    // and EURLOOP (both zero on both sides). All ok.
    const t1 = await runAssetDriftTick({ thresholdStroops: 1_000_000n });
    expect(t1.samples.find((s) => s.assetCode === 'USDLOOP')?.over).toBe(false);
    expect(notifyAssetDrift).not.toHaveBeenCalled();

    // Tick 2: on-chain USDLOOP drops to 0 → drift = 0 - 1000*1e5 =
    // -100_000_000 stroops. abs > threshold → ok → over.
    onChainPerCode.set('USDLOOP', 0n);
    const t2 = await runAssetDriftTick({ thresholdStroops: 1_000_000n });
    const usdSample2 = t2.samples.find((s) => s.assetCode === 'USDLOOP');
    expect(usdSample2?.over).toBe(true);
    expect(usdSample2?.notified).toBe(true);
    expect(notifyAssetDrift).toHaveBeenCalledTimes(1);
    expect(notifyAssetDriftRecovered).not.toHaveBeenCalled();

    // Tick 3: restore on-chain → drift = 0 → over → ok, recovery
    // page fires.
    onChainPerCode.set('USDLOOP', 1000n * STROOPS_PER_MINOR);
    const t3 = await runAssetDriftTick({ thresholdStroops: 1_000_000n });
    const usdSample3 = t3.samples.find((s) => s.assetCode === 'USDLOOP');
    expect(usdSample3?.over).toBe(false);
    expect(usdSample3?.notified).toBe(true);
    expect(notifyAssetDriftRecovered).toHaveBeenCalledTimes(1);

    // Tick 4: still ok. No further pages.
    const t4 = await runAssetDriftTick({ thresholdStroops: 1_000_000n });
    expect(t4.samples.find((s) => s.assetCode === 'USDLOOP')?.notified).toBe(false);
    expect(notifyAssetDrift).toHaveBeenCalledTimes(1);
    expect(notifyAssetDriftRecovered).toHaveBeenCalledTimes(1);
  });

  it('Horizon failure on one asset skips it without flipping its state', async () => {
    // The ledger-side liability read still hits real postgres for
    // every asset. A Horizon throw on USDLOOP must short-circuit
    // BEFORE the state Map is updated — the next successful tick
    // can then fire a fresh ok → over transition.
    const user = await findOrCreateUserByEmail('horizon-fail@test.local');
    await db.insert(userCredits).values({ userId: user.id, currency: 'USD', balanceMinor: 1000n });

    vi.mocked(getLoopAssetCirculation).mockImplementation(async (code, issuer) => {
      if (code === 'USDLOOP') throw new Error('Horizon timeout');
      return { stroops: 0n, assetCode: code, issuer, asOfMs: Date.now() };
    });

    const t1 = await runAssetDriftTick({ thresholdStroops: 1_000_000n });
    expect(t1.skipped).toBeGreaterThanOrEqual(1);
    // USDLOOP didn't make it into samples (skipped).
    expect(t1.samples.find((s) => s.assetCode === 'USDLOOP')).toBeUndefined();
    expect(notifyAssetDrift).not.toHaveBeenCalled();

    // Next tick: Horizon recovers, drift is over → first page.
    vi.mocked(getLoopAssetCirculation).mockImplementation(async (code, issuer) => ({
      stroops: 0n,
      assetCode: code,
      issuer,
      asOfMs: Date.now(),
    }));
    const t2 = await runAssetDriftTick({ thresholdStroops: 1_000_000n });
    const usd = t2.samples.find((s) => s.assetCode === 'USDLOOP');
    expect(usd?.over).toBe(true);
    expect(usd?.notified).toBe(true);
    expect(notifyAssetDrift).toHaveBeenCalledTimes(1);
  });
});
