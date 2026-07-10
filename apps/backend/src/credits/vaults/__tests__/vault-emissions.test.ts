import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR 031 §D5 (V3) — vault cashback-emission state machine.
 *
 * Mocks the V2 vault client (`depositToVault` / `transferShares` /
 * `readVaultState` / `resolveOperatorPublicKey`) and the V1 registry
 * (`getActiveVault` / `vaultsEnabled` / `recordSharePriceSnapshot`) —
 * no network. `db/client.js` is a table-routed mock (mirrors
 * `credits/__tests__/interest-mint.test.ts`'s harness) covering
 * `.select()` / `.insert()` / `.update()` / `.transaction()`.
 *
 * What this suite proves: the state-machine transitions, the
 * idempotency claim, INV-V1 (transfer amount == this row's own
 * sharesMinted), the mirror step's shape (credit_transactions +
 * user_credits + the `pending_payouts kind='emission'` audit row —
 * the row the REAL `assert_emission_conservation` trigger would
 * check), and the crash-recovery resume behavior at each step.
 *
 * What it does NOT prove: that the real Postgres trigger actually
 * rejects an unbacked mint, or that the real
 * `credit_transactions_reference_unique` / `vault_emissions_order_unique`
 * constraints fire as real `23505`s under concurrency — that's
 * `__tests__/integration/vault-emissions.test.ts` (real postgres).
 */

vi.mock('../../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { Keypair, Address } from '@stellar/stellar-sdk';

// Real strkey-shaped fixtures (56 chars, correct checksum) — this
// mock harness doesn't validate shape, but real-looking addresses
// avoid misleading a future reader (the real DB CHECK constraints DO
// validate — see the integration suite).
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

function makeDrizzleUniqueViolation(constraintName: string): Error {
  const cause = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint_name: constraintName,
  });
  return Object.assign(new Error('Failed query: insert into "credit_transactions" ...'), {
    cause,
  });
}

// ── table-routed chainable db mock ──────────────────────────────────
const { state } = vi.hoisted(() => {
  interface VaultEmissionRowLike {
    id: string;
    orderId: string;
    userId: string;
    assetCode: string;
    network: string;
    cashbackMinor: bigint;
    toAddress: string;
    state: string;
    minSharesUsed: bigint | null;
    depositTxHash: string | null;
    sharesMinted: bigint | null;
    transferTxHash: string | null;
    pendingPayoutId: string | null;
    attempts: number;
    lastError: string | null;
    createdAt: Date;
    depositedAt: Date | null;
    transferredAt: Date | null;
    mirroredAt: Date | null;
    failedAt: Date | null;
  }

  const s = {
    vaultEmissionRows: new Map<string, VaultEmissionRowLike>(),
    nextId: 1,
    userCreditsBalances: new Map<string, bigint>(), // key: `${userId}:${currency}`
    creditTransactionInserts: [] as Array<Record<string, unknown>>,
    creditTransactionKeys: new Set<string>(), // `${type}:${referenceType}:${referenceId}`
    pendingPayoutInserts: [] as Array<Record<string, unknown>>,
    /** Injects a unique-violation on the NEXT credit_transactions insert. */
    creditInsertError: null as unknown,
    advisoryAcquired: true,
    tableNameOf: (_t: unknown): string => '',
    reset(): void {
      s.vaultEmissionRows.clear();
      s.nextId = 1;
      s.userCreditsBalances.clear();
      s.creditTransactionInserts = [];
      s.creditTransactionKeys.clear();
      s.pendingPayoutInserts = [];
      s.creditInsertError = null;
      s.advisoryAcquired = true;
    },
    seedRow(
      row: Partial<VaultEmissionRowLike> & { orderId: string; userId: string },
    ): VaultEmissionRowLike {
      const id = row.id ?? `vem-${s.nextId++}`;
      const full: VaultEmissionRowLike = {
        id,
        orderId: row.orderId,
        userId: row.userId,
        assetCode: row.assetCode ?? 'LOOPUSD',
        network: row.network ?? 'testnet',
        cashbackMinor: row.cashbackMinor ?? 500n,
        toAddress: row.toAddress ?? USER_WALLET,
        state: row.state ?? 'pending',
        minSharesUsed: row.minSharesUsed ?? null,
        depositTxHash: row.depositTxHash ?? null,
        sharesMinted: row.sharesMinted ?? null,
        transferTxHash: row.transferTxHash ?? null,
        pendingPayoutId: row.pendingPayoutId ?? null,
        attempts: row.attempts ?? 0,
        lastError: row.lastError ?? null,
        createdAt: row.createdAt ?? new Date(),
        depositedAt: row.depositedAt ?? null,
        transferredAt: row.transferredAt ?? null,
        mirroredAt: row.mirroredAt ?? null,
        failedAt: row.failedAt ?? null,
      };
      s.vaultEmissionRows.set(id, full);
      return full;
    },
  };
  return { state: s };
});

