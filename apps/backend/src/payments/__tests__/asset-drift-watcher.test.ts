import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    configuredLoopPayableAssets: vi.fn<
      () => ReadonlyArray<{ code: 'USDLOOP' | 'GBPLOOP' | 'EURLOOP'; issuer: string }>
    >(() => []),
    sumOutstandingLiability: vi.fn<(currency: string) => Promise<bigint>>(async () => 0n),
    getLoopAssetCirculation: vi.fn<
      (
        code: string,
        issuer: string,
      ) => Promise<{ stroops: bigint; assetCode: string; issuer: string; asOfMs: number }>
    >(async () => ({ stroops: 0n, assetCode: '', issuer: '', asOfMs: 0 })),
    notifyAssetDrift: vi.fn<(args: unknown) => void>(() => undefined),
    notifyAssetDriftRecovered: vi.fn<(args: unknown) => void>(() => undefined),
  },
}));

vi.mock('../../credits/payout-asset.js', () => ({
  configuredLoopPayableAssets: () => mocks.configuredLoopPayableAssets(),
}));

vi.mock('../../credits/liabilities.js', () => ({
  sumOutstandingLiability: (c: string) => mocks.sumOutstandingLiability(c),
}));

vi.mock('../horizon-circulation.js', () => ({
  getLoopAssetCirculation: (code: string, issuer: string) =>
    mocks.getLoopAssetCirculation(code, issuer),
}));

vi.mock('../../discord.js', () => ({
  notifyAssetDrift: (args: unknown) => mocks.notifyAssetDrift(args),
  notifyAssetDriftRecovered: (args: unknown) => mocks.notifyAssetDriftRecovered(args),
}));

import { runAssetDriftTick, __resetAssetDriftWatcherForTests } from '../asset-drift-watcher.js';

beforeEach(() => {
  __resetAssetDriftWatcherForTests();
  mocks.configuredLoopPayableAssets.mockReset();
  mocks.sumOutstandingLiability.mockReset();
  mocks.getLoopAssetCirculation.mockReset();
  mocks.notifyAssetDrift.mockReset();
  mocks.notifyAssetDriftRecovered.mockReset();
});

