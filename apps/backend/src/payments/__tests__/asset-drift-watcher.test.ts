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
    // Pool-aware drift (forward-mint pool, ADR 009 / 015). Default
    // returns null = "pool not configured" so existing tests
    // exercise the pre-pool reconciliation. Per-test overrides can
    // simulate a configured pool.
    resolveInterestPoolAccount: vi.fn<() => string | null>(() => null),
    getAssetBalance: vi.fn<
      (account: string, code: string, issuer: string) => Promise<bigint | null>
    >(async () => null),
    notifyAssetDrift: vi.fn<(args: unknown) => void>(() => undefined),
    notifyAssetDriftRecovered: vi.fn<(args: unknown) => void>(() => undefined),
    // ADR 036: in-flight redemption burns (mirror already debited,
    // tokens awaiting issuer-return). Default 0n = no burns in
    // flight so the pre-ADR-036 reconciliation tests hold as-is.
    sumInFlightBurnStroops: vi.fn<
      (args: { assetCode: string; assetIssuer: string }) => Promise<bigint>
    >(async () => 0n),
    // ADR 031: in-flight nightly interest mints (mirror already
    // credited, issuer-signed mint awaiting confirmation). Default
    // 0n = nothing queued.
    sumInFlightInterestMintStroops: vi.fn<
      (args: { assetCode: string; assetIssuer: string }) => Promise<bigint>
    >(async () => 0n),
  },
}));

vi.mock('../../credits/payout-asset.js', () => ({
  configuredLoopPayableAssets: () => mocks.configuredLoopPayableAssets(),
}));

vi.mock('../../credits/liabilities.js', () => ({
  sumOutstandingLiability: (c: string) => mocks.sumOutstandingLiability(c),
}));

vi.mock('../../credits/pending-payouts.js', () => ({
  sumInFlightBurnStroops: (args: { assetCode: string; assetIssuer: string }) =>
    mocks.sumInFlightBurnStroops(args),
  sumInFlightInterestMintStroops: (args: { assetCode: string; assetIssuer: string }) =>
    mocks.sumInFlightInterestMintStroops(args),
}));

vi.mock('../horizon-circulation.js', () => ({
  getLoopAssetCirculation: (code: string, issuer: string) =>
    mocks.getLoopAssetCirculation(code, issuer),
}));

vi.mock('../horizon-asset-balance.js', () => ({
  getAssetBalance: (account: string, code: string, issuer: string) =>
    mocks.getAssetBalance(account, code, issuer),
}));

vi.mock('../../credits/interest-pool.js', () => ({
  resolveInterestPoolAccount: () => mocks.resolveInterestPoolAccount(),
}));

vi.mock('../../discord.js', () => ({
  notifyAssetDrift: (args: unknown) => mocks.notifyAssetDrift(args),
  notifyAssetDriftRecovered: (args: unknown) => mocks.notifyAssetDriftRecovered(args),
}));

import {
  runAssetDriftTick,
  getAssetDriftState,
  __resetAssetDriftWatcherForTests,
} from '../asset-drift-watcher.js';

beforeEach(() => {
  __resetAssetDriftWatcherForTests();
  mocks.configuredLoopPayableAssets.mockReset();
  mocks.sumOutstandingLiability.mockReset();
  mocks.getLoopAssetCirculation.mockReset();
  mocks.resolveInterestPoolAccount.mockReset();
  mocks.getAssetBalance.mockReset();
  mocks.notifyAssetDrift.mockReset();
  mocks.notifyAssetDriftRecovered.mockReset();
  mocks.sumInFlightBurnStroops.mockReset();
  // Default: pool not configured (matches a fresh deployment).
  mocks.resolveInterestPoolAccount.mockReturnValue(null);
  mocks.getAssetBalance.mockResolvedValue(null);
  // Default: no redemption burns in flight (ADR 036).
  mocks.sumInFlightBurnStroops.mockResolvedValue(0n);
  // Default: no interest mints in flight (ADR 031).
  mocks.sumInFlightInterestMintStroops.mockReset();
  mocks.sumInFlightInterestMintStroops.mockResolvedValue(0n);
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

  it('subtracts the interest forward-mint pool balance from on-chain when computing drift', async () => {
    // Pool configured at GPOOL. On-chain issued = 1_500_000 stroops.
    // Pool holds 1_000_000 (pre-minted forward batch). Off-chain
    // user_credits sums to 5 minor (5 × 1e5 = 500_000 stroops).
    // Pool-aware drift = (1_500_000 − 1_000_000) − 500_000 = 0.
    // (Pre-pool drift would be 1_500_000 − 500_000 = 1_000_000 → over.)
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'USDLOOP', issuer: 'GABC' }]);
    mocks.resolveInterestPoolAccount.mockReturnValue('GPOOL');
    mocks.getAssetBalance.mockResolvedValue(1_000_000n);
    mocks.getLoopAssetCirculation.mockResolvedValue({
      stroops: 1_500_000n,
      assetCode: 'USDLOOP',
      issuer: 'GABC',
      asOfMs: 0,
    });
    mocks.sumOutstandingLiability.mockResolvedValue(5n);

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.checked).toBe(1);
    const sample = r.samples[0]!;
    expect(sample.driftStroops).toBe(0n);
    expect(sample.onChainStroops).toBe(1_500_000n);
    expect(sample.poolStroops).toBe(1_000_000n);
    expect(sample.over).toBe(false);
    expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();
  });
});