function extractEqValue(condition: unknown): string {
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) throw new Error('extractEqValue: not an eq() condition');
  // `eq(col, value)` shape: [StringChunk, Column, StringChunk, Param, StringChunk] —
  // the compared value is wrapped in a drizzle `Param` (`.value`), not a bare string.
  const raw = chunks[3] as { value?: unknown } | string | undefined;
  const value = typeof raw === 'string' ? raw : raw?.value;
  if (typeof value !== 'string') {
    throw new Error('extractEqValue: unexpected condition shape');
  }
  return value;
}

function buildDbMock(): Record<string, unknown> {
  function handleVaultEmissionUpdate(
    patch: Record<string, unknown>,
    condition: unknown,
  ): unknown[] {
    const id = extractEqValue(condition);
    const existing = state.vaultEmissionRows.get(id);
    if (existing === undefined) return [];
    const updated = { ...existing, ...patch };
    state.vaultEmissionRows.set(id, updated);
    return [updated];
  }

  function handleVaultEmissionClaim(v: Record<string, unknown>): Array<{ id: string }> {
    const orderId = v['orderId'] as string;
    const conflict = [...state.vaultEmissionRows.values()].some((r) => r.orderId === orderId);
    if (conflict) return [];
    const row = state.seedRow({
      orderId,
      userId: v['userId'] as string,
      assetCode: v['assetCode'] as string,
      network: v['network'] as string,
      cashbackMinor: v['cashbackMinor'] as bigint,
      toAddress: v['toAddress'] as string,
      state: (v['state'] as string) ?? 'pending',
    });
    return [{ id: row.id }];
  }

  function handleCreditTransactionInsert(v: Record<string, unknown>): void {
    if (state.creditInsertError !== null) {
      const err = state.creditInsertError;
      state.creditInsertError = null;
      throw err;
    }
    const key = `${String(v['type'])}:${String(v['referenceType'])}:${String(v['referenceId'])}`;
    if (state.creditTransactionKeys.has(key)) {
      throw makeDrizzleUniqueViolation('credit_transactions_reference_unique');
    }
    state.creditTransactionKeys.add(key);
    state.creditTransactionInserts.push(v);
  }

  function handleUserCreditsUpsert(v: Record<string, unknown>): void {
    const key = `${String(v['userId'])}:${String(v['currency'])}`;
    const prev = state.userCreditsBalances.get(key) ?? 0n;
    state.userCreditsBalances.set(key, prev + (v['balanceMinor'] as bigint));
  }

  function handlePendingPayoutInsert(v: Record<string, unknown>): Array<{ id: string }> {
    const id = `pp-${state.pendingPayoutInserts.length + 1}`;
    state.pendingPayoutInserts.push(v);
    return [{ id }];
  }

  function makeSelect(): Record<string, unknown> {
    let table = '';
    const chain: Record<string, unknown> = {};
    chain['from'] = (t: unknown) => {
      table = state.tableNameOf(t);
      return chain;
    };
    chain['where'] = () => ({
      for: () => ({
        then: (resolve: (v: unknown) => unknown) => resolve([]),
      }),
      orderBy: () => ({
        limit: async () => {
          if (table !== 'vaultEmissions') throw new Error(`unexpected sweep select on ${table}`);
          return [...state.vaultEmissionRows.values()]
            .filter(
              (r) => r.state === 'pending' || r.state === 'deposited' || r.state === 'transferred',
            )
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        },
      }),
      then: (resolve: (v: unknown) => unknown) => resolve([]),
    });
    return chain;
  }

  function makeInsert(t: unknown): Record<string, unknown> {
    const table = state.tableNameOf(t);
    return {
      values: (v: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table !== 'vaultEmissions')
              throw new Error(`unexpected conflict-insert on ${table}`);
            return handleVaultEmissionClaim(v);
          },
        }),
        onConflictDoUpdate: async () => {
          if (table !== 'userCredits') throw new Error(`unexpected upsert on ${table}`);
          handleUserCreditsUpsert(v);
        },
        returning: async () => {
          if (table !== 'pendingPayouts')
            throw new Error(`unexpected .returning() insert on ${table}`);
          return handlePendingPayoutInsert(v);
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve()
            .then(() => {
              if (table === 'creditTransactions') return handleCreditTransactionInsert(v);
              throw new Error(`unexpected plain insert on ${table}`);
            })
            .then(resolve, reject),
      }),
    };
  }

  function makeUpdate(t: unknown): Record<string, unknown> {
    const table = state.tableNameOf(t);
    return {
      set: (patch: Record<string, unknown>) => ({
        where: (condition: unknown) => ({
          returning: async () => {
            if (table !== 'vaultEmissions') throw new Error(`unexpected update on ${table}`);
            return handleVaultEmissionUpdate(patch, condition);
          },
        }),
      }),
    };
  }

  const mock: Record<string, unknown> = {
    select: () => makeSelect(),
    insert: (t: unknown) => makeInsert(t),
    update: (t: unknown) => makeUpdate(t),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const marks = {
        credit: state.creditTransactionInserts.length,
        payout: state.pendingPayoutInserts.length,
        balances: new Map(state.userCreditsBalances),
      };
      try {
        return await cb(mock);
      } catch (err) {
        state.creditTransactionInserts.length = marks.credit;
        state.pendingPayoutInserts.length = marks.payout;
        state.userCreditsBalances = marks.balances;
        throw err;
      }
    },
  };
  return mock;
}

