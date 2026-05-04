import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    apyBasisPoints: 0,
    poolAccount: null as string | null,
    minDaysCover: 7,
    forecast: {
      apyBasisPoints: 0,
      forecastDays: 35,
      asOfMs: 0,
      perCurrency: [] as Array<{
        currency: 'USD' | 'GBP' | 'EUR';
        assetCode: 'USDLOOP' | 'GBPLOOP' | 'EURLOOP';
        cohortBalanceMinor: bigint;
        dailyInterestMinor: bigint;
        forecastDays: number;
        forecastInterestMinor: bigint;
      }>,
    },
    configuredAssets: [] as ReadonlyArray<{
      code: 'USDLOOP' | 'GBPLOOP' | 'EURLOOP';
      issuer: string;
    }>,
    assetBalance: vi.fn<(account: string, code: string, issuer: string) => Promise<bigint | null>>(
      async () => null,
    ),
  },
}));

vi.mock('../../env.js', () => ({
  get env() {
    return { INTEREST_APY_BASIS_POINTS: mocks.apyBasisPoints };
  },
}));

vi.mock('../../credits/interest-forecast.js', () => ({
  computeInterestForecast: async () => mocks.forecast,
}));

vi.mock('../../credits/interest-pool.js', () => ({
  resolveInterestPoolAccount: () => mocks.poolAccount,
}));

vi.mock('../../credits/payout-asset.js', () => ({
  configuredLoopPayableAssets: () => mocks.configuredAssets,
}));

vi.mock('../../payments/horizon-asset-balance.js', () => ({
  getAssetBalance: (a: string, c: string, i: string) => mocks.assetBalance(a, c, i),
}));

vi.mock('../../payments/interest-pool-watcher.js', () => ({
  resolvePoolMinDaysCover: () => mocks.minDaysCover,
}));

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { adminInterestMintForecastHandler } from '../interest-mint-forecast.js';

function fakeContext(query: Record<string, string> = {}): Context {
  return {
    req: {
      query: (k: string) => query[k],
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  mocks.apyBasisPoints = 0;
  mocks.poolAccount = null;
  mocks.minDaysCover = 7;
  mocks.configuredAssets = [];
  mocks.forecast = {
    apyBasisPoints: 0,
    forecastDays: 35,
    asOfMs: 0,
    perCurrency: [],
  };
  mocks.assetBalance.mockReset();
  mocks.assetBalance.mockResolvedValue(null);
});

describe('adminInterestMintForecastHandler', () => {
  it('returns rows: null when interest is feature-off', async () => {
    mocks.apyBasisPoints = 0;
    const res = await adminInterestMintForecastHandler(fakeContext());
    const body = (await res.json()) as { apyBasisPoints: number; rows: unknown };
    expect(body.apyBasisPoints).toBe(0);
    expect(body.rows).toBeNull();
  });

  it('emits per-currency rows with pool balance, days of cover, and recommended mint', async () => {
    mocks.apyBasisPoints = 350;
    mocks.poolAccount = 'GPOOL';
    mocks.configuredAssets = [{ code: 'USDLOOP', issuer: 'GABC' }];
    mocks.forecast = {
      apyBasisPoints: 350,
      forecastDays: 35,
      asOfMs: 1_700_000_000_000,
      perCurrency: [
        {
          currency: 'USD',
          assetCode: 'USDLOOP',
          cohortBalanceMinor: 1_000_000n, // $10_000
          // 4% APY on $10k → $400/yr → ~110 cents/day
          dailyInterestMinor: 110n,
          forecastDays: 35,
          forecastInterestMinor: 3_850n, // 110 × 35
        },
      ],
    };
    // Pool holds 5_000_000 stroops (= 50 minor) — way short.
    mocks.assetBalance.mockResolvedValue(5_000_000n);

    const res = await adminInterestMintForecastHandler(fakeContext());
    const body = (await res.json()) as {
      rows: Array<{
        assetCode: string;
        cohortBalanceMinor: string;
        dailyInterestStroops: string;
        forecastInterestStroops: string;
        poolStroops: string;
        recommendedMintStroops: string;
        daysOfCover: number | null;
      }>;
    };
    expect(body.rows).not.toBeNull();
    const row = body.rows[0]!;
    expect(row.assetCode).toBe('USDLOOP');
    expect(row.cohortBalanceMinor).toBe('1000000');
    expect(row.dailyInterestStroops).toBe('11000000'); // 110 × 1e5
    expect(row.forecastInterestStroops).toBe('385000000'); // 3850 × 1e5
    expect(row.poolStroops).toBe('5000000');
    // Recommendation: forecast (385M) − pool (5M) = 380M.
    expect(row.recommendedMintStroops).toBe('380000000');
    // Days of cover: 5_000_000 / 11_000_000 ≈ 0.45.
    expect(row.daysOfCover).toBeCloseTo(0.4545, 3);
  });

  it('floors recommendedMintStroops at 0 when the pool already exceeds the forecast', async () => {
    mocks.apyBasisPoints = 350;
    mocks.poolAccount = 'GPOOL';
    mocks.configuredAssets = [{ code: 'USDLOOP', issuer: 'GABC' }];
    mocks.forecast = {
      apyBasisPoints: 350,
      forecastDays: 35,
      asOfMs: 0,
      perCurrency: [
        {
          currency: 'USD',
          assetCode: 'USDLOOP',
          cohortBalanceMinor: 100n,
          dailyInterestMinor: 1n,
          forecastDays: 35,
          forecastInterestMinor: 35n,
        },
      ],
    };
    mocks.assetBalance.mockResolvedValue(50_000_000n);

    const res = await adminInterestMintForecastHandler(fakeContext());
    const body = (await res.json()) as {
      rows: Array<{ recommendedMintStroops: string }>;
    };
    expect(body.rows[0]!.recommendedMintStroops).toBe('0');
  });
});
