import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PoolStateRepo from '../interest-pool-alert-state-repo.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    resolveInterestPoolAccount: vi.fn<() => string | null>(() => null),
    configuredLoopPayableAssets: vi.fn<
      () => ReadonlyArray<{ code: 'USDLOOP' | 'GBPLOOP' | 'EURLOOP'; issuer: string }>
    >(() => []),
    computeInterestForecast: vi.fn(),
    getAssetBalance: vi.fn<
      (account: string, code: string, issuer: string) => Promise<bigint | null>
    >(async () => null),
    notifyInterestPoolLow: vi.fn<(args: unknown) => Promise<boolean>>(async () => true),
    notifyInterestPoolRecovered: vi.fn<(args: unknown) => Promise<boolean>>(async () => true),
    // C10a: in-memory emulation of the persisted alert-state repo so
    // the unit suite exercises the REAL transition logic (low↔ok
    // dedup, at-least-once) without a database. `lastPaged` is what
    // `last_paged_state` would hold; markPoolPageDelivered advances it,
    // releasePoolPageLease is a no-op here.
    lastPaged: new Map<string, 'ok' | 'low' | null>(),
  },
}));

vi.mock('../../credits/interest-pool.js', () => ({
  resolveInterestPoolAccount: () => mocks.resolveInterestPoolAccount(),
}));

vi.mock('../../credits/payout-asset.js', () => ({
  configuredLoopPayableAssets: () => mocks.configuredLoopPayableAssets(),
}));

vi.mock('../../credits/interest-forecast.js', () => ({
  computeInterestForecast: (args: unknown) => mocks.computeInterestForecast(args),
}));

vi.mock('../horizon-asset-balance.js', () => ({
  getAssetBalance: (account: string, code: string, issuer: string) =>
    mocks.getAssetBalance(account, code, issuer),
}));

vi.mock('../../discord.js', () => ({
  notifyInterestPoolLow: (args: unknown) => mocks.notifyInterestPoolLow(args),
  notifyInterestPoolRecovered: (args: unknown) => mocks.notifyInterestPoolRecovered(args),
}));

vi.mock('../interest-pool-alert-state-repo.js', async () => {
  // Import the REAL pure due-page logic so the emulation matches prod.
  const actual = await vi.importActual<typeof PoolStateRepo>(
    '../interest-pool-alert-state-repo.js',
  );
  return {
    computePoolDuePage: actual.computePoolDuePage,
    applyPoolAlertState: async (args: { assetCode: string; state: 'ok' | 'low' }) => {
      const due = actual.computePoolDuePage({
        state: args.state,
        lastPagedState: mocks.lastPaged.get(args.assetCode) ?? null,
      });
      return { prior: 'unknown' as const, raced: false, duePage: due };
    },
    markPoolPageDelivered: async (args: { assetCode: string; page: 'low' | 'recovered' }) => {
      mocks.lastPaged.set(args.assetCode, args.page === 'low' ? 'low' : 'ok');
    },
    releasePoolPageLease: async () => undefined,
  };
});

import { runInterestPoolWatcherTick } from '../interest-pool-watcher.js';

beforeEach(() => {
  mocks.resolveInterestPoolAccount.mockReset();
  mocks.configuredLoopPayableAssets.mockReset();
  mocks.computeInterestForecast.mockReset();
  mocks.getAssetBalance.mockReset();
  mocks.notifyInterestPoolLow.mockReset();
  mocks.notifyInterestPoolLow.mockResolvedValue(true);
  mocks.notifyInterestPoolRecovered.mockReset();
  mocks.notifyInterestPoolRecovered.mockResolvedValue(true);
  mocks.lastPaged.clear();
});

