import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

interface StoredDriftState {
  state: 'ok' | 'over';
  failedRowsState: 'none' | 'present';
  lastDriftStroops: bigint;
  lastThresholdStroops: bigint;
  failedBurnStroops: bigint;
  failedInterestMintStroops: bigint;
  lastCheckedAt: Date;
  lastPagedState: 'ok' | 'over' | null;
  lastPagedFailedRowsState: 'none' | 'present' | null;
  pageAttemptAt: Date | null;
}

interface DuePages {
  drift?: 'over' | 'recovered';
  failedRows?: 'present' | 'cleared';
}

const { mocks, driftStore, advisoryState } = vi.hoisted(() => {
  const driftStore = new Map<string, StoredDriftState>();
  const advisoryState = { acquired: true };
  return {
    driftStore,
    advisoryState,
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
      notifyAssetDrift: vi.fn<(args: unknown) => Promise<boolean>>(async () => true),
      notifyAssetDriftRecovered: vi.fn<(args: unknown) => Promise<boolean>>(async () => true),
      notifyDriftFailedRows: vi.fn<(args: unknown) => Promise<boolean>>(async () => true),
      notifyDriftFailedRowsCleared: vi.fn<(args: unknown) => Promise<boolean>>(async () => true),
      // ADR 036: un-confirmed redemption burns bucketed by state.
      // Default: nothing in flight, nothing failed.
      sumBurnStroopsByState: vi.fn<
        (args: {
          assetCode: string;
          assetIssuer: string;
        }) => Promise<{ pendingSubmittedStroops: bigint; failedStroops: bigint }>
      >(async () => ({ pendingSubmittedStroops: 0n, failedStroops: 0n })),
      // ADR 031: un-confirmed nightly interest mints bucketed by state.
      sumInterestMintStroopsByState: vi.fn<
        (args: {
          assetCode: string;
          assetIssuer: string;
        }) => Promise<{ pendingSubmittedStroops: bigint; failedStroops: bigint }>
      >(async () => ({ pendingSubmittedStroops: 0n, failedStroops: 0n })),
      // Hardening A3: persisted drift state. The default fake emulates
      // the real repo against the in-memory `driftStore` map — same
      // contract (staleness fence, lease claim, due pages via the
      // REAL computeDuePages, delivery marking) so the watcher's
      // orchestration is exercised for real; the actual SQL/locking
      // is pinned by the integration suite. Per-test overrides
      // simulate insert races / DB failures.
      applyDriftState: vi.fn(
        async (
          args: {
            assetCode: string;
          } & Omit<
            StoredDriftState,
            'lastPagedState' | 'lastPagedFailedRowsState' | 'pageAttemptAt'
          >,
        ): Promise<{
          prior: {
            state: 'unknown' | 'ok' | 'over';
            failedRowsState: 'unknown' | 'none' | 'present';
          };
          raced: boolean;
          duePages: DuePages;
        }> => {
          const prior = driftStore.get(args.assetCode);
          if (prior !== undefined && prior.lastCheckedAt > args.lastCheckedAt) {
            return {
              prior: { state: prior.state, failedRowsState: prior.failedRowsState },
              raced: true,
              duePages: {},
            };
          }
          const due = realComputeDuePages({
            state: args.state,
            failedRowsState: args.failedRowsState,
            lastPagedState: prior?.lastPagedState ?? null,
            lastPagedFailedRowsState: prior?.lastPagedFailedRowsState ?? null,
          });
          const hasDue = due.drift !== undefined || due.failedRows !== undefined;
          const leaseFresh =
            prior !== undefined &&
            prior.pageAttemptAt !== null &&
            Date.now() - prior.pageAttemptAt.getTime() < 4 * 60_000;
          const claim = hasDue && !leaseFresh;
          driftStore.set(args.assetCode, {
            state: args.state,
            failedRowsState: args.failedRowsState,
            lastDriftStroops: args.lastDriftStroops,
            lastThresholdStroops: args.lastThresholdStroops,
            failedBurnStroops: args.failedBurnStroops,
            failedInterestMintStroops: args.failedInterestMintStroops,
            lastCheckedAt: args.lastCheckedAt,
            lastPagedState: prior?.lastPagedState ?? null,
            lastPagedFailedRowsState: prior?.lastPagedFailedRowsState ?? null,
            pageAttemptAt: claim ? new Date() : (prior?.pageAttemptAt ?? null),
          });
          return {
            prior:
              prior === undefined
                ? { state: 'unknown', failedRowsState: 'unknown' }
                : { state: prior.state, failedRowsState: prior.failedRowsState },
            raced: false,
            duePages: claim ? due : {},
          };
        },
      ),
      markPagesDelivered: vi.fn(
        async (args: {
          assetCode: string;
          drift?: 'ok' | 'over';
          failedRows?: 'none' | 'present';
        }): Promise<void> => {
          const row = driftStore.get(args.assetCode);
          if (row === undefined) return;
          driftStore.set(args.assetCode, {
            ...row,
            lastPagedState: args.drift ?? row.lastPagedState,
            lastPagedFailedRowsState: args.failedRows ?? row.lastPagedFailedRowsState,
            pageAttemptAt: null,
          });
        },
      ),
      releasePageLease: vi.fn(async (assetCode: string): Promise<void> => {
        const row = driftStore.get(assetCode);
        if (row === undefined) return;
        driftStore.set(assetCode, { ...row, pageAttemptAt: null });
      }),
      listPersistedDriftStates: vi.fn(
        async (): Promise<Map<string, StoredDriftState>> => new Map(driftStore),
      ),
    },
  };
});