vi.mock('../../../db/client.js', () => ({
  db: buildDbMock(),
  withAdvisoryLock: async <T>(_key: bigint, fn: () => Promise<T>) =>
    state.advisoryAcquired ? { ran: true as const, value: await fn() } : { ran: false as const },
}));

// ── vault-client (V2) mocks ─────────────────────────────────────────
const { vaultClientMocks } = vi.hoisted(() => ({
  vaultClientMocks: {
    depositToVault: vi.fn(),
    transferShares: vi.fn(),
    readVaultState: vi.fn(),
    resolveOperatorPublicKey: vi.fn(() => OPERATOR_PUBLIC),
  },
}));
vi.mock('../vault-client.js', () => ({
  depositToVault: (...args: unknown[]) => vaultClientMocks.depositToVault(...args),
  transferShares: (...args: unknown[]) => vaultClientMocks.transferShares(...args),
  readVaultState: (...args: unknown[]) => vaultClientMocks.readVaultState(...args),
  resolveOperatorPublicKey: () => vaultClientMocks.resolveOperatorPublicKey(),
}));

// ── registry (V1) mocks ──────────────────────────────────────────────
const { registryMocks } = vi.hoisted(() => ({
  registryMocks: {
    getActiveVault: vi.fn(),
    vaultsEnabled: vi.fn(() => true),
    recordSharePriceSnapshot: vi.fn(async (..._args: unknown[]) => {}),
  },
}));
vi.mock('../registry.js', () => ({
  getActiveVault: (...args: unknown[]) => registryMocks.getActiveVault(...args),
  vaultsEnabled: () => registryMocks.vaultsEnabled(),
  recordSharePriceSnapshot: (...args: unknown[]) => registryMocks.recordSharePriceSnapshot(...args),
}));