describe('runAssetDriftTick', () => {
  it('skips assets with no configured issuer (empty list)', async () => {
    mocks.configuredLoopPayableAssets.mockReturnValue([]);
    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.checked).toBe(0);
    expect(r.samples).toHaveLength(0);
    expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();
  });

  it('pages on ok → over transition and computes drift = on-chain - ledger × 1e5', async () => {
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'USDLOOP', issuer: 'GABC' }]);
    // 200 stroops on-chain, 1 minor unit = 100_000 stroops off-chain.
    // drift = 200 - 100_000 = -99_800. abs drift > threshold (1_000).
    mocks.getLoopAssetCirculation.mockResolvedValue({
      stroops: 200n,
      assetCode: 'USDLOOP',
      issuer: 'GABC',
      asOfMs: 0,
    });
    mocks.sumOutstandingLiability.mockResolvedValue(1n);

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.checked).toBe(1);
    expect(r.samples[0]!.driftStroops).toBe(-99_800n);
    expect(r.samples[0]!.over).toBe(true);
    expect(r.samples[0]!.notified).toBe(true);
    expect(mocks.notifyAssetDrift).toHaveBeenCalledOnce();
    expect(mocks.notifyAssetDriftRecovered).not.toHaveBeenCalled();
  });

  it('does NOT page on unknown → ok transition', async () => {
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'USDLOOP', issuer: 'GABC' }]);
    // Zero drift — ledger matches on-chain exactly.
    mocks.getLoopAssetCirculation.mockResolvedValue({
      stroops: 500_000n,
      assetCode: 'USDLOOP',
      issuer: 'GABC',
      asOfMs: 0,
    });
    mocks.sumOutstandingLiability.mockResolvedValue(5n); // 5 × 1e5 = 500_000

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.samples[0]!.over).toBe(false);
    expect(r.samples[0]!.notified).toBe(false);
    expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();
  });

  it('dedupes repeat ticks while still over-threshold — only the first ticks fires', async () => {
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'USDLOOP', issuer: 'GABC' }]);
    mocks.getLoopAssetCirculation.mockResolvedValue({
      stroops: 10_000_000n,
      assetCode: 'USDLOOP',
      issuer: 'GABC',
      asOfMs: 0,
    });
    mocks.sumOutstandingLiability.mockResolvedValue(0n);

    await runAssetDriftTick({ thresholdStroops: 1_000n });
    await runAssetDriftTick({ thresholdStroops: 1_000n });
    await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(mocks.notifyAssetDrift).toHaveBeenCalledOnce();
  });

  it('pages recovery on over → ok transition', async () => {
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'USDLOOP', issuer: 'GABC' }]);
    // Tick 1: drift over threshold.
    mocks.getLoopAssetCirculation.mockResolvedValueOnce({
      stroops: 10_000_000n,
      assetCode: 'USDLOOP',
      issuer: 'GABC',
      asOfMs: 0,
    });
    mocks.sumOutstandingLiability.mockResolvedValueOnce(0n);
    await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(mocks.notifyAssetDrift).toHaveBeenCalledOnce();

    // Tick 2: drift zero.
    mocks.getLoopAssetCirculation.mockResolvedValueOnce({
      stroops: 500_000n,
      assetCode: 'USDLOOP',
      issuer: 'GABC',
      asOfMs: 0,
    });
    mocks.sumOutstandingLiability.mockResolvedValueOnce(5n);
    await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(mocks.notifyAssetDriftRecovered).toHaveBeenCalledOnce();
  });

  it('skips an asset when Horizon read throws — does not flip state', async () => {
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'USDLOOP', issuer: 'GABC' }]);
    // Tick 1: establish "over" state.
    mocks.getLoopAssetCirculation.mockResolvedValueOnce({
      stroops: 10_000_000n,
      assetCode: 'USDLOOP',
      issuer: 'GABC',
      asOfMs: 0,
    });
    mocks.sumOutstandingLiability.mockResolvedValueOnce(0n);
    await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(mocks.notifyAssetDrift).toHaveBeenCalledOnce();

    // Tick 2: Horizon throws — must NOT fire a recovery.
    mocks.getLoopAssetCirculation.mockRejectedValueOnce(new Error('Horizon 503'));
    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.skipped).toBe(1);
    expect(r.checked).toBe(0);
    expect(mocks.notifyAssetDriftRecovered).not.toHaveBeenCalled();

    // Tick 3: Horizon recovers, asset is still over — must NOT re-fire
    // notifyAssetDrift because the in-memory state is still 'over'.
    mocks.getLoopAssetCirculation.mockResolvedValueOnce({
      stroops: 10_000_000n,
      assetCode: 'USDLOOP',
      issuer: 'GABC',
      asOfMs: 0,
    });
    mocks.sumOutstandingLiability.mockResolvedValueOnce(0n);
    await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(mocks.notifyAssetDrift).toHaveBeenCalledOnce();
  });

  it('runs each configured asset independently — one asset over, another ok', async () => {
    mocks.configuredLoopPayableAssets.mockReturnValue([
      { code: 'USDLOOP', issuer: 'GUSD' },
      { code: 'GBPLOOP', issuer: 'GGBP' },
    ]);
    mocks.getLoopAssetCirculation.mockImplementation(async (code) => ({
      stroops: code === 'USDLOOP' ? 10_000_000n : 500_000n,
      assetCode: code,
      issuer: '',
      asOfMs: 0,
    }));
    mocks.sumOutstandingLiability.mockImplementation(async (currency) =>
      currency === 'USD' ? 0n : 5n,
    );

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.checked).toBe(2);
    const usd = r.samples.find((s) => s.assetCode === 'USDLOOP');
    const gbp = r.samples.find((s) => s.assetCode === 'GBPLOOP');
    expect(usd?.over).toBe(true);
    expect(gbp?.over).toBe(false);
    expect(mocks.notifyAssetDrift).toHaveBeenCalledOnce();
  });
});
