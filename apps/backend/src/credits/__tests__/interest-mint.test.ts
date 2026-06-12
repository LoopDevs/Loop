import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR 031 / ADR 036 Phase D — nightly on-chain interest mints.
 *
 * Covers, per the Phase-D test contract:
 *   - floor/dust math (bigint): 7-decimal flooring, sub-stroop dust,
 *     sub-minor carry accumulation + conservation
 *   - period idempotency: the same UTC day re-run produces exactly
 *     one credit row + one payout row (snapshot fence)
 *   - downtime self-heal: a tick after a missed midnight processes
 *     the current period from the stale cursor
 *   - snapshot persistence: every eligible holder gets one audit row
 *     per night, carry chained across nights
 *   - cursor discipline: fast-path no-op when the period is done;
 *     cursor NOT advanced when any user errored
 */

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const ISSUER = 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WALLET = 'GWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// ── table-routed chainable db mock ──────────────────────────────────
const { state, dbMock } = vi.hoisted(() => {
  interface SnapshotRowLike {
    periodCursor: string;
    carryAfterStroops: bigint;
  }
  const state = {
    /** value of the watcher_cursors row (null = absent). */
    cursorRow: null as string | null,
    /** rows the eligible-users select resolves to. */
    eligibleUsers: [] as Array<{ id: string; walletAddress: string | null }>,
    /** FIFO results for the per-user latest-snapshot select. */
    latestSnapshotQueue: [] as Array<SnapshotRowLike | undefined>,
    /** captured inserts, by table. */
    snapshotInserts: [] as Array<Record<string, unknown>>,
    creditInserts: [] as Array<Record<string, unknown>>,
    creditUpserts: [] as Array<Record<string, unknown>>,
    payoutInserts: [] as Array<Record<string, unknown>>,
    /** keys already snapshotted — drives the unique-violation fence. */
    snapshotKeys: new Set<string>(),
    /** set by the test file after imports resolve. */
    tableNameOf: (_t: unknown): string => '',
    reset(): void {
      state.cursorRow = null;
      state.eligibleUsers = [];
      state.latestSnapshotQueue = [];
      state.snapshotInserts = [];
      state.creditInserts = [];
      state.creditUpserts = [];
      state.payoutInserts = [];
      state.snapshotKeys = new Set<string>();
    },
  };

  function selectResult(table: string): unknown[] {
    if (table === 'watcher_cursors') {
      return state.cursorRow === null ? [] : [{ cursor: state.cursorRow }];
    }
    if (table === 'users') return state.eligibleUsers;
    if (table === 'interest_mint_snapshots') {
      const next = state.latestSnapshotQueue.shift();
      return next === undefined ? [] : [next];
    }
    throw new Error(`unexpected select on table ${table}`);
  }

  function handleInsert(table: string, v: Record<string, unknown>): void {
    if (table === 'interest_mint_snapshots') {
      const key = `${String(v['userId'])}:${String(v['assetCode'])}:${String(v['periodCursor'])}`;
      if (state.snapshotKeys.has(key)) {
        throw new Error(
          'duplicate key value violates unique constraint "interest_mint_snapshots_user_asset_period_unique"',
        );
      }
      state.snapshotKeys.add(key);
      state.snapshotInserts.push(v);
      return;
    }
    if (table === 'credit_transactions') {
      state.creditInserts.push(v);
      return;
    }
    if (table === 'pending_payouts') {
      state.payoutInserts.push(v);
      return;
    }
    throw new Error(`unexpected plain insert on table ${table}`);
  }

  function handleUpsert(table: string, v: Record<string, unknown>): void {
    if (table === 'user_credits') {
      state.creditUpserts.push(v);
      return;
    }
    if (table === 'watcher_cursors') {
      state.cursorRow = String(v['cursor']);
      return;
    }
    throw new Error(`unexpected upsert on table ${table}`);
  }

  function makeSelect(): Record<string, unknown> {
    let table = '';
    const chain: Record<string, unknown> = {};
    chain['from'] = (t: unknown) => {
      table = state.tableNameOf(t);
      return chain;
    };
    chain['where'] = () => ({
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => selectResult(table))
          .then(resolve, reject),
      orderBy: () => ({
        limit: async () => selectResult(table),
      }),
    });
    return chain;
  }

  function makeInsert(t: unknown): Record<string, unknown> {
    const table = state.tableNameOf(t);
    return {
      values: (v: Record<string, unknown>) => ({
        // Plain insert path: awaited directly.
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve()
            .then(() => handleInsert(table, v))
            .then(resolve, reject),
        // Upsert path: `.onConflictDoUpdate(...)` is awaited instead.
        onConflictDoUpdate: async () => handleUpsert(table, v),
      }),
    };
  }

  const dbMock = {
    select: () => makeSelect(),
    insert: (t: unknown) => makeInsert(t),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      // Simulated rollback: restore capture lengths if the callback
      // throws, mirroring a real aborted transaction.
      const marks = {
        snapshot: state.snapshotInserts.length,
        credit: state.creditInserts.length,
        upsert: state.creditUpserts.length,
        payout: state.payoutInserts.length,
      };
      try {
        return await cb(dbMock);
      } catch (err) {
        state.snapshotInserts.length = marks.snapshot;
        state.creditInserts.length = marks.credit;
        state.creditUpserts.length = marks.upsert;
        state.payoutInserts.length = marks.payout;
        throw err;
      }
    },
  };

  return { state, dbMock };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));

