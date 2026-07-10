import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `vault-apy.ts` (ADR 031 §D8, V5b) — the APY math + the DB-backed
 * compute wrappers. `computeApyFromSharePriceSeries` /
 * `computeGbploopApyFromBuckets` / `annualizeRatio` are pure functions
 * tested against known-value fixtures (no mocks needed for those
 * assertions, but the module's top-level imports still need mocking
 * so the file can load). The DB-facing wrappers are tested against a
 * mocked registry / db.
 */

const { MAINNET_PASSPHRASE, mutableEnv, mocks } = vi.hoisted(() => ({
  MAINNET_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
  mutableEnv: { LOOP_STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015' },
  mocks: {
    vaultsEnabled: vi.fn<() => boolean>(() => true),
    listActiveVaults: vi.fn<(network: string) => Promise<unknown[]>>(async () => []),
    listSharePriceSnapshotsSince: vi.fn<
      (
        a: string,
        n: string,
        since: Date,
      ) => Promise<Array<{ takenAt: Date; sharePricePpm: bigint }>>
    >(async () => []),
    dbSelectRows: [] as Array<{ createdAt: Date; balanceStroops: bigint; accrualStroops: bigint }>,
  },
}));

vi.mock('../../../env.js', () => ({ env: mutableEnv }));
vi.mock('../../../env/schema-helpers.js', () => ({
  MAINNET_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
}));
vi.mock('../registry.js', () => ({
  vaultsEnabled: mocks.vaultsEnabled,
  listActiveVaults: mocks.listActiveVaults,
  listSharePriceSnapshotsSince: mocks.listSharePriceSnapshotsSince,
}));
vi.mock('../../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => mocks.dbSelectRows,
      }),
    }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  interestMintSnapshots: {
    assetCode: 'asset_code',
    createdAt: 'created_at',
    balanceStroops: 'balance_stroops',
    accrualStroops: 'accrual_stroops',
  },
}));

import {
  annualizeRatio,
  computeApyFromSharePriceSeries,
  computeGbploopApyFromBuckets,
  computeVaultApy,
  computeGbploopApy,
  listVaultApyAssets,
  currentVaultNetwork,
} from '../vault-apy.js';

beforeEach(() => {
  mutableEnv.LOOP_STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
  mocks.vaultsEnabled.mockReset();
  mocks.vaultsEnabled.mockReturnValue(true);
  mocks.listActiveVaults.mockReset();
  mocks.listActiveVaults.mockResolvedValue([]);
  mocks.listSharePriceSnapshotsSince.mockReset();
  mocks.listSharePriceSnapshotsSince.mockResolvedValue([]);
  mocks.dbSelectRows = [];
});

describe('annualizeRatio', () => {
  it('a known-value fixture: 5% growth over exactly 365 days annualises to exactly 5%', () => {
    expect(annualizeRatio(1.05, 365)).toBeCloseTo(0.05, 10);
  });

  it('returns null for a non-positive or non-finite ratio', () => {
    expect(annualizeRatio(0, 30)).toBeNull();
    expect(annualizeRatio(-1, 30)).toBeNull();
    expect(annualizeRatio(NaN, 30)).toBeNull();
  });

  it('returns null for a non-positive days-between', () => {
    expect(annualizeRatio(1.05, 0)).toBeNull();
    expect(annualizeRatio(1.05, -5)).toBeNull();
  });
});