vi.mock('../../payout-builder.js', () => ({
  generatePayoutMemo: () => 'MEMOMEMOMEMOMEMOMEMO',
}));

vi.mock('../../../runtime-health.js', () => ({
  markWorkerStarted: vi.fn(),
  markWorkerStopped: vi.fn(),
  markWorkerTickSuccess: vi.fn(),
  markWorkerTickFailure: vi.fn(),
}));

import { getTableName, type Table } from 'drizzle-orm';
import {
  vaultEmissions,
  creditTransactions,
  userCredits,
  pendingPayouts,
} from '../../../db/schema.js';

state.tableNameOf = (t: unknown) => {
  if (t === vaultEmissions) return 'vaultEmissions';
  if (t === creditTransactions) return 'creditTransactions';
  if (t === userCredits) return 'userCredits';
  if (t === pendingPayouts) return 'pendingPayouts';
  return getTableName(t as Table);
};

import {
  claimVaultEmission,
  driveOneVaultEmission,
  runVaultEmissionSweepTick,
  vaultAssetForCurrency,
  isVaultEligibleCurrency,
  type VaultEmissionRow,
} from '../vault-emissions.js';
import { db } from '../../../db/client.js';

const ORDER_ID = 'order-1';
const USER_ID = 'user-1';

beforeEach(() => {
  state.reset();
  registryMocks.getActiveVault.mockReset();
  registryMocks.getActiveVault.mockResolvedValue(VAULT);
  registryMocks.vaultsEnabled.mockReset();
  registryMocks.vaultsEnabled.mockReturnValue(true);
  registryMocks.recordSharePriceSnapshot.mockReset();
  registryMocks.recordSharePriceSnapshot.mockResolvedValue(undefined);
  vaultClientMocks.depositToVault.mockReset();
  vaultClientMocks.transferShares.mockReset();
  vaultClientMocks.readVaultState.mockReset();
  vaultClientMocks.readVaultState.mockResolvedValue({
    totalSupply: 1_000_000_000n,
    totalManaged: 1_000_000_000n,
    sharePricePpm: 1_000_000n, // 1:1
  });
  vaultClientMocks.resolveOperatorPublicKey.mockReset();
  vaultClientMocks.resolveOperatorPublicKey.mockReturnValue(OPERATOR_PUBLIC);
});

describe('vaultAssetForCurrency / isVaultEligibleCurrency', () => {
  it('maps USD -> LOOPUSD and EUR -> LOOPEUR', () => {
    expect(vaultAssetForCurrency('USD')).toBe('LOOPUSD');
    expect(vaultAssetForCurrency('EUR')).toBe('LOOPEUR');
  });
  it('accepts only USD/EUR as vault-eligible', () => {
    expect(isVaultEligibleCurrency('USD')).toBe(true);
    expect(isVaultEligibleCurrency('EUR')).toBe(true);
    expect(isVaultEligibleCurrency('GBP')).toBe(false);
  });
});