// Horizon trustline reads — per-address balances.
const { horizonState } = vi.hoisted(() => ({
  horizonState: {
    balances: new Map<string, bigint>(),
    throwFor: new Set<string>(),
  },
}));
vi.mock('../../payments/horizon-trustlines.js', () => ({
  getAccountTrustlines: async (account: string) => {
    if (horizonState.throwFor.has(account)) {
      throw new Error('horizon unavailable');
    }
    const balance = horizonState.balances.get(account);
    return {
      account,
      accountExists: balance !== undefined,
      trustlines:
        balance !== undefined
          ? new Map([
              [
                `GBPLOOP::${ISSUER}`,
                { code: 'GBPLOOP', issuer: ISSUER, limitStroops: 0n, balanceStroops: balance },
              ],
            ])
          : new Map(),
      asOfMs: 0,
    };
  },
}));

const { configMocks } = vi.hoisted(() => ({
  configMocks: {
    configuredLoopPayableAssets: vi.fn<() => ReadonlyArray<{ code: string; issuer: string }>>(
      () => [],
    ),
    resolveIssuerSigners: vi.fn<() => ReadonlyMap<string, { secret: string; account: string }>>(
      () => new Map(),
    ),
  },
}));
vi.mock('../payout-asset.js', () => ({
  configuredLoopPayableAssets: () => configMocks.configuredLoopPayableAssets(),
}));
vi.mock('../../payments/issuer-signers.js', () => ({
  resolveIssuerSigners: () => configMocks.resolveIssuerSigners(),
}));

import { getTableName, type Table } from 'drizzle-orm';
import {
  computeNightlyAccrualStroops,
  splitPayable,
  utcPeriodCursor,
  runInterestMintTick,
} from '../interest-mint.js';

state.tableNameOf = (t: unknown) => getTableName(t as Table);

const NOW = new Date('2026-06-12T03:00:00Z');

function configureGbp(): void {
  configMocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'GBPLOOP', issuer: ISSUER }]);
  configMocks.resolveIssuerSigners.mockReturnValue(
    new Map([['GBPLOOP', { secret: 'SSECRET', account: ISSUER }]]),
  );
}

beforeEach(() => {
  state.reset();
  horizonState.balances = new Map();
  horizonState.throwFor = new Set();
  configMocks.configuredLoopPayableAssets.mockReset();
  configMocks.resolveIssuerSigners.mockReset();
  configMocks.configuredLoopPayableAssets.mockReturnValue([]);
  configMocks.resolveIssuerSigners.mockReturnValue(new Map());
});