vi.mock('../../credits/payout-asset.js', () => ({
  configuredLoopPayableAssets: () => mocks.configuredLoopPayableAssets(),
}));

vi.mock('../../credits/liabilities.js', () => ({
  sumOutstandingLiability: (c: string) => mocks.sumOutstandingLiability(c),
}));

vi.mock('../../credits/pending-payouts.js', () => ({
  sumBurnStroopsByState: (args: { assetCode: string; assetIssuer: string }) =>
    mocks.sumBurnStroopsByState(args),
  sumInterestMintStroopsByState: (args: { assetCode: string; assetIssuer: string }) =>
    mocks.sumInterestMintStroopsByState(args),
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

vi.mock('../asset-drift-state-repo.js', async (importOriginal) => {
  const real = (await importOriginal()) as {
    computeDuePages: typeof realComputeDuePages;
    PAGE_ATTEMPT_LEASE_MS: number;
  };
  return {
    computeDuePages: real.computeDuePages,
    PAGE_ATTEMPT_LEASE_MS: real.PAGE_ATTEMPT_LEASE_MS,
    applyDriftState: (args: Parameters<typeof mocks.applyDriftState>[0]) =>
      mocks.applyDriftState(args),
    markPagesDelivered: (args: Parameters<typeof mocks.markPagesDelivered>[0]) =>
      mocks.markPagesDelivered(args),
    releasePageLease: (assetCode: string) => mocks.releasePageLease(assetCode),
    listPersistedDriftStates: () => mocks.listPersistedDriftStates(),
  };
});

// The emulation inside vi.hoisted can't close over the module import;
// thread the real pure function in via a mutable slot set after import.
import { computeDuePages as realComputeDuePages } from '../asset-drift-state-repo.js';

vi.mock('../../discord.js', () => ({
  notifyAssetDrift: (args: unknown) => mocks.notifyAssetDrift(args),
  notifyAssetDriftRecovered: (args: unknown) => mocks.notifyAssetDriftRecovered(args),
  notifyDriftFailedRows: (args: unknown) => mocks.notifyDriftFailedRows(args),
  notifyDriftFailedRowsCleared: (args: unknown) => mocks.notifyDriftFailedRowsCleared(args),
}));

// S4-8: withAdvisoryLock mock — same shape as interest-mint.test.ts.
// Default acquires the lock and runs `fn`; `advisoryState.acquired =
// false` simulates another machine holding it fleet-wide.
vi.mock('../../db/client.js', () => ({
  withAdvisoryLock: async <T>(
    _lockKey: bigint,
    fn: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> => {
    if (!advisoryState.acquired) return { ran: false };
    return { ran: true, value: await fn() };
  },
}));

import {
  runAssetDriftTick,
  getAssetDriftState,
  __resetAssetDriftWatcherForTests,
} from '../asset-drift-watcher.js';

beforeEach(() => {
  __resetAssetDriftWatcherForTests();
  driftStore.clear();
  advisoryState.acquired = true;
  mocks.configuredLoopPayableAssets.mockReset();
  mocks.sumOutstandingLiability.mockReset();
  mocks.getLoopAssetCirculation.mockReset();
  mocks.resolveInterestPoolAccount.mockReset();
  mocks.getAssetBalance.mockReset();
  mocks.notifyAssetDrift.mockReset();
  mocks.notifyAssetDriftRecovered.mockReset();
  mocks.notifyDriftFailedRows.mockReset();
  mocks.notifyDriftFailedRowsCleared.mockReset();
  mocks.applyDriftState.mockClear();
  mocks.markPagesDelivered.mockClear();
  mocks.releasePageLease.mockClear();
  mocks.listPersistedDriftStates.mockClear();
  // Default: pool not configured (matches a fresh deployment).
  mocks.resolveInterestPoolAccount.mockReturnValue(null);
  mocks.getAssetBalance.mockResolvedValue(null);
  // Default: no burns / mints in flight and nothing failed.
  mocks.sumBurnStroopsByState.mockReset();
  mocks.sumBurnStroopsByState.mockResolvedValue({
    pendingSubmittedStroops: 0n,
    failedStroops: 0n,
  });
  mocks.sumInterestMintStroopsByState.mockReset();
  mocks.sumInterestMintStroopsByState.mockResolvedValue({
    pendingSubmittedStroops: 0n,
    failedStroops: 0n,
  });
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

  it('dedupes repeat ticks while still over-threshold — only the first tick fires', async () => {
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
    // notifyAssetDrift because the persisted state is still 'over'.
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

  it('S4-8: skips the tick when another machine holds the asset-drift-watcher lock', async () => {
    advisoryState.acquired = false;
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'USDLOOP', issuer: 'GABC' }]);

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r).toEqual({ checked: 0, skipped: 0, samples: [], skippedLocked: true });
    // Zero Horizon/ledger reads and zero Discord pages — the whole
    // per-asset pass never ran.
    expect(mocks.getLoopAssetCirculation).not.toHaveBeenCalled();
    expect(mocks.sumOutstandingLiability).not.toHaveBeenCalled();
    expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();
  });

  it('releases the lock + returns empty when the tick body exceeds the lease deadline', async () => {
    // A hung Horizon: the circulation read never resolves. The lease
    // must fire so the fleet-wide lock is released and the drift
    // check is not stalled on every machine.
    vi.useFakeTimers();
    try {
      mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'USDLOOP', issuer: 'GABC' }]);
      let releaseHang: () => void = () => {};
      mocks.getLoopAssetCirculation.mockReturnValue(
        new Promise((resolve) => {
          releaseHang = () =>
            resolve({ stroops: 0n, assetCode: 'USDLOOP', issuer: 'GABC', asOfMs: 0 });
        }),
      );
      const tickPromise = runAssetDriftTick({ thresholdStroops: 1_000n });
      // Advance past the 240s lease — the Promise.race timeout wins.
      await vi.advanceTimersByTimeAsync(240_001);
      const r = await tickPromise;
      expect(r).toEqual({ checked: 0, skipped: 0, samples: [], skippedLocked: false });
      expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();
      releaseHang();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getAssetDriftState', () => {
  it('emits one entry per configured asset, defaulting to unknown before any tick', async () => {
    mocks.configuredLoopPayableAssets.mockReturnValue([
      { code: 'USDLOOP', issuer: 'GUSD' },
      { code: 'GBPLOOP', issuer: 'GGBP' },
    ]);
    const s = await getAssetDriftState();
    expect(s.lastTickMs).toBeNull();
    expect(s.running).toBe(false);
    expect(s.perAsset).toHaveLength(2);
    for (const a of s.perAsset) {
      expect(a.state).toBe('unknown');
      expect(a.lastDriftStroops).toBeNull();
      expect(a.lastCheckedMs).toBeNull();
      expect(a.failedRowsState).toBe('unknown');
      expect(a.failedBurnStroops).toBeNull();
      expect(a.failedInterestMintStroops).toBeNull();
    }
  });

  it('reflects the persisted values per asset after a run', async () => {
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'USDLOOP', issuer: 'GUSD' }]);
    mocks.getLoopAssetCirculation.mockResolvedValue({
      stroops: 10_000_000n,
      assetCode: 'USDLOOP',
      issuer: 'GUSD',
      asOfMs: 0,
    });
    mocks.sumOutstandingLiability.mockResolvedValue(0n);
    await runAssetDriftTick({ thresholdStroops: 1_000n });

    const s = await getAssetDriftState();
    expect(s.lastTickMs).not.toBeNull();
    expect(s.perAsset[0]!.state).toBe('over');
    expect(s.perAsset[0]!.lastDriftStroops).toBe(10_000_000n);
    expect(s.perAsset[0]!.lastThresholdStroops).toBe(1_000n);
    expect(s.perAsset[0]!.lastCheckedMs).not.toBeNull();
    expect(s.perAsset[0]!.failedRowsState).toBe('none');
    expect(s.perAsset[0]!.failedBurnStroops).toBe(0n);
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
    const before = (await getAssetDriftState()).perAsset[0]!;
    expect(before.state).toBe('ok');

    // Tick 2: Horizon throws — snapshot must NOT be flipped.
    mocks.getLoopAssetCirculation.mockRejectedValueOnce(new Error('Horizon 503'));
    await runAssetDriftTick({ thresholdStroops: 1_000n });
    const after = (await getAssetDriftState()).perAsset[0]!;
    expect(after.state).toBe('ok');
    expect(after.lastDriftStroops).toBe(before.lastDriftStroops);
  });
});