describe('claimVaultEmission — idempotency claim', () => {
  it('creates a fresh pending row on first claim', async () => {
    const claimed = await claimVaultEmission(db as never, {
      orderId: ORDER_ID,
      userId: USER_ID,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      cashbackMinor: 500n,
      toAddress: USER_WALLET,
    });
    expect(claimed).toBe(true);
    expect(state.vaultEmissionRows.size).toBe(1);
    const [row] = [...state.vaultEmissionRows.values()];
    expect(row?.state).toBe('pending');
    expect(row?.orderId).toBe(ORDER_ID);
  });

  it('replay of the same order id does NOT create a second row (no second deposit is even possible)', async () => {
    await claimVaultEmission(db as never, {
      orderId: ORDER_ID,
      userId: USER_ID,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      cashbackMinor: 500n,
      toAddress: USER_WALLET,
    });
    const secondClaim = await claimVaultEmission(db as never, {
      orderId: ORDER_ID,
      userId: USER_ID,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      cashbackMinor: 500n,
      toAddress: USER_WALLET,
    });
    expect(secondClaim).toBe(false);
    expect(state.vaultEmissionRows.size).toBe(1);
  });
});

describe('driveOneVaultEmission — happy path', () => {
  it('advances pending -> deposited -> transferred -> mirrored, conserving the mirror + writing the conservation-trigger audit row', async () => {
    vaultClientMocks.depositToVault.mockResolvedValue({
      txHash: 'deposit-tx-1',
      sharesMinted: 490n,
      amountsUsed: [500n * 100_000n],
      deduped: false,
    });
    vaultClientMocks.transferShares.mockResolvedValue({ txHash: 'transfer-tx-1', deduped: false });

    const row = state.seedRow({ orderId: ORDER_ID, userId: USER_ID, cashbackMinor: 500n });
    const outcome = await driveOneVaultEmission(row as unknown as VaultEmissionRow);

    expect(outcome).toBe('mirrored');
    const finalRow = state.vaultEmissionRows.get(row.id);
    expect(finalRow?.state).toBe('mirrored');
    expect(finalRow?.sharesMinted).toBe(490n);
    expect(finalRow?.depositTxHash).toBe('deposit-tx-1');
    expect(finalRow?.transferTxHash).toBe('transfer-tx-1');
    expect(finalRow?.mirroredAt).not.toBeNull();

    // Mirror conserved: exactly 500 minor credited.
    expect(state.userCreditsBalances.get(`${USER_ID}:USD`)).toBe(500n);
    expect(state.creditTransactionInserts).toHaveLength(1);
    expect(state.creditTransactionInserts[0]).toMatchObject({
      type: 'cashback',
      amountMinor: 500n,
      currency: 'USD',
      referenceType: 'order',
      referenceId: ORDER_ID,
    });

    // Conservation-trigger audit row: kind='emission', already
    // confirmed with the REAL transfer txHash, LOOPUSD asset code,
    // the vault's share contract id as issuer.
    expect(state.pendingPayoutInserts).toHaveLength(1);
    expect(state.pendingPayoutInserts[0]).toMatchObject({
      userId: USER_ID,
      orderId: null,
      kind: 'emission',
      assetCode: 'LOOPUSD',
      assetIssuer: SHARE_CONTRACT_ID,
      toAddress: USER_WALLET,
      amountStroops: 500n * 100_000n,
      state: 'confirmed',
      txHash: 'transfer-tx-1',
    });

    // INV-V1: transferShares was called with EXACTLY this row's
    // sharesMinted (490n from the deposit), never a different value.
    expect(vaultClientMocks.transferShares).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 490n,
        from: OPERATOR_PUBLIC,
        to: USER_WALLET,
        signWith: 'operator',
      }),
    );
    expect(vaultClientMocks.depositToVault).toHaveBeenCalledTimes(1);
    expect(vaultClientMocks.transferShares).toHaveBeenCalledTimes(1);
  });

  it('EUR cashback mirrors into the EUR currency via LOOPEUR', async () => {
    registryMocks.getActiveVault.mockResolvedValue({ ...VAULT, assetCode: 'LOOPEUR' });
    vaultClientMocks.depositToVault.mockResolvedValue({
      txHash: 'd1',
      sharesMinted: 300n,
      amountsUsed: [],
      deduped: false,
    });
    vaultClientMocks.transferShares.mockResolvedValue({ txHash: 't1', deduped: false });

    const row = state.seedRow({
      orderId: ORDER_ID,
      userId: USER_ID,
      assetCode: 'LOOPEUR',
      cashbackMinor: 300n,
    });
    const outcome = await driveOneVaultEmission(row as unknown as VaultEmissionRow);
    expect(outcome).toBe('mirrored');
    expect(state.userCreditsBalances.get(`${USER_ID}:EUR`)).toBe(300n);
    expect(state.creditTransactionInserts[0]).toMatchObject({ currency: 'EUR' });
  });
});

