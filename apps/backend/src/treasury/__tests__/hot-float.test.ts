import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Treasury hot-float ledger (ADR 031 §Liquidity safeguard, V4).
 * Mock-based unit suite — mocks `db/client.js` (table-routed,
 * `vault_hot_float` only) and `credits/vaults/vault-client.js`
 * (`readVaultState`, `withdrawFromVault`). No network.
 *
 * `drawHotFloatInTx` / `applyHotFloatDeltaInTx` / `ensureFloatRowInTx`
 * are tx-scoped primitives meant to compose with a CALLER's own
 * transaction (see the module header) — per the task brief, this
 * suite exercises them with a simple fake `tx` (the same mocked `db`
 * singleton, which has the identical chainable interface) rather than
 * a full nested-rollback harness; the cross-table atomicity these
 * primitives must support (a `vault_redemptions` state-CAS landing
 * atomically with a float write) is exercised by
 * `credits/vaults/__tests__/vault-redemptions.test.ts` instead.
 */

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

/**
 * Recursively collects every drizzle `Param` string value in a
 * condition tree (`eq()`/`and()` route their RHS through
 * `bindIfParam`, which wraps it as a real `Param` — see
 * `drizzle-orm/sql/expressions/conditions.js`). Used to resolve the
 * `(assetCode, network)` composite key from a WHERE clause.
 */
function collectStringParams(node: unknown): string[] {
  const out: string[] = [];
  if (node === null || typeof node !== 'object') return out;
  const asParam = node as { value?: unknown; encoder?: unknown };
  if ('value' in asParam && 'encoder' in asParam && typeof asParam.value === 'string') {
    out.push(asParam.value);
    return out;
  }
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    for (const c of chunks) out.push(...collectStringParams(c));
  }
  return out;
}

/**
 * Extracts the signed delta from a `.set({col: sql\`${col} ± ${delta}\`})`
 * expression. A raw JS value interpolated directly into a
 * `sql\`...\`` tag is NOT auto-wrapped as a `Param` (unlike `eq()`'s
 * RHS) — it sits directly as an element of `.queryChunks` (see
 * `drizzle-orm/sql/sql.js`'s `sql()` tag). The sign is literal
 * template text in a `StringChunk` between the column reference and
 * the raw value.
 */
function extractSqlDelta(node: unknown): bigint {
  const chunks = (node as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) {
    throw new Error('extractSqlDelta: expected a drizzle sql`` template node with queryChunks');
  }
  let sign = 1n;
  let amount: bigint | null = null;
  for (const chunk of chunks) {
    if (typeof chunk === 'bigint') {
      amount = chunk;
      continue;
    }
    const asStringChunk = chunk as { value?: unknown } | null;
    if (asStringChunk !== null && Array.isArray(asStringChunk.value)) {
      const text = (asStringChunk.value as unknown[]).join('');
      if (text.includes('-')) sign = -1n;
    }
  }
  if (amount === null) {
    throw new Error('extractSqlDelta: no raw bigint literal found in sql() template node');
  }
  return sign * amount;
}

function extractFloatKey(condition: unknown): string {
  const params = collectStringParams(condition);
  const assetCode = params.find((p) => p === 'LOOPUSD' || p === 'LOOPEUR');
  const network = params.find((p) => p === 'testnet' || p === 'mainnet');
  if (assetCode === undefined || network === undefined) {
    throw new Error(
      `extractFloatKey: could not resolve (assetCode, network) from condition params ${JSON.stringify(params)}`,
    );
  }
  return `${assetCode}:${network}`;
}

// ── table-routed chainable db mock (vault_hot_float only) ──────────
const { state } = vi.hoisted(() => {
  interface HotFloatRowLike {
    id: string;
    assetCode: string;
    network: string;
    balanceMinor: bigint;
    pendingUnredeemedShares: bigint;
    updatedAt: Date;
  }

  const s = {
    rows: new Map<string, HotFloatRowLike>(),
    nextId: 1,
    tableNameOf: (_t: unknown): string => '',
    reset(): void {
      s.rows.clear();
      s.nextId = 1;
    },
    seed(
      assetCode: string,
      network: string,
      balanceMinor: bigint,
      pendingUnredeemedShares: bigint,
    ): void {
      s.rows.set(`${assetCode}:${network}`, {
        id: `float-${s.nextId++}`,
        assetCode,
        network,
        balanceMinor,
        pendingUnredeemedShares,
        updatedAt: new Date(),
      });
    },
  };
  return { state: s };
});