describe('getAssetDriftState', () => {
  it('emits one entry per configured asset, defaulting to unknown before any tick', () => {
    mocks.configuredLoopPayableAssets.mockReturnValue([
      { code: 'USDLOOP', issuer: 'GUSD' },
      { code: 'GBPLOOP', issuer: 'GGBP' },
    ]);
    const s = getAssetDriftState();
    expect(s.lastTickMs).toBeNull();
    expect(s.running).toBe(false);
    expect(s.perAsset).toHaveLength(2);
    for (const a of s.perAsset) {
      expect(a.state).toBe('unknown');
      expect(a.lastDriftStroops).toBeNull();
      expect(a.lastCheckedMs).toBeNull();
    }
  });

  it('reflects the last-tick values per asset after a run', async () => {
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'USDLOOP', issuer: 'GUSD' }]);
    mocks.getLoopAssetCirculation.mockResolvedValue({
      stroops: 10_000_000n,
      assetCode: 'USDLOOP',
      issuer: 'GUSD',
      asOfMs: 0,
    });
    mocks.sumOutstandingLiability.mockResolvedValue(0n);
    await runAssetDriftTick({ thresholdStroops: 1_000n });

    const s = getAssetDriftState();
    expect(s.lastTickMs).not.toBeNull();
    expect(s.perAsset[0]!.state).toBe('over');
    expect(s.perAsset[0]!.lastDriftStroops).toBe(10_000_000n);
    expect(s.perAsset[0]!.lastThresholdStroops).toBe(1_000n);
    expect(s.perAsset[0]!.lastCheckedMs).not.toBeNull();
  });

  it('does not overwrite a prior snapshot for an asset whose Horizon read failed this tick', async () => {
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'USDLOOP', issuer: 'GUSD' }]);
    // Tick 1: successful — populates snapshot.
    mocks.getLoopAssetCirculation.mockResolvedValueOnce({
      stroops: 500_000n,
      assetCode: 'USDLOOP',
      issuer: 'GUSD',
      asOfMs: 0,
    });
    mocks.sumOutstandingLiability.mockResolvedValueOnce(5n);
    await runAssetDriftTick({ thresholdStroops: 1_000n });
    const before = getAssetDriftState().perAsset[0]!;
    expect(before.state).toBe('ok');

    // Tick 2: Horizon throws — snapshot must NOT be flipped.
    mocks.getLoopAssetCirculation.mockRejectedValueOnce(new Error('Horizon 503'));
    await runAssetDriftTick({ thresholdStroops: 1_000n });
    const after = getAssetDriftState().perAsset[0]!;
    expect(after.state).toBe('ok');
    expect(after.lastDriftStroops).toBe(before.lastDriftStroops);
  });
});

describe('ADR 036 — burn-aware drift equation', () => {
  it('subtracts in-flight burn stroops so a mid-redemption tick reads as zero drift', async () => {
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'GBPLOOP', issuer: 'GABC' }]);
    // Mid-redemption snapshot: the user sent 2 GBPLOOP (200_000
    // stroops) to the deposit account; markOrderPaid already debited
    // the mirror (5 → 3 minor) and enqueued the burn. Circulation
    // still counts the deposit-held 200_000 stroops until the worker
    // forwards them to the issuer.
    mocks.getLoopAssetCirculation.mockResolvedValue({
      stroops: 500_000n,
      assetCode: 'GBPLOOP',
      issuer: 'GABC',
      asOfMs: 0,
    });
    mocks.sumOutstandingLiability.mockResolvedValue(3n); // 3 × 1e5 = 300_000
    mocks.sumInFlightBurnStroops.mockResolvedValue(200_000n);

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.checked).toBe(1);
    // 500_000 − 0 (pool) − 200_000 (in-flight burn) − 300_000 = 0.
    expect(r.samples[0]!.driftStroops).toBe(0n);
    expect(r.samples[0]!.pendingBurnStroops).toBe(200_000n);
    expect(r.samples[0]!.over).toBe(false);
    expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();
    // The reader was asked about the right asset.
    expect(mocks.sumInFlightBurnStroops).toHaveBeenCalledWith({
      assetCode: 'GBPLOOP',
      assetIssuer: 'GABC',
    });
  });

  it('after the burn confirms, circulation drops and the equation stays converged', async () => {
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'GBPLOOP', issuer: 'GABC' }]);
    // Post-burn: the 200_000 stroops returned to the issuer, leaving
    // circulation at 300_000 — matching the post-debit mirror.
    mocks.getLoopAssetCirculation.mockResolvedValue({
      stroops: 300_000n,
      assetCode: 'GBPLOOP',
      issuer: 'GABC',
      asOfMs: 0,
    });
    mocks.sumOutstandingLiability.mockResolvedValue(3n);
    mocks.sumInFlightBurnStroops.mockResolvedValue(0n);

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.samples[0]!.driftStroops).toBe(0n);
    expect(r.samples[0]!.pendingBurnStroops).toBe(0n);
    expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();
  });

  it('skips the asset (does not flip state) when the burn read fails', async () => {
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'GBPLOOP', issuer: 'GABC' }]);
    mocks.getLoopAssetCirculation.mockResolvedValue({
      stroops: 500_000n,
      assetCode: 'GBPLOOP',
      issuer: 'GABC',
      asOfMs: 0,
    });
    mocks.sumInFlightBurnStroops.mockRejectedValue(new Error('db down'));

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.checked).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.samples).toHaveLength(0);
    expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();
  });
});