describe('driveOneVaultEmission — resume behavior (CF-18 / crash recovery)', () => {
  it('a row already deposited resumes at transfer and does NOT re-deposit', async () => {
    vaultClientMocks.transferShares.mockResolvedValue({ txHash: 'transfer-tx-2', deduped: false });

    const row = state.seedRow({
      orderId: ORDER_ID,
      userId: USER_ID,
      cashbackMinor: 500n,
      state: 'deposited',
      depositTxHash: 'deposit-tx-prior',
      sharesMinted: 480n,
    });
    const outcome = await driveOneVaultEmission(row as unknown as VaultEmissionRow);

    expect(outcome).toBe('mirrored');
    expect(vaultClientMocks.depositToVault).not.toHaveBeenCalled();
    expect(vaultClientMocks.transferShares).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 480n }),
    );
  });

  it('a row already transferred resumes at mirror only (no deposit, no transfer)', async () => {
    const row = state.seedRow({
      orderId: ORDER_ID,
      userId: USER_ID,
      cashbackMinor: 500n,
      state: 'transferred',
      depositTxHash: 'd1',
      sharesMinted: 480n,
      transferTxHash: 't1',
    });
    const outcome = await driveOneVaultEmission(row as unknown as VaultEmissionRow);

    expect(outcome).toBe('mirrored');
    expect(vaultClientMocks.depositToVault).not.toHaveBeenCalled();
    expect(vaultClientMocks.transferShares).not.toHaveBeenCalled();
    expect(state.userCreditsBalances.get(`${USER_ID}:USD`)).toBe(500n);
  });

  it('a retry that lands on an already-mirrored credit_transactions row (backstop) advances to mirrored without double-crediting', async () => {
    // Pre-seed the SAME (type, referenceType, referenceId) as already
    // written — simulates a prior attempt that committed the mirror
    // but crashed before flipping vault_emissions to 'mirrored'.
    state.creditTransactionKeys.add(`cashback:order:${ORDER_ID}`);
    state.userCreditsBalances.set(`${USER_ID}:USD`, 500n);

    const row = state.seedRow({
      orderId: ORDER_ID,
      userId: USER_ID,
      cashbackMinor: 500n,
      state: 'transferred',
      depositTxHash: 'd1',
      sharesMinted: 480n,
      transferTxHash: 't1',
    });
    const outcome = await driveOneVaultEmission(row as unknown as VaultEmissionRow);

    expect(outcome).toBe('mirrored');
    // Balance untouched beyond the pre-seeded 500n — no double-credit.
    expect(state.userCreditsBalances.get(`${USER_ID}:USD`)).toBe(500n);
    expect(state.creditTransactionInserts).toHaveLength(0);
  });

  it('passes priorTxHash through to depositToVault when a deposit hash was persisted but the row is still pending (crash between onSigned and the state update)', async () => {
    vaultClientMocks.depositToVault.mockResolvedValue({
      txHash: 'deposit-tx-resumed',
      sharesMinted: 490n,
      amountsUsed: [],
      deduped: true,
    });
    vaultClientMocks.transferShares.mockResolvedValue({ txHash: 't1', deduped: false });

    const row = state.seedRow({
      orderId: ORDER_ID,
      userId: USER_ID,
      cashbackMinor: 500n,
      state: 'pending',
      depositTxHash: 'deposit-tx-signed-but-not-advanced',
    });
    await driveOneVaultEmission(row as unknown as VaultEmissionRow);

    expect(vaultClientMocks.depositToVault).toHaveBeenCalledWith(
      expect.objectContaining({ priorTxHash: 'deposit-tx-signed-but-not-advanced' }),
    );
  });
});