function buildDbMock(): Record<string, unknown> {
  function handleEnsure(v: Record<string, unknown>): unknown[] {
    const assetCode = v['assetCode'] as string;
    const network = v['network'] as string;
    const key = `${assetCode}:${network}`;
    if (!state.rows.has(key)) {
      state.seed(
        assetCode,
        network,
        (v['balanceMinor'] as bigint | undefined) ?? 0n,
        (v['pendingUnredeemedShares'] as bigint | undefined) ?? 0n,
      );
    }
    return [];
  }

  function handleUpdate(patch: Record<string, unknown>, condition: unknown): void {
    const key = extractFloatKey(condition);
    const existing = state.rows.get(key);
    if (existing === undefined) {
      throw new Error(`vault_hot_float row missing for update (key=${key})`);
    }
    const next = { ...existing };
    if ('balanceMinor' in patch) {
      next.balanceMinor = existing.balanceMinor + extractSqlDelta(patch['balanceMinor']);
    }
    if ('pendingUnredeemedShares' in patch) {
      next.pendingUnredeemedShares =
        existing.pendingUnredeemedShares + extractSqlDelta(patch['pendingUnredeemedShares']);
    }
    next.updatedAt = new Date();
    state.rows.set(key, next);
  }

  function makeSelect(): Record<string, unknown> {
    let table = '';
    const chain: Record<string, unknown> = {};
    chain['from'] = (t: unknown) => {
      table = state.tableNameOf(t);
      return chain;
    };
    chain['where'] = (condition: unknown) => {
      if (table !== 'vaultHotFloat') throw new Error(`unexpected select on ${table}`);
      const readRow = (): unknown[] => {
        const row = state.rows.get(extractFloatKey(condition));
        return row ? [row] : [];
      };
      return {
        for: async (..._args: unknown[]) => readRow(),
        then: (resolve: (v: unknown) => unknown) => resolve(readRow()),
      };
    };
    return chain;
  }

  function makeInsert(t: unknown): Record<string, unknown> {
    const table = state.tableNameOf(t);
    return {
      values: (v: Record<string, unknown>) => {
        if (table !== 'vaultHotFloat') throw new Error(`unexpected insert on ${table}`);
        return {
          onConflictDoNothing: (_opts?: unknown) => ({
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve()
                .then(() => handleEnsure(v))
                .then(resolve, reject),
          }),
        };
      },
    };
  }

  function makeUpdate(t: unknown): Record<string, unknown> {
    const table = state.tableNameOf(t);
    return {
      set: (patch: Record<string, unknown>) => ({
        where: (condition: unknown) => ({
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve()
              .then(() => {
                if (table !== 'vaultHotFloat') throw new Error(`unexpected update on ${table}`);
                handleUpdate(patch, condition);
                return [];
              })
              .then(resolve, reject),
        }),
      }),
    };
  }

  const mock: Record<string, unknown> = {
    select: () => makeSelect(),
    insert: (t: unknown) => makeInsert(t),
    update: (t: unknown) => makeUpdate(t),
    // Single-table primitives (module header) — no cross-table
    // rollback needed here (unlike vault-redemptions.test.ts's mock),
    // so `tx` is simply `db` itself.
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mock),
  };
  return mock;
}

vi.mock('../../db/client.js', () => ({ db: buildDbMock() }));

const { vaultClientMocks } = vi.hoisted(() => ({
  vaultClientMocks: {
    readVaultState: vi.fn(),
    withdrawFromVault: vi.fn(),
  },
}));
vi.mock('../../credits/vaults/vault-client.js', () => ({
  readVaultState: (...args: unknown[]) => vaultClientMocks.readVaultState(...args),
  withdrawFromVault: (...args: unknown[]) => vaultClientMocks.withdrawFromVault(...args),
}));