describe('ADR 036 — burn-aware drift equation', () => {
  it('subtracts un-confirmed burn stroops so a mid-redemption tick reads as zero drift', async () => {
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
    mocks.sumBurnStroopsByState.mockResolvedValue({
      pendingSubmittedStroops: 200_000n,
      failedStroops: 0n,
    });

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.checked).toBe(1);
    // 500_000 − 0 (pool) − 200_000 (un-confirmed burn) − 300_000 = 0.
    expect(r.samples[0]!.driftStroops).toBe(0n);
    expect(r.samples[0]!.pendingBurnStroops).toBe(200_000n);
    expect(r.samples[0]!.over).toBe(false);
    expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();
    // The reader was asked about the right asset.
    expect(mocks.sumBurnStroopsByState).toHaveBeenCalledWith({
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
    mocks.sumBurnStroopsByState.mockRejectedValue(new Error('db down'));

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
    // mint that hasn't touched the chain yet. The un-confirmed term
    // must cancel the mirror lead exactly.
    configureGbp({ onChain: 500_000n, liabilityMinor: 6n });
    mocks.sumInterestMintStroopsByState.mockResolvedValue({
      pendingSubmittedStroops: 100_000n,
      failedStroops: 0n,
    });

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.samples[0]!.driftStroops).toBe(0n);
    expect(r.samples[0]!.pendingInterestMintStroops).toBe(100_000n);
    expect(r.samples[0]!.over).toBe(false);
    expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();
    expect(mocks.sumInterestMintStroopsByState).toHaveBeenCalledWith({
      assetCode: 'GBPLOOP',
      assetIssuer: 'GABC',
    });
  });

  it('state 2 (confirmed): circulation grew, un-confirmed term zero → still drift-neutral', async () => {
    // The issuer payment landed: on-chain grew by the mint and the
    // row left the un-confirmed sum. Both sides now carry the credit.
    configureGbp({ onChain: 600_000n, liabilityMinor: 6n });

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
    mocks.sumBurnStroopsByState.mockResolvedValue({
      pendingSubmittedStroops: 200_000n,
      failedStroops: 0n,
    });
    mocks.sumInterestMintStroopsByState.mockResolvedValue({
      pendingSubmittedStroops: 100_000n,
      failedStroops: 0n,
    });

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.samples[0]!.driftStroops).toBe(0n);
    expect(r.samples[0]!.over).toBe(false);
  });

  it('skips the asset (does not flip state) when the interest-mint read fails', async () => {
    configureGbp({ onChain: 500_000n, liabilityMinor: 5n });
    mocks.sumInterestMintStroopsByState.mockRejectedValue(new Error('db down'));

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.checked).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.samples).toHaveLength(0);
    expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();
  });
});