describe('runInterestPoolWatcherTick', () => {
  it('skips silently when no pool account is configured', async () => {
    mocks.resolveInterestPoolAccount.mockReturnValue(null);
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'USDLOOP', issuer: 'GABC' }]);
    const r = await runInterestPoolWatcherTick({ apyBasisPoints: 350, minDaysOfCover: 7 });
    expect(r.checked).toBe(0);
    expect(mocks.notifyInterestPoolLow).not.toHaveBeenCalled();
  });

  it('skips silently when APY is zero', async () => {
    mocks.resolveInterestPoolAccount.mockReturnValue('GPOOL');
    const r = await runInterestPoolWatcherTick({ apyBasisPoints: 0, minDaysOfCover: 7 });
    expect(r.checked).toBe(0);
    expect(mocks.notifyInterestPoolLow).not.toHaveBeenCalled();
  });

  it('pages when pool cover drops below the threshold', async () => {
    mocks.resolveInterestPoolAccount.mockReturnValue('GPOOL');
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'USDLOOP', issuer: 'GABC' }]);
    // Pool holds 5_000_000 stroops. Daily interest = 1_000_000 stroops.
    // Days of cover = 5. Threshold = 7 → below → page.
    mocks.getAssetBalance.mockResolvedValue(5_000_000n);
    mocks.computeInterestForecast.mockResolvedValue({
      apyBasisPoints: 350,
      forecastDays: 1,
      asOfMs: 0,
      perCurrency: [
        {
          currency: 'USD',
          assetCode: 'USDLOOP',
          cohortBalanceMinor: 0n,
          dailyInterestMinor: 10n, // × 1e5 = 1_000_000 stroops
          forecastDays: 1,
          forecastInterestMinor: 10n,
        },
      ],
    });

    const r = await runInterestPoolWatcherTick({ apyBasisPoints: 350, minDaysOfCover: 7 });
    expect(r.checked).toBe(1);
    expect(r.samples[0]!.belowThreshold).toBe(true);
    expect(r.samples[0]!.daysOfCover).toBe(5);
    expect(mocks.notifyInterestPoolLow).toHaveBeenCalledOnce();
    expect(mocks.notifyInterestPoolRecovered).not.toHaveBeenCalled();
  });

  it('does not page when pool cover is healthy', async () => {
    mocks.resolveInterestPoolAccount.mockReturnValue('GPOOL');
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'USDLOOP', issuer: 'GABC' }]);
    // 30 days of cover at 1_000_000 stroops/day.
    mocks.getAssetBalance.mockResolvedValue(30_000_000n);
    mocks.computeInterestForecast.mockResolvedValue({
      apyBasisPoints: 350,
      forecastDays: 1,
      asOfMs: 0,
      perCurrency: [
        {
          currency: 'USD',
          assetCode: 'USDLOOP',
          cohortBalanceMinor: 0n,
          dailyInterestMinor: 10n,
          forecastDays: 1,
          forecastInterestMinor: 10n,
        },
      ],
    });

    const r = await runInterestPoolWatcherTick({ apyBasisPoints: 350, minDaysOfCover: 7 });
    expect(r.samples[0]!.belowThreshold).toBe(false);
    expect(mocks.notifyInterestPoolLow).not.toHaveBeenCalled();
  });

  // C10a: the transition dedup is persisted, so a `low` already paged
  // (last_paged_state='low') does NOT re-page on the next low tick, and
  // a subsequent recovery DOES close it — even though (in the old
  // per-process Set) the "recovered" could be computed on a different
  // machine than paged the low.
  function forecast(dailyMinor: bigint): unknown {
    return {
      apyBasisPoints: 350,
      forecastDays: 1,
      asOfMs: 0,
      perCurrency: [
        {
          currency: 'USD',
          assetCode: 'USDLOOP',
          cohortBalanceMinor: 0n,
          dailyInterestMinor: dailyMinor,
          forecastDays: 1,
          forecastInterestMinor: dailyMinor,
        },
      ],
    };
  }

  it('does not re-page an already-paged low, then pages recovery when it clears', async () => {
    mocks.resolveInterestPoolAccount.mockReturnValue('GPOOL');
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'USDLOOP', issuer: 'GABC' }]);
    mocks.computeInterestForecast.mockResolvedValue(forecast(10n)); // 1e6 stroops/day

    // Tick 1: 5 days cover (< 7) → pages low once, marks last_paged='low'.
    mocks.getAssetBalance.mockResolvedValue(5_000_000n);
    await runInterestPoolWatcherTick({ apyBasisPoints: 350, minDaysOfCover: 7 });
    expect(mocks.notifyInterestPoolLow).toHaveBeenCalledTimes(1);

    // Tick 2: still low (4 days) → already paged, so NO second low page.
    mocks.getAssetBalance.mockResolvedValue(4_000_000n);
    await runInterestPoolWatcherTick({ apyBasisPoints: 350, minDaysOfCover: 7 });
    expect(mocks.notifyInterestPoolLow).toHaveBeenCalledTimes(1);
    expect(mocks.notifyInterestPoolRecovered).not.toHaveBeenCalled();

    // Tick 3: replenished (30 days) → recovery closes the incident.
    mocks.getAssetBalance.mockResolvedValue(30_000_000n);
    await runInterestPoolWatcherTick({ apyBasisPoints: 350, minDaysOfCover: 7 });
    expect(mocks.notifyInterestPoolRecovered).toHaveBeenCalledTimes(1);
  });

  it('does not re-fire a low page whose delivery FAILED — retries next tick (at-least-once)', async () => {
    mocks.resolveInterestPoolAccount.mockReturnValue('GPOOL');
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'USDLOOP', issuer: 'GABC' }]);
    mocks.computeInterestForecast.mockResolvedValue(forecast(10n));
    mocks.getAssetBalance.mockResolvedValue(5_000_000n);

    // Tick 1: send FAILS (returns false) → lease released, last_paged
    // NOT advanced, so the page stays due.
    mocks.notifyInterestPoolLow.mockResolvedValueOnce(false);
    await runInterestPoolWatcherTick({ apyBasisPoints: 350, minDaysOfCover: 7 });
    expect(mocks.notifyInterestPoolLow).toHaveBeenCalledTimes(1);

    // Tick 2: still due (delivery never confirmed) → retries.
    await runInterestPoolWatcherTick({ apyBasisPoints: 350, minDaysOfCover: 7 });
    expect(mocks.notifyInterestPoolLow).toHaveBeenCalledTimes(2);
  });
});