describe('driveOneVaultEmission — failure handling', () => {
  it('a deposit failure leaves the row pending with attempts incremented (not yet failed)', async () => {
    vaultClientMocks.depositToVault.mockRejectedValue(new Error('Soroban RPC timeout'));
    const row = state.seedRow({ orderId: ORDER_ID, userId: USER_ID, cashbackMinor: 500n });
    const outcome = await driveOneVaultEmission(row as unknown as VaultEmissionRow);

    expect(outcome).toBe('pending');
    const finalRow = state.vaultEmissionRows.get(row.id);
    expect(finalRow?.attempts).toBe(1);
    expect(finalRow?.state).toBe('pending');
    expect(finalRow?.lastError).toContain('Soroban RPC timeout');
  });

  it('moves to failed after VAULT_EMISSION_MAX_ATTEMPTS consecutive failures', async () => {
    vaultClientMocks.depositToVault.mockRejectedValue(new Error('persistent failure'));
    let row = state.seedRow({ orderId: ORDER_ID, userId: USER_ID, cashbackMinor: 500n });
    for (let i = 0; i < 5; i++) {
      const outcome = await driveOneVaultEmission(row as unknown as VaultEmissionRow);
      row = state.vaultEmissionRows.get(row.id)!;
      if (i < 4) {
        expect(outcome).toBe('pending');
      } else {
        expect(outcome).toBe('failed');
      }
    }
    expect(row.state).toBe('failed');
    expect(row.attempts).toBe(5);
    expect(row.failedAt).not.toBeNull();
  });

  it('no active vault registered returns no_vault without touching the row', async () => {
    registryMocks.getActiveVault.mockResolvedValue(null);
    const row = state.seedRow({ orderId: ORDER_ID, userId: USER_ID, cashbackMinor: 500n });
    const outcome = await driveOneVaultEmission(row as unknown as VaultEmissionRow);
    expect(outcome).toBe('no_vault');
    expect(vaultClientMocks.depositToVault).not.toHaveBeenCalled();
    expect(state.vaultEmissionRows.get(row.id)?.state).toBe('pending');
  });
});

describe('runVaultEmissionSweepTick — gated-off leaves the existing path untouched', () => {
  it('does nothing when vaultsEnabled() is false, even with pending rows queued', async () => {
    registryMocks.vaultsEnabled.mockReturnValue(false);
    state.seedRow({ orderId: ORDER_ID, userId: USER_ID, cashbackMinor: 500n });

    const result = await runVaultEmissionSweepTick();

    expect(result.considered).toBe(0);
    expect(vaultClientMocks.depositToVault).not.toHaveBeenCalled();
    expect(vaultClientMocks.transferShares).not.toHaveBeenCalled();
    const row = [...state.vaultEmissionRows.values()][0];
    expect(row?.state).toBe('pending');
  });

  it('processes queued rows sequentially when enabled, mirroring each', async () => {
    vaultClientMocks.depositToVault.mockResolvedValue({
      txHash: 'd',
      sharesMinted: 100n,
      amountsUsed: [],
      deduped: false,
    });
    vaultClientMocks.transferShares.mockResolvedValue({ txHash: 't', deduped: false });
    state.seedRow({ orderId: 'order-a', userId: USER_ID, cashbackMinor: 100n });
    state.seedRow({ orderId: 'order-b', userId: USER_ID, cashbackMinor: 100n });

    const result = await runVaultEmissionSweepTick();

    expect(result.considered).toBe(2);
    expect(result.mirrored).toBe(2);
  });
});