describe('hardening A2 — failed money-movement dimension', () => {
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

  it('a terminally-failed interest mint stays drift-neutral but pages the failed-rows alert', async () => {
    // The exact blind spot this dimension exists for: mirror credited
    // +1 minor, the issuer mint terminally failed. The failed row is
    // still counted into the equation (drift = 0 — nothing pages on
    // the drift dimension), so without the second dimension nothing
    // would ever point at it again after the one-shot payout-failed
    // page.
    configureGbp({ onChain: 500_000n, liabilityMinor: 6n });
    mocks.sumInterestMintStroopsByState.mockResolvedValue({
      pendingSubmittedStroops: 0n,
      failedStroops: 100_000n,
    });

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    const sample = r.samples[0]!;
    expect(sample.driftStroops).toBe(0n);
    expect(sample.over).toBe(false);
    expect(sample.failedInterestMintStroops).toBe(100_000n);
    expect(sample.nextFailedRowsState).toBe('present');
    expect(sample.notified).toBe(true);
    expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();
    expect(mocks.notifyDriftFailedRows).toHaveBeenCalledOnce();
    expect(mocks.notifyDriftFailedRows).toHaveBeenCalledWith({
      assetCode: 'GBPLOOP',
      failedBurnStroops: '0',
      failedInterestMintStroops: '100000',
    });
  });

  it('a terminally-failed burn pages the failed-rows alert too', async () => {
    // Failed burn: mirror debited, tokens parked at the deposit
    // account, issuer-return failed. Equation stays neutral (the
    // tokens genuinely count toward circulation), dimension pages.
    configureGbp({ onChain: 500_000n, liabilityMinor: 3n });
    mocks.sumBurnStroopsByState.mockResolvedValue({
      pendingSubmittedStroops: 0n,
      failedStroops: 200_000n,
    });

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.samples[0]!.driftStroops).toBe(0n);
    expect(r.samples[0]!.failedBurnStroops).toBe(200_000n);
    expect(mocks.notifyDriftFailedRows).toHaveBeenCalledOnce();
  });

  it('dedupes the failed-rows page while the rows persist', async () => {
    configureGbp({ onChain: 500_000n, liabilityMinor: 6n });
    mocks.sumInterestMintStroopsByState.mockResolvedValue({
      pendingSubmittedStroops: 0n,
      failedStroops: 100_000n,
    });

    await runAssetDriftTick({ thresholdStroops: 1_000n });
    await runAssetDriftTick({ thresholdStroops: 1_000n });
    await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(mocks.notifyDriftFailedRows).toHaveBeenCalledOnce();
    expect(mocks.notifyDriftFailedRowsCleared).not.toHaveBeenCalled();
  });

  it('pages the cleared notification when the failed rows resolve', async () => {
    // Tick 1: failed mint present.
    configureGbp({ onChain: 500_000n, liabilityMinor: 6n });
    mocks.sumInterestMintStroopsByState.mockResolvedValueOnce({
      pendingSubmittedStroops: 0n,
      failedStroops: 100_000n,
    });
    await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(mocks.notifyDriftFailedRows).toHaveBeenCalledOnce();

    // Tick 2: operator retried; the mint confirmed (circulation grew,
    // failed bucket empty).
    configureGbp({ onChain: 600_000n, liabilityMinor: 6n });
    mocks.sumInterestMintStroopsByState.mockResolvedValueOnce({
      pendingSubmittedStroops: 0n,
      failedStroops: 0n,
    });
    await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(mocks.notifyDriftFailedRowsCleared).toHaveBeenCalledOnce();
    expect(mocks.notifyDriftFailedRowsCleared).toHaveBeenCalledWith({ assetCode: 'GBPLOOP' });
  });

  it('failed-rows and drift dimensions page independently on the same tick', async () => {
    // Mirror credited +2 minor but only 1 minor of failed mint is
    // queued — the equation still shows -100_000 drift AND the failed
    // row exists. Both pages fire.
    configureGbp({ onChain: 500_000n, liabilityMinor: 7n });
    mocks.sumInterestMintStroopsByState.mockResolvedValue({
      pendingSubmittedStroops: 0n,
      failedStroops: 100_000n,
    });

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.samples[0]!.driftStroops).toBe(-100_000n);
    expect(r.samples[0]!.over).toBe(true);
    expect(mocks.notifyAssetDrift).toHaveBeenCalledOnce();
    expect(mocks.notifyDriftFailedRows).toHaveBeenCalledOnce();
  });

  it('suppresses all notifications when the state persist raced a concurrent first-insert', async () => {
    configureGbp({ onChain: 10_000_000n, liabilityMinor: 0n });
    mocks.applyDriftState.mockResolvedValueOnce({
      prior: { state: 'unknown', failedRowsState: 'unknown' },
      raced: true,
      duePages: {},
    });

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.checked).toBe(1);
    expect(r.samples[0]!.notified).toBe(false);
    expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();
  });

  it('suppresses notifications (but still checks) when the state persist throws', async () => {
    configureGbp({ onChain: 10_000_000n, liabilityMinor: 0n });
    mocks.applyDriftState.mockRejectedValueOnce(new Error('db down'));

    const r = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r.checked).toBe(1);
    expect(r.samples[0]!.notified).toBe(false);
    expect(mocks.notifyAssetDrift).not.toHaveBeenCalled();

    // Next tick persists fine and the condition still holds → pages.
    const r2 = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r2.samples[0]!.notified).toBe(true);
    expect(mocks.notifyAssetDrift).toHaveBeenCalledOnce();
  });
});