describe('utcPeriodCursor', () => {
  it('formats the UTC calendar date', () => {
    expect(utcPeriodCursor(new Date('2026-06-12T03:00:00Z'))).toBe('2026-06-12');
    // 23:59 UTC on the 11th is still the 11th regardless of local tz.
    expect(utcPeriodCursor(new Date('2026-06-11T23:59:59Z'))).toBe('2026-06-11');
  });
});

describe('computeNightlyAccrualStroops — floor/dust math (bigint)', () => {
  it('floors toward zero at 7 decimals', () => {
    // 500 GBPLOOP at 3.00% APY: 5e9 × 300 / 3_650_000 = 410958.904… → 410958
    expect(computeNightlyAccrualStroops(5_000_000_000n, 300)).toBe(410_958n);
  });

  it('sub-stroop dust floors to zero', () => {
    // 100 stroops at 3% → 100×300/3_650_000 = 0.008… → 0
    expect(computeNightlyAccrualStroops(100n, 300)).toBe(0n);
  });

  it('zero / negative balance and zero / negative APY yield zero', () => {
    expect(computeNightlyAccrualStroops(0n, 300)).toBe(0n);
    expect(computeNightlyAccrualStroops(-5n, 300)).toBe(0n);
    expect(computeNightlyAccrualStroops(1_000_000n, 0)).toBe(0n);
    expect(computeNightlyAccrualStroops(1_000_000n, -100)).toBe(0n);
  });

  it('stays exact at large balances (no float in the path)', () => {
    // 10M GBPLOOP: 1e14 × 400 / 3_650_000 = 10_958_904_109.589… → floored
    expect(computeNightlyAccrualStroops(100_000_000_000_000n, 400)).toBe(10_958_904_109n);
  });
});

describe('splitPayable — sub-minor carry', () => {
  it('keeps everything in the carry below one minor unit', () => {
    const r = splitPayable(0n, 82n);
    expect(r.mintedMinor).toBe(0n);
    expect(r.carryAfterStroops).toBe(82n);
  });

  it('pays out whole minor units and carries the remainder', () => {
    const r = splitPayable(10_958n, 410_958n);
    expect(r.mintedMinor).toBe(4n); // 421_916 / 100_000
    expect(r.carryAfterStroops).toBe(21_916n);
  });

  it('conserves value: carry + accrual = minted×1e5 + carryAfter', () => {
    for (const [carry, accrual] of [
      [0n, 0n],
      [99_999n, 1n],
      [12_345n, 410_958n],
      [0n, 100_000n],
    ] as Array<[bigint, bigint]>) {
      const r = splitPayable(carry, accrual);
      expect(r.mintedMinor * 100_000n + r.carryAfterStroops).toBe(carry + accrual);
      expect(r.carryAfterStroops).toBeLessThan(100_000n);
    }
  });
});