describe('computeApyFromSharePriceSeries', () => {
  const day = (n: number, base: Date = new Date('2026-01-01T00:00:00Z')): Date =>
    new Date(base.getTime() + n * 86_400_000);

  it('returns null/null with fewer than two snapshots', () => {
    expect(computeApyFromSharePriceSeries([])).toEqual({ past30dApy: null, past90dRange: null });
    expect(
      computeApyFromSharePriceSeries([{ takenAt: day(0), sharePricePpm: 1_000_000n }]),
    ).toEqual({ past30dApy: null, past90dRange: null });
  });

  it('returns null/null when no sample is at least 30 days old yet', () => {
    const result = computeApyFromSharePriceSeries([
      { takenAt: day(0), sharePricePpm: 1_000_000n },
      { takenAt: day(10), sharePricePpm: 1_001_000n },
    ]);
    expect(result).toEqual({ past30dApy: null, past90dRange: null });
  });

  it('computes past30dApy from the nearest ≥30d-old reference, and a consistent past90dRange', () => {
    // 1% growth every 30 days, four samples 90 days apart in total —
    // every anchor from day30 onward has a valid ≥30d-old reference,
    // and the growth rate is constant, so past30dApy and the whole
    // past90dRange collapse to the SAME figure (a strong, predictable
    // assertion on both the annualisation math and the range logic).
    const series = [
      { takenAt: day(0), sharePricePpm: 1_000_000n },
      { takenAt: day(30), sharePricePpm: 1_010_000n },
      { takenAt: day(60), sharePricePpm: 1_020_100n },
      { takenAt: day(90), sharePricePpm: 1_030_301n },
    ];
    const result = computeApyFromSharePriceSeries(series);
    const expectedApy = Math.pow(1.01, 365 / 30) - 1;
    expect(result.past30dApy).toBeCloseTo(expectedApy, 8);
    expect(result.past90dRange).not.toBeNull();
    expect(result.past90dRange!.minApy).toBeCloseTo(expectedApy, 8);
    expect(result.past90dRange!.maxApy).toBeCloseTo(expectedApy, 8);
  });

  it('uses the ACTUAL days between samples in the exponent, not a hardcoded 30', () => {
    // Reference lands 31 days before the latest sample (a skipped
    // tick) — the exponent must use 31, not 30, or the annualised
    // figure would be silently wrong.
    const ref = { takenAt: day(0), sharePricePpm: 1_000_000n };
    const latest = { takenAt: day(31), sharePricePpm: 1_010_000n };
    const result = computeApyFromSharePriceSeries([ref, latest]);
    const expectedApy = annualizeRatio(1_010_000 / 1_000_000, 31);
    expect(result.past30dApy).toBeCloseTo(expectedApy!, 10);
  });
});

