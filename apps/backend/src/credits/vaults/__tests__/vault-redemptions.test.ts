import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR 031 §D6 (V4) — vault-share REDEMPTION (withdraw/spend) state
 * machine. Mock-based unit twin of `credits/vaults/__tests__/
 * vault-emissions.test.ts` (the V3 EMISSION-direction sibling) — same
 * hand-rolled table-routed `db.transaction`/`.select()`/`.insert()`/
 * `.update()` mock idiom (`vi.hoisted`), same mocked
 * `vault-client.js`/`registry.js`/`logger.js`/`discord.js`/
 * `runtime-health.js`.
 *
 * What's DIFFERENT here (and why this harness is more than a
 * find-and-replace of the emissions one): `payoutStep` composes TWO
 * tables (`vault_redemptions` + `vault_hot_float`) inside ONE
 * `db.transaction`, and the atomicity of that composition — the float
 * draw/credit rolling back together with a MISSED state-CAS via the
 * `PayoutAlreadyLandedError` sentinel — is the single most
 * load-bearing correctness property in the whole module (see
 * `vault-redemptions.ts`'s module header, "Known residual race"). So
 * this mock's `db.transaction(cb)` is NOT the emissions template's
 * simple "snapshot 3 arrays, restore on throw" — it snapshots BOTH
 * table maps (`vaultRedemptions` + `vaultHotFloat`) plus the mirror
 * step's ledger state, and restores ALL of it on a thrown error,
 * mirroring real Postgres `ROLLBACK` semantics for a multi-table
 * transaction.
 *
 * `treasury/hot-float.ts` is DELIBERATELY NOT mocked — the REAL
 * `drawHotFloatInTx` / `applyHotFloatDeltaInTx` / `ensureFloatRowInTx`
 * run against this mocked `db`, so a bug in the arithmetic or the
 * atomicity contract between the two modules would actually surface
 * here, not just in a hand-asserted expectation.
 *
 * What this suite does NOT prove: that `vault_redemptions_source_unique`
 * fires as a real 23505, or that the REAL `assert_emission_conservation`
 * trigger accepts the mirror step's burn row — that's
 * `__tests__/integration/vault-redemptions.test.ts` (real postgres).
 */

vi.mock('../../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

vi.mock('../../../runtime-health.js', () => ({
  markWorkerStarted: vi.fn(),
  markWorkerStopped: vi.fn(),
  markWorkerTickSuccess: vi.fn(),
  markWorkerTickFailure: vi.fn(),
}));

import { Keypair, Address } from '@stellar/stellar-sdk';

// Real strkey-shaped fixtures — this mock harness doesn't validate
// shape (the real DB CHECK constraints do — see the integration
// suite), but real-looking addresses avoid misleading a future reader.
const OPERATOR_PUBLIC = Keypair.random().publicKey();
const USER_WALLET = Keypair.random().publicKey();
const SHARE_CONTRACT_ID = Address.contract(Buffer.alloc(32, 4)).toString();

const VAULT = {
  id: 'vault-row-1',
  assetCode: 'LOOPUSD' as const,
  vaultContractId: 'CVAULTCONTRACTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  shareAssetCode: 'LOOPUSD',
  shareAssetIssuer: SHARE_CONTRACT_ID,
  underlyingAssetCode: 'USDC',
  underlyingAssetIssuer: 'GUSDCISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  strategyId: 'blend-usdc-pool',
  network: 'testnet' as const,
  feeBps: 5000,
  active: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

/**
 * Recursively collects every drizzle `Param` string value in a
 * condition tree. `eq()`/`and()` route their RHS through
 * `bindIfParam`, which genuinely wraps it as a `Param` (`{value,
 * encoder}`) — see `drizzle-orm/sql/expressions/conditions.js`. Used
 * both for row lookups (id, or the (sourceType, sourceId) compound)
 * and for resolving a `vault_hot_float`/`user_credits` composite key
 * from its WHERE clause.
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
 * Extracts the signed delta from a `hot-float.ts` `.set({col: sql\`${col}
 * ± ${delta}\`})` expression. UNLIKE `eq()`'s condition values (which
 * `bindIfParam` wraps as a real `Param`), a raw JS value interpolated
 * directly into a `sql\`...\`` template tag is NOT auto-wrapped — the
 * bigint sits directly as an element of `.queryChunks` (see
 * `drizzle-orm/sql/sql.js`'s `sql()` tag: `params` are pushed as-is).
 * The sign (`+`/`-`) is literal template text living in a
 * `StringChunk` between the column reference and the raw value. This
 * is the "special-case the two known shapes hot-float.ts's `.set()`
 * calls actually produce" approach the task brief calls for — more
 * robust than trying to generically evaluate arbitrary SQL.
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

const VAULT_REDEMPTION_STATE_SET = new Set([
  'pending',
  'collecting',
  'redeemed',
  'settled',
  'failed',
]);
const VAULT_REDEMPTION_SWEEP_STATES = new Set(['pending', 'collecting', 'redeemed']);

// ── table-routed chainable db mock ──────────────────────────────────
const { state } = vi.hoisted(() => {
  interface VaultRedemptionRowLike {
    id: string;
    sourceType: string;
    sourceId: string;
    userId: string;
    assetCode: string;
    network: string;
    valueMinor: bigint;
    fromAddress: string;
    state: string;
    sharesToRedeem: bigint | null;
    collectTxHash: string | null;
    payoutPath: string | null;
    redeemTxHash: string | null;
    pendingPayoutId: string | null;
    attempts: number;
    lastError: string | null;
    createdAt: Date;
    collectedAt: Date | null;
    redeemedAt: Date | null;
    settledAt: Date | null;
    failedAt: Date | null;
  }

  interface HotFloatRowLike {
    id: string;
    assetCode: string;
    network: string;
    balanceMinor: bigint;
    pendingUnredeemedShares: bigint;
    updatedAt: Date;
  }

  const s = {
    redemptionRows: new Map<string, VaultRedemptionRowLike>(),
    hotFloatRows: new Map<string, HotFloatRowLike>(), // key: `${assetCode}:${network}`
    nextId: 1,
    nextFloatId: 1,
    userCreditsBalances: new Map<string, bigint>(), // key: `${userId}:${currency}`
    creditTransactionInserts: [] as Array<Record<string, unknown>>,
    pendingPayoutInserts: [] as Array<Record<string, unknown>>,
    tableNameOf: (_t: unknown): string => '',
    reset(): void {
      s.redemptionRows.clear();
      s.hotFloatRows.clear();
      s.nextId = 1;
      s.nextFloatId = 1;
      s.userCreditsBalances.clear();
      s.creditTransactionInserts = [];
      s.pendingPayoutInserts = [];
    },
    seedRow(
      row: Partial<VaultRedemptionRowLike> & {
        sourceType: string;
        sourceId: string;
        userId: string;
      },
    ): VaultRedemptionRowLike {
      const id = row.id ?? `vr-${s.nextId++}`;
      const full: VaultRedemptionRowLike = {
        id,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        userId: row.userId,
        assetCode: row.assetCode ?? 'LOOPUSD',
        network: row.network ?? 'testnet',
        valueMinor: row.valueMinor ?? 500n,
        fromAddress: row.fromAddress ?? 'GUSERWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        state: row.state ?? 'pending',
        sharesToRedeem: row.sharesToRedeem ?? null,
        collectTxHash: row.collectTxHash ?? null,
        payoutPath: row.payoutPath ?? null,
        redeemTxHash: row.redeemTxHash ?? null,
        pendingPayoutId: row.pendingPayoutId ?? null,
        attempts: row.attempts ?? 0,
        lastError: row.lastError ?? null,
        createdAt: row.createdAt ?? new Date(),
        collectedAt: row.collectedAt ?? null,
        redeemedAt: row.redeemedAt ?? null,
        settledAt: row.settledAt ?? null,
        failedAt: row.failedAt ?? null,
      };
      s.redemptionRows.set(id, full);
      return full;
    },
    seedFloat(
      assetCode: string,
      network: string,
      balanceMinor: bigint,
      pendingUnredeemedShares: bigint,
    ): void {
      s.hotFloatRows.set(`${assetCode}:${network}`, {
        id: `float-${s.nextFloatId++}`,
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

function filterVaultRedemptions(condition: unknown): unknown[] {
  const params = collectStringParams(condition);
  const byId = params.find((p) => state.redemptionRows.has(p));
  if (byId !== undefined) {
    const row = state.redemptionRows.get(byId);
    return row ? [row] : [];
  }
  // Fall back to the (sourceType, sourceId) compound lookup
  // (`claimVaultRedemption`'s existing-row read).
  return [...state.redemptionRows.values()].filter(
    (r) => params.includes(r.sourceType) && params.includes(r.sourceId),
  );
}

function sweepCandidateRows(): unknown[] {
  return [...state.redemptionRows.values()]
    .filter((r) => VAULT_REDEMPTION_SWEEP_STATES.has(r.state))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

function handleVaultRedemptionClaim(v: Record<string, unknown>): unknown[] {
  const sourceType = v['sourceType'] as string;
  const sourceId = v['sourceId'] as string;
  const conflict = [...state.redemptionRows.values()].some(
    (r) => r.sourceType === sourceType && r.sourceId === sourceId,
  );
  if (conflict) return [];
  const row = state.seedRow({
    sourceType,
    sourceId,
    userId: v['userId'] as string,
    assetCode: v['assetCode'] as string,
    network: v['network'] as string,
    valueMinor: v['valueMinor'] as bigint,
    fromAddress: v['fromAddress'] as string,
    state: (v['state'] as string) ?? 'pending',
  });
  return [row];
}

function handleVaultRedemptionUpdate(
  patch: Record<string, unknown>,
  condition: unknown,
): unknown[] {
  const params = collectStringParams(condition);
  const id = params.find((p) => state.redemptionRows.has(p));
  if (id === undefined) return [];
  const existing = state.redemptionRows.get(id);
  if (existing === undefined) return [];
  // CAS: a state-guard param (e.g. `pending -> collecting`'s
  // `state='pending'`, or the payout step's `state='collecting'`)
  // only applies when the row's CURRENT (live) state matches —
  // otherwise a concurrent driver already moved it on, and the claim
  // is lost (return [] — no row — exactly like a real guarded UPDATE
  // matching zero rows).
  const stateGuard = params.find((p) => VAULT_REDEMPTION_STATE_SET.has(p) && p !== id);
  if (stateGuard !== undefined && existing.state !== stateGuard) return [];
  const updated = { ...existing, ...patch };
  state.redemptionRows.set(id, updated);
  return [updated];
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

function handleHotFloatEnsure(v: Record<string, unknown>): unknown[] {
  const assetCode = v['assetCode'] as string;
  const network = v['network'] as string;
  const key = `${assetCode}:${network}`;
  if (!state.hotFloatRows.has(key)) {
    state.seedFloat(
      assetCode,
      network,
      (v['balanceMinor'] as bigint | undefined) ?? 0n,
      (v['pendingUnredeemedShares'] as bigint | undefined) ?? 0n,
    );
  }
  return [];
}

function handleHotFloatUpdate(patch: Record<string, unknown>, condition: unknown): void {
  const key = extractFloatKey(condition);
  const existing = state.hotFloatRows.get(key);
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
  state.hotFloatRows.set(key, next);
}

function handleUserCreditsUpdate(patch: Record<string, unknown>, condition: unknown): void {
  const params = collectStringParams(condition);
  const currency = params.find((p) => p === 'USD' || p === 'GBP' || p === 'EUR');
  const userId = params.find((p) => p !== currency);
  if (userId === undefined || currency === undefined) {
    throw new Error(
      `handleUserCreditsUpdate: could not resolve (userId, currency) from condition params ${JSON.stringify(params)}`,
    );
  }
  const key = `${userId}:${currency}`;
  const prev = state.userCreditsBalances.get(key) ?? 0n;
  state.userCreditsBalances.set(key, prev + extractSqlDelta(patch['balanceMinor']));
}

function handleCreditTransactionInsert(v: Record<string, unknown>): void {
  state.creditTransactionInserts.push(v);
}

function handlePendingPayoutInsert(v: Record<string, unknown>): Array<{ id: string }> {
  const id = `pp-${state.pendingPayoutInserts.length + 1}`;
  state.pendingPayoutInserts.push(v);
  return [{ id }];
}

function buildDbMock(): Record<string, unknown> {
  function makeSelect(): Record<string, unknown> {
    let table = '';
    const chain: Record<string, unknown> = {};
    chain['from'] = (t: unknown) => {
      table = state.tableNameOf(t);
      return chain;
    };
    chain['where'] = (condition: unknown) => {
      if (table === 'vaultRedemptions') {
        return {
          then: (resolve: (v: unknown) => unknown) => resolve(filterVaultRedemptions(condition)),
          orderBy: () => ({
            limit: (_n: number) => {
              const rows = sweepCandidateRows();
              return {
                for: async (..._args: unknown[]) => rows,
                then: (resolve: (v: unknown) => unknown) => resolve(rows),
              };
            },
          }),
        };
      }
      if (table === 'vaultHotFloat') {
        const readRow = (): unknown[] => {
          const row = state.hotFloatRows.get(extractFloatKey(condition));
          return row ? [row] : [];
        };
        return {
          for: async (..._args: unknown[]) => readRow(),
          then: (resolve: (v: unknown) => unknown) => resolve(readRow()),
        };
      }
      if (table === 'userCredits') {
        // mirrorStep's `FOR UPDATE` lock read — value unused (lock-then-write).
        return {
          for: () => ({ then: (resolve: (v: unknown) => unknown) => resolve([]) }),
          then: (resolve: (v: unknown) => unknown) => resolve([]),
        };
      }
      throw new Error(`unexpected select on ${table}`);
    };
    return chain;
  }

  function makeInsert(t: unknown): Record<string, unknown> {
    const table = state.tableNameOf(t);
    return {
      values: (v: Record<string, unknown>) => {
        const run = async (): Promise<unknown[]> => {
          if (table === 'vaultRedemptions') return handleVaultRedemptionClaim(v);
          if (table === 'vaultHotFloat') return handleHotFloatEnsure(v);
          if (table === 'creditTransactions') {
            handleCreditTransactionInsert(v);
            return [];
          }
          if (table === 'pendingPayouts') return handlePendingPayoutInsert(v);
          throw new Error(`unexpected insert on ${table}`);
        };
        return {
          onConflictDoNothing: (_opts?: unknown) => ({
            returning: async () => run(),
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              run().then(resolve, reject),
          }),
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            run().then(resolve, reject),
        };
      },
    };
  }

  function makeUpdate(t: unknown): Record<string, unknown> {
    const table = state.tableNameOf(t);
    return {
      set: (patch: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          const run = async (): Promise<unknown[]> => {
            if (table === 'vaultRedemptions') return handleVaultRedemptionUpdate(patch, condition);
            if (table === 'vaultHotFloat') {
              handleHotFloatUpdate(patch, condition);
              return [];
            }
            if (table === 'userCredits') {
              handleUserCreditsUpdate(patch, condition);
              return [];
            }
            throw new Error(`unexpected update on ${table}`);
          };
          return {
            returning: async () => run(),
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              run().then(resolve, reject),
          };
        },
      }),
    };
  }

  const mock: Record<string, unknown> = {
    select: () => makeSelect(),
    insert: (t: unknown) => makeInsert(t),
    update: (t: unknown) => makeUpdate(t),
    // Load-bearing (module header + task brief): a caught error inside
    // `cb` must roll back EVERY table this mock lets a transaction
    // touch, not just `vault_redemptions` — `payoutStep` composes a
    // `vault_hot_float` write with a `vault_redemptions` state-CAS in
    // ONE transaction, and `PayoutAlreadyLandedError` depends on the
    // float write rolling back together with the missed CAS.
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const snapshot = {
        redemptionRows: new Map(state.redemptionRows),
        hotFloatRows: new Map(state.hotFloatRows),
        userCreditsBalances: new Map(state.userCreditsBalances),
        creditTransactionInserts: [...state.creditTransactionInserts],
        pendingPayoutInserts: [...state.pendingPayoutInserts],
      };
      try {
        return await cb(mock);
      } catch (err) {
        state.redemptionRows = snapshot.redemptionRows;
        state.hotFloatRows = snapshot.hotFloatRows;
        state.userCreditsBalances = snapshot.userCreditsBalances;
        state.creditTransactionInserts = snapshot.creditTransactionInserts;
        state.pendingPayoutInserts = snapshot.pendingPayoutInserts;
        throw err;
      }
    },
  };
  return mock;
}

vi.mock('../../../db/client.js', () => ({
  db: buildDbMock(),
  withAdvisoryLock: async <T>(_key: bigint, fn: () => Promise<T>) => ({
    ran: true as const,
    value: await fn(),
  }),
}));

// ── vault-client (V2) mocks ─────────────────────────────────────────
const { vaultClientMocks } = vi.hoisted(() => ({
  vaultClientMocks: {
    transferShares: vi.fn(),
    withdrawFromVault: vi.fn(),
    readVaultState: vi.fn(),
    resolveOperatorPublicKey: vi.fn(),
  },
}));
vi.mock('../vault-client.js', () => ({
  transferShares: (...args: unknown[]) => vaultClientMocks.transferShares(...args),
  withdrawFromVault: (...args: unknown[]) => vaultClientMocks.withdrawFromVault(...args),
  readVaultState: (...args: unknown[]) => vaultClientMocks.readVaultState(...args),
  resolveOperatorPublicKey: () => vaultClientMocks.resolveOperatorPublicKey(),
}));

// ── registry (V1) mocks ──────────────────────────────────────────────
const { registryMocks } = vi.hoisted(() => ({
  registryMocks: {
    getActiveVault: vi.fn(),
    vaultsEnabled: vi.fn(() => true),
  },
}));
vi.mock('../registry.js', () => ({
  getActiveVault: (...args: unknown[]) => registryMocks.getActiveVault(...args),
  vaultsEnabled: () => registryMocks.vaultsEnabled(),
}));

// `vault-redemptions.ts` re-exports these three from `./vault-emissions.js`
// verbatim — mocking the whole module (rather than letting the re-export
// pass through to the real vault-emissions.ts) keeps this suite's import
// graph free of vault-emissions.ts's own dependencies.
vi.mock('../vault-emissions.js', () => ({
  isVaultEligibleCurrency: (currency: string) => currency === 'USD' || currency === 'EUR',
  vaultAssetForCurrency: (currency: string) => (currency === 'USD' ? 'LOOPUSD' : 'LOOPEUR'),
  currentVaultNetwork: () => 'testnet' as const,
}));

vi.mock('../../payout-builder.js', () => ({
  generatePayoutMemo: () => 'MEMOMEMOMEMOMEMOMEMO',
}));

const { discordMocks } = vi.hoisted(() => ({
  discordMocks: {
    notifyVaultRedemptionFailed: vi.fn((..._a: unknown[]) => undefined),
    notifyVaultRedemptionsStuck: vi.fn(async (..._a: unknown[]) => true),
  },
}));
vi.mock('../../../discord.js', () => ({
  notifyVaultRedemptionFailed: (...a: unknown[]) => discordMocks.notifyVaultRedemptionFailed(...a),
  notifyVaultRedemptionsStuck: (...a: unknown[]) => discordMocks.notifyVaultRedemptionsStuck(...a),
}));

const { walletMocks } = vi.hoisted(() => ({
  walletMocks: {
    getWalletProvider: vi.fn(),
  },
}));
vi.mock('../../../wallet/provider.js', () => ({
  getWalletProvider: () => walletMocks.getWalletProvider(),
}));

const { userMocks } = vi.hoisted(() => ({
  userMocks: {
    getUserById: vi.fn(),
  },
}));
vi.mock('../../../db/users.js', () => ({
  getUserById: (...args: unknown[]) => userMocks.getUserById(...args),
}));

const { transitionsMocks } = vi.hoisted(() => ({
  transitionsMocks: {
    markOrderPaidViaVaultRedemption: vi.fn(),
  },
}));
vi.mock('../../../orders/transitions.js', () => ({
  markOrderPaidViaVaultRedemption: (...args: unknown[]) =>
    transitionsMocks.markOrderPaidViaVaultRedemption(...args),
}));

import { getTableName, type Table } from 'drizzle-orm';
import {
  vaultRedemptions,
  vaultHotFloat,
  creditTransactions,
  userCredits,
  pendingPayouts,
} from '../../../db/schema.js';

state.tableNameOf = (t: unknown) => {
  if (t === vaultRedemptions) return 'vaultRedemptions';
  if (t === vaultHotFloat) return 'vaultHotFloat';
  if (t === creditTransactions) return 'creditTransactions';
  if (t === userCredits) return 'userCredits';
  if (t === pendingPayouts) return 'pendingPayouts';
  return getTableName(t as Table);
};

import {
  claimVaultRedemption,
  driveOneVaultRedemption,
  driveVaultRedemptionToCompletion,
  runVaultRedemptionSweepTick,
  VAULT_REDEMPTION_MAX_ATTEMPTS,
  type VaultRedemptionRow,
} from '../vault-redemptions.js';

const USER_ID = 'user-1';
const FAKE_PROVIDER = { name: 'privy' as const, createWallet: vi.fn(), rawSign: vi.fn() };

beforeEach(() => {
  state.reset();
  registryMocks.getActiveVault.mockReset();
  registryMocks.getActiveVault.mockResolvedValue(VAULT);
  registryMocks.vaultsEnabled.mockReset();
  registryMocks.vaultsEnabled.mockReturnValue(true);
  vaultClientMocks.transferShares.mockReset();
  vaultClientMocks.withdrawFromVault.mockReset();
  vaultClientMocks.readVaultState.mockReset();
  vaultClientMocks.readVaultState.mockResolvedValue({
    totalSupply: 1_000_000_000n,
    totalManaged: 1_000_000_000n,
    sharePricePpm: 1_000_000n, // 1:1
  });
  vaultClientMocks.resolveOperatorPublicKey.mockReset();
  vaultClientMocks.resolveOperatorPublicKey.mockReturnValue(OPERATOR_PUBLIC);
  discordMocks.notifyVaultRedemptionFailed.mockReset();
  discordMocks.notifyVaultRedemptionsStuck.mockReset();
  discordMocks.notifyVaultRedemptionsStuck.mockResolvedValue(true);
  walletMocks.getWalletProvider.mockReset();
  walletMocks.getWalletProvider.mockReturnValue(FAKE_PROVIDER);
  userMocks.getUserById.mockReset();
  userMocks.getUserById.mockImplementation(async (id: string) => ({
    id,
    walletId: 'wallet-xyz',
    walletAddress: USER_WALLET,
  }));
  transitionsMocks.markOrderPaidViaVaultRedemption.mockReset();
  transitionsMocks.markOrderPaidViaVaultRedemption.mockImplementation(
    async (_tx: unknown, orderId: string) => ({ id: orderId, state: 'paid' }),
  );
});

describe('claimVaultRedemption — idempotency claim', () => {
  it('creates a fresh pending row on first claim', async () => {
    const row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: 'order-1',
      userId: USER_ID,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: USER_WALLET,
    });
    expect(row.state).toBe('pending');
    expect(row.sourceId).toBe('order-1');
    expect(state.redemptionRows.size).toBe(1);
  });

  it('replay of the same (sourceType, sourceId) resolves to the SAME row — no second row created', async () => {
    const first = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: 'order-1',
      userId: USER_ID,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: USER_WALLET,
    });
    const second = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: 'order-1',
      userId: USER_ID,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: USER_WALLET,
    });
    expect(second.id).toBe(first.id);
    expect(state.redemptionRows.size).toBe(1);
  });
});

describe('driveOneVaultRedemption — happy path FAST (hot float) redemption', () => {
  it('advances pending -> collecting -> redeemed(fast) -> settled, conserving the mirror and drawing the float atomically', async () => {
    vaultClientMocks.transferShares.mockResolvedValue({ txHash: 'collect-tx-1', deduped: false });
    state.seedFloat('LOOPUSD', 'testnet', 10_000n, 0n);

    const row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: 'order-1',
      userId: USER_ID,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: USER_WALLET,
    });
    const outcome = await driveOneVaultRedemption(row);

    expect(outcome).toBe('settled');
    const final = state.redemptionRows.get(row.id)!;
    expect(final.state).toBe('settled');
    expect(final.payoutPath).toBe('fast');
    expect(final.collectTxHash).toBe('collect-tx-1');
    expect(final.redeemTxHash).toBeNull(); // fast path never sets this
    expect(final.sharesToRedeem).not.toBeNull();
    expect(final.sharesToRedeem! > 0n).toBe(true);
    expect(final.settledAt).not.toBeNull();

    // Mirror conserved: exactly a 500-minor debit, one spend row, one
    // burn audit row (the SAME primitive orders/transitions.ts already
    // writes for classic-asset redemptions — ADR 036).
    expect(state.userCreditsBalances.get(`${USER_ID}:USD`)).toBe(-500n);
    expect(state.creditTransactionInserts).toHaveLength(1);
    expect(state.creditTransactionInserts[0]).toMatchObject({
      type: 'spend',
      amountMinor: -500n,
      currency: 'USD',
      referenceType: 'order',
      referenceId: 'order-1',
    });
    expect(state.pendingPayoutInserts).toHaveLength(1);
    expect(state.pendingPayoutInserts[0]).toMatchObject({
      userId: USER_ID,
      orderId: 'order-1',
      kind: 'burn',
      assetCode: 'LOOPUSD',
      assetIssuer: SHARE_CONTRACT_ID,
      amountStroops: 500n * 100_000n,
      state: 'confirmed',
      txHash: 'collect-tx-1',
    });

    // markOrderPaidViaVaultRedemption called exactly once, with this order's id.
    expect(transitionsMocks.markOrderPaidViaVaultRedemption).toHaveBeenCalledTimes(1);
    expect(transitionsMocks.markOrderPaidViaVaultRedemption).toHaveBeenCalledWith(
      expect.anything(),
      'order-1',
    );

    // Float: balance decreased by EXACTLY valueMinor, pending shares
    // increased by EXACTLY sharesToRedeem — in the SAME atomic update
    // (scenario 8 — see the dedicated test below for the isolated claim).
    const float = state.hotFloatRows.get('LOOPUSD:testnet')!;
    expect(float.balanceMinor).toBe(10_000n - 500n);
    expect(float.pendingUnredeemedShares).toBe(final.sharesToRedeem);

    // The fast path never calls the slow on-chain withdraw.
    expect(vaultClientMocks.withdrawFromVault).not.toHaveBeenCalled();
  });

  it('the float draw + pending-shares bookkeeping lands in ONE atomic update (not two writes a crash could split)', async () => {
    vaultClientMocks.transferShares.mockResolvedValue({ txHash: 'collect-tx-8', deduped: false });
    state.seedFloat('LOOPUSD', 'testnet', 5_000n, 100n);

    const row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: 'order-8',
      userId: USER_ID,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 300n,
      fromAddress: USER_WALLET,
    });
    const outcome = await driveOneVaultRedemption(row);
    expect(outcome).toBe('settled');

    const final = state.redemptionRows.get(row.id)!;
    const float = state.hotFloatRows.get('LOOPUSD:testnet')!;
    // Both fields moved together, from their pre-existing values.
    expect(float.balanceMinor).toBe(5_000n - 300n);
    expect(float.pendingUnredeemedShares).toBe(100n + final.sharesToRedeem!);
  });
});

describe('driveOneVaultRedemption — happy path SLOW (synchronous vault.withdraw) redemption', () => {
  it('when the float cannot cover it, drives withdrawFromVault, credits the NET proceeds into the float, and settles', async () => {
    vaultClientMocks.transferShares.mockResolvedValue({ txHash: 'collect-tx-2', deduped: false });
    // amountsOut = 520 minor worth of stroops against a 500-minor
    // valueMinor -> netFloatDelta = +20 minor credited to the float.
    vaultClientMocks.withdrawFromVault.mockImplementation(
      async (args: { minAmountsOut: bigint; onSigned: (h: string) => Promise<void> | void }) => {
        // Fast attempt must have already tried and failed BEFORE this is
        // ever called — the float is still untouched (0 balance) at
        // this point, proving the fast branch was attempted first
        // (scenario 9).
        expect(state.hotFloatRows.get('LOOPUSD:testnet')?.balanceMinor ?? 0n).toBe(0n);
        expect(args.minAmountsOut).toBe(500n * 100_000n);
        // CF-18: the real withdrawFromVault persists the hash via
        // onSigned BEFORE returning — mirror that here so payoutStep's
        // final update actually has a redeemTxHash to preserve.
        await args.onSigned('withdraw-tx-1');
        return { txHash: 'withdraw-tx-1', amountsOut: [520n * 100_000n], deduped: false };
      },
    );

    const row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: 'order-2',
      userId: USER_ID,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: USER_WALLET,
    });
    const outcome = await driveOneVaultRedemption(row);

    expect(outcome).toBe('settled');
    const final = state.redemptionRows.get(row.id)!;
    expect(final.payoutPath).toBe('slow');
    expect(final.redeemTxHash).toBe('withdraw-tx-1');
    expect(final.settledAt).not.toBeNull();

    const float = state.hotFloatRows.get('LOOPUSD:testnet')!;
    expect(float.balanceMinor).toBe(20n); // net proceeds credited
    expect(float.pendingUnredeemedShares).toBe(0n); // slow path never adds pending shares

    expect(vaultClientMocks.transferShares).toHaveBeenCalledTimes(1);
    expect(vaultClientMocks.withdrawFromVault).toHaveBeenCalledTimes(1);
  });
});

describe('driveOneVaultRedemption — replay / idempotency', () => {
  it('driving an already-settled row is a no-op (no second collect, payout, or mirror)', async () => {
    const row = state.seedRow({
      sourceType: 'order_redeem',
      sourceId: 'order-3',
      userId: USER_ID,
      valueMinor: 500n,
      fromAddress: USER_WALLET,
      state: 'settled',
      sharesToRedeem: 500_000n,
      collectTxHash: 'collect-tx-3',
      collectedAt: new Date(),
      payoutPath: 'fast',
      redeemedAt: new Date(),
      settledAt: new Date(),
      pendingPayoutId: 'pp-prior',
    });

    const outcome = await driveOneVaultRedemption(row as unknown as VaultRedemptionRow);

    expect(outcome).toBe('settled');
    expect(vaultClientMocks.transferShares).not.toHaveBeenCalled();
    expect(vaultClientMocks.withdrawFromVault).not.toHaveBeenCalled();
    expect(state.creditTransactionInserts).toHaveLength(0);
    expect(state.pendingPayoutInserts).toHaveLength(0);
    expect(transitionsMocks.markOrderPaidViaVaultRedemption).not.toHaveBeenCalled();
  });
});

describe('driveOneVaultRedemption — resume behavior (CF-18 / crash recovery)', () => {
  it('a row already collecting with collectTxHash set resumes at pay, does NOT re-collect', async () => {
    state.seedFloat('LOOPUSD', 'testnet', 10_000n, 0n);
    const row = state.seedRow({
      sourceType: 'order_redeem',
      sourceId: 'order-4',
      userId: USER_ID,
      valueMinor: 200n,
      fromAddress: USER_WALLET,
      state: 'collecting',
      sharesToRedeem: 199_000n,
      collectTxHash: 'collect-tx-prior-4',
      collectedAt: new Date(),
    });

    const outcome = await driveOneVaultRedemption(row as unknown as VaultRedemptionRow);

    expect(outcome).toBe('settled');
    expect(vaultClientMocks.transferShares).not.toHaveBeenCalled();
    const float = state.hotFloatRows.get('LOOPUSD:testnet')!;
    expect(float.balanceMinor).toBe(10_000n - 200n);
  });

  it('a row already redeemed(fast) resumes at mirror only — no re-collect, no re-pay, float untouched', async () => {
    const row = state.seedRow({
      sourceType: 'order_redeem',
      sourceId: 'order-5',
      userId: USER_ID,
      valueMinor: 250n,
      fromAddress: USER_WALLET,
      state: 'redeemed',
      sharesToRedeem: 249_000n,
      collectTxHash: 'collect-tx-prior-5',
      collectedAt: new Date(),
      payoutPath: 'fast',
      redeemedAt: new Date(),
    });

    const outcome = await driveOneVaultRedemption(row as unknown as VaultRedemptionRow);

    expect(outcome).toBe('settled');
    expect(vaultClientMocks.transferShares).not.toHaveBeenCalled();
    expect(vaultClientMocks.withdrawFromVault).not.toHaveBeenCalled();
    // No float row was ever created — payoutStep is never re-entered.
    expect(state.hotFloatRows.has('LOOPUSD:testnet')).toBe(false);

    expect(state.creditTransactionInserts).toHaveLength(1);
    expect(state.pendingPayoutInserts).toHaveLength(1);
    expect(transitionsMocks.markOrderPaidViaVaultRedemption).toHaveBeenCalledTimes(1);
    const final = state.redemptionRows.get(row.id)!;
    expect(final.state).toBe('settled');
  });
});

describe('driveOneVaultRedemption — INV-V2 (payout never lands below valueMinor)', () => {
  it('a slow-path withdrawFromVault failure (e.g. a slippage floor violation) is recorded as a retryable step failure, never marked redeemed', async () => {
    vaultClientMocks.transferShares.mockResolvedValue({ txHash: 'collect-tx-6', deduped: false });
    // Float stays empty (0) so the fast attempt is skipped and the
    // slow path is the only one exercised.
    vaultClientMocks.withdrawFromVault.mockRejectedValue(
      new Error('withdrawFromVault: chain returned less than minAmountsOut — the tx LANDED'),
    );

    const row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: 'order-6',
      userId: USER_ID,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: USER_WALLET,
    });
    const outcome = await driveOneVaultRedemption(row);

    expect(outcome).toBe('collecting'); // non-terminal, resumable
    const final = state.redemptionRows.get(row.id)!;
    expect(final.state).toBe('collecting');
    expect(final.attempts).toBe(1);
    expect(final.lastError).toContain('minAmountsOut');
    expect(final.payoutPath).toBeNull();
    expect(final.redeemedAt).toBeNull();
    expect(final.settledAt).toBeNull();
  });
});

describe('driveOneVaultRedemption — atomic rollback on a missed payout CAS (P7, the core correctness property)', () => {
  it("when a concurrent driver already landed the payout, the SAME attempt's float draw rolls back — no double-draw", async () => {
    state.seedFloat('LOOPUSD', 'testnet', 10_000n, 0n);
    const sharesToRedeem = 495_000n;
    const readyRow = state.seedRow({
      sourceType: 'order_redeem',
      sourceId: 'order-7',
      userId: USER_ID,
      valueMinor: 500n,
      fromAddress: USER_WALLET,
      state: 'collecting',
      sharesToRedeem,
      collectTxHash: 'collect-tx-7',
      collectedAt: new Date(),
    });
    // A STALE snapshot of the row as it looked right before the first
    // driver's payout landed — what a second, concurrent driver (the
    // HTTP inline drive racing the background sweep — both are
    // legitimately allowed to call driveOneVaultRedemption on the same
    // row per the module header) would still be holding.
    const staleSnapshot = { ...state.redemptionRows.get(readyRow.id)! };

    // First driver: lands the fast-path payout + mirrors -> settled.
    const first = await driveOneVaultRedemption(readyRow as unknown as VaultRedemptionRow);
    expect(first).toBe('settled');
    const floatAfterFirst = state.hotFloatRows.get('LOOPUSD:testnet')!;
    expect(floatAfterFirst.balanceMinor).toBe(10_000n - 500n);
    expect(floatAfterFirst.pendingUnredeemedShares).toBe(sharesToRedeem);

    // Second driver races on the STALE snapshot (still shows
    // state='collecting', collectTxHash already set) — it skips
    // re-collecting (collectTxHash present) and goes straight into
    // payoutStep's fast branch, which draws the float FIRST, then
    // finds the guarded `WHERE state='collecting'` update matches
    // ZERO rows (the row is really already 'settled') — this MUST
    // throw PayoutAlreadyLandedError and roll the float draw back
    // together with the missed transition, not commit a double-draw.
    const second = await driveOneVaultRedemption(staleSnapshot as unknown as VaultRedemptionRow);
    expect(second).toBe('settled'); // re-reads the real, already-settled row

    const floatAfterSecond = state.hotFloatRows.get('LOOPUSD:testnet')!;
    expect(floatAfterSecond.balanceMinor).toBe(10_000n - 500n); // NOT 10_000n - 1_000n
    expect(floatAfterSecond.pendingUnredeemedShares).toBe(sharesToRedeem); // NOT doubled

    // No second mirror ran either.
    expect(state.creditTransactionInserts).toHaveLength(1);
    expect(state.pendingPayoutInserts).toHaveLength(1);
    expect(transitionsMocks.markOrderPaidViaVaultRedemption).toHaveBeenCalledTimes(1);
    // transferShares/withdrawFromVault were never re-invoked on either pass.
    expect(vaultClientMocks.transferShares).not.toHaveBeenCalled();
    expect(vaultClientMocks.withdrawFromVault).not.toHaveBeenCalled();
  });
});

describe('computeSharesToRedeem — ADR 031 §D6 step 2 buffer', () => {
  it('computes a sharesToRedeem strictly greater than the naive (unbuffered) share count at the current price', async () => {
    vaultClientMocks.readVaultState.mockResolvedValue({
      totalSupply: 1_000_000_000n,
      totalManaged: 1_000_000_000n,
      sharePricePpm: 1_000_000n, // 1:1
    });
    vaultClientMocks.transferShares.mockResolvedValue({ txHash: 'collect-tx-11', deduped: false });
    state.seedFloat('LOOPUSD', 'testnet', 10_000n, 0n);

    const valueMinor = 500n;
    const row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: 'order-11',
      userId: USER_ID,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor,
      fromAddress: USER_WALLET,
    });
    const outcome = await driveOneVaultRedemption(row);
    expect(outcome).toBe('settled');

    const final = state.redemptionRows.get(row.id)!;
    const STROOPS_PER_MINOR = 100_000n;
    const naiveShares = (valueMinor * STROOPS_PER_MINOR * 1_000_000n) / 1_000_000n; // sharePricePpm 1:1
    const expectedBuffered = naiveShares + (naiveShares * 50n) / 10_000n; // REDEMPTION_SHARE_BUFFER_BPS = 50 (0.5%)

    expect(final.sharesToRedeem).toBe(expectedBuffered);
    expect(final.sharesToRedeem! > naiveShares).toBe(true);
  });
});

describe('driveOneVaultRedemption — terminal failure + Discord paging', () => {
  it(`moves to failed after VAULT_REDEMPTION_MAX_ATTEMPTS (${VAULT_REDEMPTION_MAX_ATTEMPTS}) consecutive failures, paging Discord exactly once on the terminal transition`, async () => {
    vaultClientMocks.transferShares.mockRejectedValue(new Error('persistent collect failure'));

    let row: VaultRedemptionRow = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: 'order-12',
      userId: USER_ID,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: USER_WALLET,
    });

    for (let i = 0; i < VAULT_REDEMPTION_MAX_ATTEMPTS; i++) {
      const outcome = await driveOneVaultRedemption(row);
      row = state.redemptionRows.get(row.id)! as unknown as VaultRedemptionRow;
      if (i < VAULT_REDEMPTION_MAX_ATTEMPTS - 1) {
        expect(outcome).toBe('collecting');
        expect(discordMocks.notifyVaultRedemptionFailed).not.toHaveBeenCalled();
      } else {
        expect(outcome).toBe('failed');
      }
    }

    const final = state.redemptionRows.get(row.id)!;
    expect(final.state).toBe('failed');
    expect(final.attempts).toBe(VAULT_REDEMPTION_MAX_ATTEMPTS);
    expect(final.failedAt).not.toBeNull();
    expect(discordMocks.notifyVaultRedemptionFailed).toHaveBeenCalledTimes(1);
    expect(discordMocks.notifyVaultRedemptionFailed).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'order-12', attempts: VAULT_REDEMPTION_MAX_ATTEMPTS }),
    );
  });
});

describe('driveOneVaultRedemption — gated off', () => {
  it("returns 'no_vault' and touches nothing when no active vault is registered", async () => {
    registryMocks.getActiveVault.mockResolvedValue(null);
    const row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: 'order-10',
      userId: USER_ID,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: USER_WALLET,
    });
    const outcome = await driveOneVaultRedemption(row);

    expect(outcome).toBe('no_vault');
    expect(vaultClientMocks.transferShares).not.toHaveBeenCalled();
    expect(vaultClientMocks.withdrawFromVault).not.toHaveBeenCalled();
    expect(state.redemptionRows.get(row.id)?.state).toBe('pending');
  });
});

describe('driveVaultRedemptionToCompletion', () => {
  it('settles a fresh fast-path row within the default step budget', async () => {
    vaultClientMocks.transferShares.mockResolvedValue({ txHash: 'collect-tx-9', deduped: false });
    state.seedFloat('LOOPUSD', 'testnet', 10_000n, 0n);

    const row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: 'order-9',
      userId: USER_ID,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: USER_WALLET,
    });
    const final = await driveVaultRedemptionToCompletion(row);
    expect(final.state).toBe('settled');
  });
});

describe('runVaultRedemptionSweepTick', () => {
  it('does nothing when vaultsEnabled() is false, even with queued rows', async () => {
    registryMocks.vaultsEnabled.mockReturnValue(false);
    state.seedRow({
      sourceType: 'order_redeem',
      sourceId: 'order-a',
      userId: USER_ID,
      valueMinor: 500n,
      fromAddress: USER_WALLET,
      state: 'pending',
    });

    const result = await runVaultRedemptionSweepTick();

    expect(result.considered).toBe(0);
    expect(vaultClientMocks.transferShares).not.toHaveBeenCalled();
    expect([...state.redemptionRows.values()][0]?.state).toBe('pending');
  });

  it('drives queued rows in different states sequentially and tallies considered/settled/advanced/failed correctly', async () => {
    state.seedFloat('LOOPUSD', 'testnet', 10_000n, 0n);

    // Row A: fresh pending — will fully settle via the fast path.
    const rowA = state.seedRow({
      sourceType: 'order_redeem',
      sourceId: 'order-a',
      userId: USER_ID,
      valueMinor: 500n,
      fromAddress: USER_WALLET,
      state: 'pending',
      createdAt: new Date(Date.now() - 3_000),
    });
    // Row B: already collecting + ready to pay — resumes straight to settled.
    state.seedRow({
      sourceType: 'order_redeem',
      sourceId: 'order-b',
      userId: USER_ID,
      valueMinor: 200n,
      fromAddress: USER_WALLET,
      state: 'collecting',
      sharesToRedeem: 199_000n,
      collectTxHash: 'collect-tx-prior-b',
      collectedAt: new Date(),
      createdAt: new Date(Date.now() - 2_000),
    });
    // Row C: pending, already at MAX_ATTEMPTS-1 — its collect is forced
    // to fail (matched by its own deterministic computed share count,
    // via valueMinor=999n), so this ONE more failure moves it terminal.
    const failValueMinor = 999n;
    const STROOPS_PER_MINOR = 100_000n;
    const naiveShares = (failValueMinor * STROOPS_PER_MINOR * 1_000_000n) / 1_000_000n;
    const failShares = naiveShares + (naiveShares * 50n) / 10_000n;
    state.seedRow({
      sourceType: 'order_redeem',
      sourceId: 'order-c',
      userId: USER_ID,
      valueMinor: failValueMinor,
      fromAddress: USER_WALLET,
      state: 'pending',
      attempts: VAULT_REDEMPTION_MAX_ATTEMPTS - 1,
      createdAt: new Date(Date.now() - 1_000),
    });

    vaultClientMocks.transferShares.mockImplementation(async (args: { amount: bigint }) => {
      if (args.amount === failShares) throw new Error('forced sweep collect failure');
      return { txHash: 'sweep-collect', deduped: false };
    });

    const result = await runVaultRedemptionSweepTick();

    expect(result.considered).toBe(3);
    expect(result.settled).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.advanced).toBe(0);
    expect(result.errors).toBe(0);

    expect(state.redemptionRows.get(rowA.id)?.state).toBe('settled');
    const rowCFinal = [...state.redemptionRows.values()].find((r) => r.sourceId === 'order-c')!;
    expect(rowCFinal.state).toBe('failed');
    expect(rowCFinal.attempts).toBe(VAULT_REDEMPTION_MAX_ATTEMPTS);
  });
});