import { getTableName, type Table } from 'drizzle-orm';
import { vaultHotFloat } from '../../db/schema.js';
import { db } from '../../db/client.js';
import {
  getHotFloatRow,
  tryDrawHotFloat,
  creditHotFloat,
  drawHotFloatInTx,
  applyHotFloatDeltaInTx,
  ensureFloatRowInTx,
  runHotFloatReplenishTick,
  type HotFloatTx,
} from '../hot-float.js';
import type { LoopVaultRow } from '../../credits/vaults/registry.js';

state.tableNameOf = (t: unknown) => {
  if (t === vaultHotFloat) return 'vaultHotFloat';
  return getTableName(t as Table);
};

const ASSET = 'LOOPUSD' as const;
const NETWORK = 'testnet' as const;

const VAULT: LoopVaultRow = {
  id: 'vault-row-1',
  assetCode: 'LOOPUSD',
  vaultContractId: 'CVAULTCONTRACTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  shareAssetCode: 'LOOPUSD',
  shareAssetIssuer: 'CSHARECONTRACTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  underlyingAssetCode: 'USDC',
  underlyingAssetIssuer: 'GUSDCISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  strategyId: 'blend-usdc-pool',
  network: 'testnet',
  feeBps: 5000,
  active: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

beforeEach(() => {
  state.reset();
  vaultClientMocks.readVaultState.mockReset();
  vaultClientMocks.readVaultState.mockResolvedValue({
    totalSupply: 1_000_000_000n,
    totalManaged: 1_000_000_000n,
    sharePricePpm: 1_000_000n, // 1:1
  });
  vaultClientMocks.withdrawFromVault.mockReset();
});

describe('getHotFloatRow', () => {
  it('creates a zero row on first read for a (assetCode, network) with no existing row', async () => {
    const row = await getHotFloatRow(ASSET, NETWORK);
    expect(row.balanceMinor).toBe(0n);
    expect(row.pendingUnredeemedShares).toBe(0n);
    expect(state.rows.has(`${ASSET}:${NETWORK}`)).toBe(true);
  });

  it('returns the EXISTING row unmodified on a second read (ensureFloatRowInTx is a true no-op on conflict)', async () => {
    state.seed(ASSET, NETWORK, 5_000n, 250n);
    const row = await getHotFloatRow(ASSET, NETWORK);
    expect(row.balanceMinor).toBe(5_000n);
    expect(row.pendingUnredeemedShares).toBe(250n);
  });
});

describe('tryDrawHotFloat', () => {
  it('returns false and writes NOTHING when the balance is insufficient', async () => {
    state.seed(ASSET, NETWORK, 100n, 0n);
    const drew = await tryDrawHotFloat(ASSET, NETWORK, 500n);
    expect(drew).toBe(false);
    const row = state.rows.get(`${ASSET}:${NETWORK}`)!;
    expect(row.balanceMinor).toBe(100n); // untouched
    expect(row.pendingUnredeemedShares).toBe(0n);
  });

  it('returns true and draws EXACTLY the amount when the balance covers it', async () => {
    state.seed(ASSET, NETWORK, 1_000n, 0n);
    const drew = await tryDrawHotFloat(ASSET, NETWORK, 400n);
    expect(drew).toBe(true);
    const row = state.rows.get(`${ASSET}:${NETWORK}`)!;
    expect(row.balanceMinor).toBe(600n);
    expect(row.pendingUnredeemedShares).toBe(0n); // tryDrawHotFloat always passes pendingSharesDelta=0
  });

  it('draws exactly at the boundary (balance == amount)', async () => {
    state.seed(ASSET, NETWORK, 500n, 0n);
    const drew = await tryDrawHotFloat(ASSET, NETWORK, 500n);
    expect(drew).toBe(true);
    expect(state.rows.get(`${ASSET}:${NETWORK}`)!.balanceMinor).toBe(0n);
  });

  it('creates the zero row first (via ensureFloatRowInTx) when none exists, then correctly reports insufficient', async () => {
    const drew = await tryDrawHotFloat(ASSET, NETWORK, 1n);
    expect(drew).toBe(false);
    expect(state.rows.get(`${ASSET}:${NETWORK}`)?.balanceMinor).toBe(0n);
  });
});

describe('creditHotFloat', () => {
  it('applies a pure delta to balanceMinor, leaving pendingUnredeemedShares untouched', async () => {
    state.seed(ASSET, NETWORK, 200n, 50n);
    await creditHotFloat(ASSET, NETWORK, 75n);
    const row = state.rows.get(`${ASSET}:${NETWORK}`)!;
    expect(row.balanceMinor).toBe(275n);
    expect(row.pendingUnredeemedShares).toBe(50n);
  });

  it('creates the zero row first when none exists, then credits it', async () => {
    await creditHotFloat(ASSET, NETWORK, 10n);
    expect(state.rows.get(`${ASSET}:${NETWORK}`)?.balanceMinor).toBe(10n);
  });
});

describe('drawHotFloatInTx / applyHotFloatDeltaInTx / ensureFloatRowInTx — tx-scoped primitives with a caller-supplied tx', () => {
  it('ensureFloatRowInTx is idempotent: a second call over an existing row does not reset it', async () => {
    await ensureFloatRowInTx(db as unknown as HotFloatTx, ASSET, NETWORK);
    await tryDrawHotFloat(ASSET, NETWORK, 0n).catch(() => undefined); // no-op, just to touch nothing
    await creditHotFloat(ASSET, NETWORK, 42n);
    await ensureFloatRowInTx(db as unknown as HotFloatTx, ASSET, NETWORK); // must NOT reset to 0
    expect(state.rows.get(`${ASSET}:${NETWORK}`)?.balanceMinor).toBe(42n);
  });

  it('drawHotFloatInTx applies BOTH the balance draw and the pending-shares credit in one call, using the caller-supplied tx', async () => {
    state.seed(ASSET, NETWORK, 1_000n, 10n);
    const drew = await drawHotFloatInTx(db as unknown as HotFloatTx, ASSET, NETWORK, 300n, 295n);
    expect(drew).toBe(true);
    const row = state.rows.get(`${ASSET}:${NETWORK}`)!;
    expect(row.balanceMinor).toBe(700n);
    expect(row.pendingUnredeemedShares).toBe(305n); // 10 + 295
  });

  it('drawHotFloatInTx returns false and writes nothing when insufficient, even with a caller-supplied tx', async () => {
    state.seed(ASSET, NETWORK, 100n, 0n);
    const drew = await drawHotFloatInTx(db as unknown as HotFloatTx, ASSET, NETWORK, 500n, 480n);
    expect(drew).toBe(false);
    const row = state.rows.get(`${ASSET}:${NETWORK}`)!;
    expect(row.balanceMinor).toBe(100n);
    expect(row.pendingUnredeemedShares).toBe(0n);
  });

  it('applyHotFloatDeltaInTx applies a pure (balance, pendingShares) delta pair — including a NEGATIVE balance delta (the slow-path net credit can be exactly this shape)', async () => {
    state.seed(ASSET, NETWORK, 1_000n, 500n);
    await applyHotFloatDeltaInTx(db as unknown as HotFloatTx, ASSET, NETWORK, -20n, -500n);
    const row = state.rows.get(`${ASSET}:${NETWORK}`)!;
    expect(row.balanceMinor).toBe(980n);
    expect(row.pendingUnredeemedShares).toBe(0n);
  });
});

describe('runHotFloatReplenishTick', () => {
  it('no-ops (replenished: false) when pendingUnredeemedShares <= 0, without touching the chain', async () => {
    state.seed(ASSET, NETWORK, 100n, 0n);
    const result = await runHotFloatReplenishTick(VAULT);
    expect(result).toEqual({ replenished: false });
    expect(vaultClientMocks.withdrawFromVault).not.toHaveBeenCalled();
    expect(vaultClientMocks.readVaultState).not.toHaveBeenCalled();
  });

  it('redeems the WHOLE pending balance in ONE withdrawFromVault call when pendingUnredeemedShares > 0, crediting the proceeds and decrementing the pending shares by the withdrawn amount', async () => {
    state.seed(ASSET, NETWORK, 100n, 1_000_000n);
    vaultClientMocks.withdrawFromVault.mockResolvedValue({
      txHash: 'replenish-tx-1',
      amountsOut: [1_050_000n * 100_000n], // 1,050,000 minor worth of stroops (7-decimal convention)
      deduped: false,
    });

    const result = await runHotFloatReplenishTick(VAULT);

    expect(vaultClientMocks.withdrawFromVault).toHaveBeenCalledTimes(1);
    const call = vaultClientMocks.withdrawFromVault.mock.calls[0]![0] as { shares: bigint };
    expect(call.shares).toBe(1_000_000n); // the WHOLE pending balance, one call

    expect(result.replenished).toBe(true);
    expect(result.amountMinor).toBe(1_050_000n);
    expect(result.txHash).toBe('replenish-tx-1');

    const row = state.rows.get(`${ASSET}:${NETWORK}`)!;
    expect(row.balanceMinor).toBe(100n + 1_050_000n);
    expect(row.pendingUnredeemedShares).toBe(0n); // fully decremented, none added concurrently
  });

  it('decrements pendingUnredeemedShares by a DELTA-SUBTRACT of the CAPTURED amount — safe if a concurrent fast-path draw adds MORE pending shares while the withdraw is in flight', async () => {
    state.seed(ASSET, NETWORK, 0n, 1_000_000n);
    vaultClientMocks.withdrawFromVault.mockImplementation(
      async (args: { minAmountsOut: bigint }) => {
        // Simulate another driver's fast-path draw landing WHILE this
        // replenish's on-chain call is in flight — adds pending shares
        // this attempt never intended to redeem. A "set pending shares
        // to 0" implementation would silently drop this addition; a
        // correct delta-subtract of the CAPTURED 1,000,000 leaves it.
        const key = `${ASSET}:${NETWORK}`;
        const row = state.rows.get(key)!;
        state.rows.set(key, {
          ...row,
          pendingUnredeemedShares: row.pendingUnredeemedShares + 250_000n,
        });
        return { txHash: 'replenish-tx-2', amountsOut: [args.minAmountsOut], deduped: false };
      },
    );

    await runHotFloatReplenishTick(VAULT);

    const row = state.rows.get(`${ASSET}:${NETWORK}`)!;
    // 1,000,000 (captured, subtracted) + 250,000 (landed concurrently) = 250,000 remaining, NOT 0.
    expect(row.pendingUnredeemedShares).toBe(250_000n);
  });

  it('computes minAmountsOut as the expected underlying minus the slippage tolerance, from a live readVaultState price', async () => {
    state.seed(ASSET, NETWORK, 0n, 2_000_000n);
    vaultClientMocks.readVaultState.mockResolvedValue({
      totalSupply: 1n,
      totalManaged: 1n,
      sharePricePpm: 1_100_000n, // 1.1 underlying per share
    });
    vaultClientMocks.withdrawFromVault.mockResolvedValue({
      txHash: 'replenish-tx-3',
      amountsOut: [2_200_000n],
      deduped: false,
    });

    await runHotFloatReplenishTick(VAULT);

    const call = vaultClientMocks.withdrawFromVault.mock.calls[0]![0] as { minAmountsOut: bigint };
    const expectedUnderlying = (2_000_000n * 1_100_000n) / 1_000_000n; // 2_200_000n
    const expectedMinAmountsOut = expectedUnderlying - (expectedUnderlying * 50n) / 10_000n; // REPLENISH_SLIPPAGE_TOLERANCE_BPS = 50
    expect(call.minAmountsOut).toBe(expectedMinAmountsOut);
  });
});