describe('computeGbploopApyFromBuckets', () => {
  const now = new Date('2026-07-11T00:00:00Z');
  const daysAgoKey = (n: number): string => {
    const d = new Date(now.getTime() - n * 86_400_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
      d.getUTCDate(),
    ).padStart(2, '0')}`;
  };

  it('returns null/null with fewer than two day-buckets', () => {
    const buckets = new Map([[daysAgoKey(40), { balanceStroops: 100n, accrualStroops: 1n }]]);
    expect(computeGbploopApyFromBuckets(buckets, now)).toEqual({
      past30dApy: null,
      past90dRange: null,
    });
  });

  it('returns null/null when the oldest bucket is under 30 days old', () => {
    const buckets = new Map([
      [daysAgoKey(5), { balanceStroops: 1_000_000n, accrualStroops: 100n }],
      [daysAgoKey(2), { balanceStroops: 1_000_000n, accrualStroops: 100n }],
    ]);
    expect(computeGbploopApyFromBuckets(buckets, now)).toEqual({
      past30dApy: null,
      past90dRange: null,
    });
  });

  it('restricts past30dApy to buckets within the last 30 days, balance-weighted; the 90d range covers every bucket', () => {
    const buckets = new Map([
      // Outside the 30d window, but inside the 90d range — and also
      // what makes the "≥30 days of history" gate pass.
      [daysAgoKey(40), { balanceStroops: 500_000n, accrualStroops: 50_000n }], // rate 0.10/day
      [daysAgoKey(20), { balanceStroops: 1_000_000n, accrualStroops: 300_000n }], // rate 0.30/day
      [daysAgoKey(10), { balanceStroops: 2_000_000n, accrualStroops: 100_000n }], // rate 0.05/day
    ]);

    const result = computeGbploopApyFromBuckets(buckets, now);

    // past30dApy: balance-weighted average of ONLY the day-20 and
    // day-10 buckets (day-40 falls outside the 30-day window).
    const sumBalance = 1_000_000 + 2_000_000;
    const sumAccrual = 300_000 + 100_000;
    const expectedDailyRate = sumAccrual / sumBalance;
    const expectedApy = Math.pow(1 + expectedDailyRate, 365) - 1;
    expect(result.past30dApy).toBeCloseTo(expectedApy, 6);

    // past90dRange: all three buckets contribute their OWN day's rate
    // — day-40's 0.10 rate is excluded from past30dApy but must still
    // show up in the range (min = day-10's 0.05 rate, max = day-20's
    // 0.30 rate).
    const apy40 = Math.pow(1 + 50_000 / 500_000, 365) - 1;
    const apy20 = Math.pow(1 + 300_000 / 1_000_000, 365) - 1;
    const apy10 = Math.pow(1 + 100_000 / 2_000_000, 365) - 1;
    expect(result.past90dRange).not.toBeNull();
    expect(result.past90dRange!.minApy).toBeCloseTo(Math.min(apy40, apy20, apy10), 6);
    expect(result.past90dRange!.maxApy).toBeCloseTo(Math.max(apy40, apy20, apy10), 6);
  });
});

describe('currentVaultNetwork', () => {
  it('resolves testnet/mainnet from the configured passphrase', () => {
    mutableEnv.LOOP_STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
    expect(currentVaultNetwork()).toBe('testnet');
    mutableEnv.LOOP_STELLAR_NETWORK_PASSPHRASE = MAINNET_PASSPHRASE;
    expect(currentVaultNetwork()).toBe('mainnet');
  });
});

describe('computeVaultApy', () => {
  it('returns null/null when the vault subsystem is disabled, without reading the DB', async () => {
    mocks.vaultsEnabled.mockReturnValue(false);
    const result = await computeVaultApy('LOOPUSD', 'testnet');
    expect(result).toEqual({ past30dApy: null, past90dRange: null });
    expect(mocks.listSharePriceSnapshotsSince).not.toHaveBeenCalled();
  });

  it('computes from the fetched series when enabled', async () => {
    mocks.listSharePriceSnapshotsSince.mockResolvedValue([
      { takenAt: new Date('2026-01-01T00:00:00Z'), sharePricePpm: 1_000_000n },
      { takenAt: new Date('2026-01-31T00:00:00Z'), sharePricePpm: 1_010_000n },
    ]);
    const result = await computeVaultApy('LOOPUSD', 'testnet');
    expect(result.past30dApy).not.toBeNull();
    expect(mocks.listSharePriceSnapshotsSince).toHaveBeenCalledWith(
      'LOOPUSD',
      'testnet',
      expect.any(Date),
    );
  });
});

describe('listVaultApyAssets', () => {
  it('is empty when no vault is active (vaults disabled or none registered)', async () => {
    mocks.listActiveVaults.mockResolvedValue([]);
    const result = await listVaultApyAssets();
    expect(result).toEqual([]);
  });

  it('pairs every active vault with its computed APY', async () => {
    mocks.listActiveVaults.mockResolvedValue([
      { assetCode: 'LOOPUSD', network: 'testnet' },
      { assetCode: 'LOOPEUR', network: 'testnet' },
    ]);
    mocks.listSharePriceSnapshotsSince.mockResolvedValue([]);
    const result = await listVaultApyAssets();
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.assetCode)).toEqual(['LOOPUSD', 'LOOPEUR']);
    expect(result[0]!.apy).toEqual({ past30dApy: null, past90dRange: null });
  });
});

describe('computeGbploopApy', () => {
  it('returns null/null when there is no mint history', async () => {
    mocks.dbSelectRows = [];
    const result = await computeGbploopApy(new Date('2026-07-11T00:00:00Z'));
    expect(result).toEqual({ past30dApy: null, past90dRange: null });
  });

  it('buckets rows by UTC day and computes an APY once there is enough history', async () => {
    const now = new Date('2026-07-11T00:00:00Z');
    mocks.dbSelectRows = [
      {
        createdAt: new Date(now.getTime() - 40 * 86_400_000),
        balanceStroops: 1_000_000n,
        accrualStroops: 82n,
      },
      {
        createdAt: new Date(now.getTime() - 10 * 86_400_000),
        balanceStroops: 1_000_000n,
        accrualStroops: 82n,
      },
    ];
    const result = await computeGbploopApy(now);
    expect(result.past30dApy).not.toBeNull();
    expect(result.past30dApy).toBeGreaterThan(0);
  });
});

describe('no yield-source disclosure (ADR 031 §User-facing display)', () => {
  const FORBIDDEN = /defindex|blend|soroban|strategy|vault/i;

  it('never surfaces a forbidden mechanism word in a computed result or its JSON form', async () => {
    mocks.listSharePriceSnapshotsSince.mockResolvedValue([
      { takenAt: new Date('2026-01-01T00:00:00Z'), sharePricePpm: 1_000_000n },
      { takenAt: new Date('2026-02-01T00:00:00Z'), sharePricePpm: 1_010_000n },
    ]);
    const vaultResult = await computeVaultApy('LOOPUSD', 'testnet');
    const gbpResult = await computeGbploopApy();
    expect(JSON.stringify(vaultResult)).not.toMatch(FORBIDDEN);
    expect(JSON.stringify(gbpResult)).not.toMatch(FORBIDDEN);
  });
});
