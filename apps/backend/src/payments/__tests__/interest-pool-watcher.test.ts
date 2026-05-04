import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    notifyInterestPoolLow: vi.fn<(args: unknown) => void>(() => undefined),
    notifyInterestPoolRecovered: vi.fn<(args: unknown) => void>(() => undefined),
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

import { runInterestPoolWatcherTick } from '../interest-pool-watcher.js';

beforeEach(() => {
  mocks.resolveInterestPoolAccount.mockReset();
  mocks.configuredLoopPayableAssets.mockReset();
  mocks.computeInterestForecast.mockReset();
  mocks.getAssetBalance.mockReset();
  mocks.notifyInterestPoolLow.mockReset();
  mocks.notifyInterestPoolRecovered.mockReset();
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
});