describe('runInterestMintTick', () => {
  it('mints to an activated holder: snapshot + interest credit + mirror bump + interest_mint payout in one pass', async () => {
    configureGbp();
    state.eligibleUsers = [{ id: 'u-1', walletAddress: WALLET }];
    horizonState.balances.set(WALLET, 5_000_000_000n); // 500 GBPLOOP

    const r = await runInterestMintTick({ now: NOW, apyBps: 300 });
    expect(r.period).toBe('2026-06-12');
    expect(r.minted).toBe(1);
    expect(r.errors).toBe(0);
    expect(r.totalsMinor['GBP']).toBe(4n);

    // Snapshot row — the audit record + carry chain.
    expect(state.snapshotInserts).toHaveLength(1);
    expect(state.snapshotInserts[0]).toMatchObject({
      userId: 'u-1',
      assetCode: 'GBPLOOP',
      assetIssuer: ISSUER,
      currency: 'GBP',
      periodCursor: '2026-06-12',
      balanceStroops: 5_000_000_000n,
      accrualStroops: 410_958n,
      carryBeforeStroops: 0n,
      carryAfterStroops: 10_958n,
      mintedMinor: 4n,
    });
    // Mirror credit (ledger row + balance bump) in minor units.
    expect(state.creditInserts).toHaveLength(1);
    expect(state.creditInserts[0]).toMatchObject({
      userId: 'u-1',
      type: 'interest',
      amountMinor: 4n,
      currency: 'GBP',
      periodCursor: '2026-06-12',
    });
    expect(state.creditUpserts).toHaveLength(1);
    expect(state.creditUpserts[0]).toMatchObject({ balanceMinor: 4n, currency: 'GBP' });
    // On-chain half: queued issuer-signed mint, exactly minted×1e5.
    expect(state.payoutInserts).toHaveLength(1);
    expect(state.payoutInserts[0]).toMatchObject({
      kind: 'interest_mint',
      orderId: null,
      assetCode: 'GBPLOOP',
      assetIssuer: ISSUER,
      toAddress: WALLET,
      amountStroops: 400_000n,
    });
    // Period completed cleanly → cursor advanced.
    expect(state.cursorRow).toBe('2026-06-12');
  });

  it('accrues sub-minor nights into the carry only: snapshot persisted, no ledger or payout rows', async () => {
    configureGbp();
    state.eligibleUsers = [{ id: 'u-1', walletAddress: WALLET }];
    horizonState.balances.set(WALLET, 10_000_000n); // 1 GBPLOOP → 821 stroops/night

    const r = await runInterestMintTick({ now: NOW, apyBps: 300 });
    expect(r.minted).toBe(0);
    expect(r.accruedOnly).toBe(1);
    expect(state.snapshotInserts).toHaveLength(1);
    expect(state.snapshotInserts[0]).toMatchObject({
      accrualStroops: 821n,
      carryAfterStroops: 821n,
      mintedMinor: 0n,
    });
    expect(state.creditInserts).toHaveLength(0);
    expect(state.payoutInserts).toHaveLength(0);
  });

  it('chains the carry across nights until it crosses a minor unit', async () => {
    configureGbp();
    state.eligibleUsers = [{ id: 'u-1', walletAddress: WALLET }];
    horizonState.balances.set(WALLET, 5_000_000_000n);
    // Night 2: prior snapshot carried 99_999 stroops; tonight's
    // 410_958 pushes the payable to 510_957 → 5 minor + 10_957 carry.
    state.latestSnapshotQueue = [{ periodCursor: '2026-06-11', carryAfterStroops: 99_999n }];

    const r = await runInterestMintTick({ now: NOW, apyBps: 300 });
    expect(r.minted).toBe(1);
    expect(state.snapshotInserts[0]).toMatchObject({
      carryBeforeStroops: 99_999n,
      mintedMinor: 5n,
      carryAfterStroops: 10_957n,
    });
    expect(state.payoutInserts[0]).toMatchObject({ amountStroops: 500_000n });
  });

  it('period idempotency: re-running the same UTC day yields exactly one credit + one payout row', async () => {
    configureGbp();
    state.eligibleUsers = [{ id: 'u-1', walletAddress: WALLET }];
    horizonState.balances.set(WALLET, 5_000_000_000n);

    const first = await runInterestMintTick({ now: NOW, apyBps: 300 });
    expect(first.minted).toBe(1);
    // Simulate a crash AFTER the per-user txns but BEFORE the cursor
    // write landed (worst case): clear the cursor and re-run. The
    // snapshot unique fence must swallow the duplicate.
    state.cursorRow = null;
    state.latestSnapshotQueue = [{ periodCursor: '2026-06-12', carryAfterStroops: 10_958n }];
    const second = await runInterestMintTick({ now: NOW, apyBps: 300 });
    expect(second.minted).toBe(0);
    expect(second.skippedAlready).toBe(1);
    expect(state.creditInserts).toHaveLength(1);
    expect(state.payoutInserts).toHaveLength(1);
    expect(state.snapshotInserts).toHaveLength(1);
  });

  it('cursor fast-path: a tick inside an already-processed period is a no-op', async () => {
    configureGbp();
    state.cursorRow = '2026-06-12';
    state.eligibleUsers = [{ id: 'u-1', walletAddress: WALLET }];
    horizonState.balances.set(WALLET, 5_000_000_000n);

    const r = await runInterestMintTick({ now: NOW, apyBps: 300 });
    expect(r.alreadyProcessed).toBe(true);
    expect(r.minted).toBe(0);
    expect(state.snapshotInserts).toHaveLength(0);
  });

  it('downtime self-heal: a stale cursor from a previous period does not block the current period', async () => {
    configureGbp();
    // Process was down across midnight (and a full missed day) —
    // cursor still says the 10th. The first tick on the 12th runs
    // the 12th's pass and advances the cursor.
    state.cursorRow = '2026-06-10';
    state.eligibleUsers = [{ id: 'u-1', walletAddress: WALLET }];
    horizonState.balances.set(WALLET, 5_000_000_000n);

    const r = await runInterestMintTick({ now: NOW, apyBps: 300 });
    expect(r.alreadyProcessed).toBe(false);
    expect(r.minted).toBe(1);
    expect(state.snapshotInserts[0]).toMatchObject({ periodCursor: '2026-06-12' });
    expect(state.cursorRow).toBe('2026-06-12');
  });

  it('skips zero-balance holders without writing a snapshot', async () => {
    configureGbp();
    state.eligibleUsers = [{ id: 'u-1', walletAddress: WALLET }];
    horizonState.balances.set(WALLET, 0n);

    const r = await runInterestMintTick({ now: NOW, apyBps: 300 });
    expect(r.skippedZeroBalance).toBe(1);
    expect(state.snapshotInserts).toHaveLength(0);
    expect(state.cursorRow).toBe('2026-06-12');
  });

  it('a per-user Horizon failure is counted and does NOT advance the cursor', async () => {
    configureGbp();
    const wallet2 = 'GWALLETBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    state.eligibleUsers = [
      { id: 'u-1', walletAddress: WALLET },
      { id: 'u-2', walletAddress: wallet2 },
    ];
    horizonState.balances.set(WALLET, 5_000_000_000n);
    horizonState.throwFor.add(wallet2);

    const r = await runInterestMintTick({ now: NOW, apyBps: 300 });
    expect(r.minted).toBe(1);
    expect(r.errors).toBe(1);
    // Cursor stays put so the next tick retries u-2; u-1 is fenced.
    expect(state.cursorRow).toBe(null);
  });

  it('does nothing without a validated issuer signer for the asset', async () => {
    configMocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'GBPLOOP', issuer: ISSUER }]);
    configMocks.resolveIssuerSigners.mockReturnValue(new Map()); // no secrets configured
    state.eligibleUsers = [{ id: 'u-1', walletAddress: WALLET }];
    horizonState.balances.set(WALLET, 5_000_000_000n);

    const r = await runInterestMintTick({ now: NOW, apyBps: 300 });
    expect(r.minted).toBe(0);
    expect(r.eligibleUsers).toBe(0);
    expect(state.snapshotInserts).toHaveLength(0);
  });

  it('refuses a signer whose validated account mismatches the configured issuer', async () => {
    configMocks.configuredLoopPayableAssets.mockReturnValue([{ code: 'GBPLOOP', issuer: ISSUER }]);
    configMocks.resolveIssuerSigners.mockReturnValue(
      new Map([['GBPLOOP', { secret: 'SSECRET', account: 'GOTHERISSUER' }]]),
    );
    state.eligibleUsers = [{ id: 'u-1', walletAddress: WALLET }];
    horizonState.balances.set(WALLET, 5_000_000_000n);

    const r = await runInterestMintTick({ now: NOW, apyBps: 300 });
    expect(r.minted).toBe(0);
    expect(state.snapshotInserts).toHaveLength(0);
  });

  it('zero APY is a structural no-op', async () => {
    configureGbp();
    state.eligibleUsers = [{ id: 'u-1', walletAddress: WALLET }];
    const r = await runInterestMintTick({ now: NOW, apyBps: 0 });
    expect(r.minted).toBe(0);
    expect(state.snapshotInserts).toHaveLength(0);
    expect(state.cursorRow).toBe(null);
  });
});