describe('hardening A2 — at-least-once page delivery', () => {
  function configureOver(): void {
    mocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'GBPLOOP', issuer: 'GABC' }]);
    mocks.getLoopAssetCirculation.mockResolvedValue({
      stroops: 10_000_000n,
      assetCode: 'GBPLOOP',
      issuer: 'GABC',
      asOfMs: 0,
    });
    mocks.sumOutstandingLiability.mockResolvedValue(0n);
  }

  it('re-attempts an undelivered page on the next tick instead of losing it forever', async () => {
    // The P0 the delivery tracking exists for: the state commit
    // succeeds but the Discord send fails (429 / outage / timeout).
    // The old design marked the transition consumed at commit time —
    // the incident would never page again.
    configureOver();
    mocks.notifyAssetDrift.mockResolvedValueOnce(false);

    const r1 = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r1.samples[0]!.notified).toBe(false);
    expect(mocks.notifyAssetDrift).toHaveBeenCalledOnce();
    // The failed send frees the lease so the next tick retries
    // immediately.
    expect(mocks.releasePageLease).toHaveBeenCalledWith('GBPLOOP');
    expect(mocks.markPagesDelivered).not.toHaveBeenCalled();

    const r2 = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r2.samples[0]!.notified).toBe(true);
    expect(mocks.notifyAssetDrift).toHaveBeenCalledTimes(2);
    expect(mocks.markPagesDelivered).toHaveBeenCalledWith({ assetCode: 'GBPLOOP', drift: 'over' });
  });

  it('does not re-page a delivered incident across a process restart', async () => {
    // The old in-memory watcher re-paged after every deploy. The
    // persisted last_paged_* survives the restart, so an ongoing
    // incident stays a single open page.
    configureOver();
    await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(mocks.notifyAssetDrift).toHaveBeenCalledOnce();

    __resetAssetDriftWatcherForTests(); // simulate restart (driftStore = the DB, survives)
    await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(mocks.notifyAssetDrift).toHaveBeenCalledOnce();
  });

  it('elides an over→ok blip whose open page was never delivered', async () => {
    // Ops never saw the incident open, so no "recovered" page either
    // — last_paged never moved to 'over'. Same elision the old
    // watcher applied to flips between ticks.
    configureOver();
    mocks.notifyAssetDrift.mockResolvedValueOnce(false);
    await runAssetDriftTick({ thresholdStroops: 1_000n });

    // Recovered before the page was ever delivered.
    mocks.getLoopAssetCirculation.mockResolvedValue({
      stroops: 0n,
      assetCode: 'GBPLOOP',
      issuer: 'GABC',
      asOfMs: 0,
    });
    const r2 = await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(r2.samples[0]!.notified).toBe(false);
    expect(mocks.notifyAssetDriftRecovered).not.toHaveBeenCalled();
    // And the stale 'over' page must not fire later either.
    await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(mocks.notifyAssetDrift).toHaveBeenCalledOnce(); // only the failed attempt
  });

  it('delivers each dimension independently — one failed send does not lose the other', async () => {
    // Both dimensions transition on the same tick; the drift send
    // fails, the failed-rows send succeeds. The delivered one is
    // marked; the undelivered one re-attempts next tick.
    configureOver();
    mocks.sumInterestMintStroopsByState.mockResolvedValue({
      pendingSubmittedStroops: 0n,
      failedStroops: 100_000n,
    });
    mocks.notifyAssetDrift.mockResolvedValueOnce(false);

    await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(mocks.markPagesDelivered).toHaveBeenCalledWith({
      assetCode: 'GBPLOOP',
      failedRows: 'present',
    });

    await runAssetDriftTick({ thresholdStroops: 1_000n });
    expect(mocks.notifyAssetDrift).toHaveBeenCalledTimes(2);
    // The already-delivered failed-rows page is NOT re-sent.
    expect(mocks.notifyDriftFailedRows).toHaveBeenCalledOnce();
  });
});