describe('ADR 031 — interest-mint-aware drift equation', () => {
  function configureGbp(args: { onChain: bigint; liabilityMinor: bigint }): void {
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'GBPLOOP', issuer: 'GABC' }]);
    mocks.getLoopAssetCirculation.mockResolvedValue({
      stroops: args.onChain,
      assetCode: 'GBPLOOP',
      issuer: 'GABC',
      asOfMs: 0,
    });
    mocks.sumOutstandingLiability.mockResolvedValue(args.liabilityMinor);
  }

  it('state 1 (queued): mirror credited, mint pending → drift-neutral', async () => {
    // Equilibrium 500_000 on-chain / 5 minor. The interest txn then
    // credits the mirror +1 minor (→ 6) and queues a 100_000-stroop
    // mint that hasn't touched the chain yet. The in-flight term
    // must cancel the mirror lead exactly.
    configureGbp({ onChain: 500_000n, liabilityMinor: 6n });
    mocks.sumInFlightInterestMintStroops.mockResolvedValue(100_000n);

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.samples[0]!.driftStroops).toBe(0n);
    expect(r.samples[0]!.pendingInterestMintStroops).toBe(100_000n);
    expect(r.samples[0]!.over).toBe(false);
    expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();
    expect(mocks.sumInFlightInterestMintStroops).toHaveBeenCalledWith({
      assetCode: 'GBPLOOP',
      assetIssuer: 'GABC',
    });
  });

  it('state 2 (submitted, not yet confirmed): identical treatment — still drift-neutral', async () => {
    // A submitted-but-unconfirmed row stays in the in-flight sum (the
    // worker has not marked it confirmed; Horizon may or may not have
    // sealed it — same fail-closed posture as in-flight burns).
    configureGbp({ onChain: 500_000n, liabilityMinor: 6n });
    mocks.sumInFlightInterestMintStroops.mockResolvedValue(100_000n);

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.samples[0]!.driftStroops).toBe(0n);
    expect(r.samples[0]!.over).toBe(false);
  });

  it('state 3 (confirmed): circulation grew, in-flight term zero → still drift-neutral', async () => {
    // The issuer payment landed: on-chain grew by the mint and the
    // row left the in-flight sum. Both sides now carry the credit.
    configureGbp({ onChain: 600_000n, liabilityMinor: 6n });
    mocks.sumInFlightInterestMintStroops.mockResolvedValue(0n);

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.samples[0]!.driftStroops).toBe(0n);
    expect(r.samples[0]!.over).toBe(false);
    expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();
  });

  it('a mirror credit with NO queued mint still reads as drift (the alert the term must not mask)', async () => {
    // Defensive: if a future writer credits interest off-chain only
    // (the legacy bug ADR 036 §3 warns about), nothing is in flight
    // and the watcher must page.
    configureGbp({ onChain: 500_000n, liabilityMinor: 6n });
    mocks.sumInFlightInterestMintStroops.mockResolvedValue(0n);

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.samples[0]!.driftStroops).toBe(-100_000n);
    expect(r.samples[0]!.over).toBe(true);
    expect(mocks.notifyAssetDrift).toHaveBeenCalledOnce();
  });

  it('burns and mints in flight together: terms apply with opposite signs', async () => {
    // 500_000 on-chain. A redemption debited the mirror by 2 minor
    // (burn of 200_000 queued) AND a mint of 100_000 is queued with
    // its +1 minor credit → liability 5 − 2 + 1 = 4 minor.
    configureGbp({ onChain: 500_000n, liabilityMinor: 4n });
    mocks.sumInFlightBurnStroops.mockResolvedValue(200_000n);
    mocks.sumInFlightInterestMintStroops.mockResolvedValue(100_000n);

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.samples[0]!.driftStroops).toBe(0n);
    expect(r.samples[0]!.over).toBe(false);
  });

  it('skips the asset (does not flip state) when the interest-mint read fails', async () => {
    configureGbp({ onChain: 500_000n, liabilityMinor: 5n });
    mocks.sumInFlightInterestMintStroops.mockRejectedValue(new Error('db down'));

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.checked).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.samples).toHaveLength(0);
    expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();
  });
});
