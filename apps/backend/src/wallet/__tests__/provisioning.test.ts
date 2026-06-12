import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Account, Keypair, Networks, type Operation, type Transaction } from '@stellar/stellar-sdk';
import type * as ProviderModule from '../provider.js';
import type * as PayoutSubmitModule from '../../payments/payout-submit.js';
import type * as StellarSdkModule from '@stellar/stellar-sdk';

/**
 * Wallet-provisioning tests (ADR 030 Phase C1).
 *
 * Mirrors the Phase-B suites: real local ed25519 keypairs stand in
 * for Privy (the mock provider's rawSign signs with the user
 * keypair's secret; assertions verify against its public key) — the
 * signature path is exercised for real, only Horizon + the DB are
 * mocked.
 */

// Throwaway per-run keypairs (no funds; test-only). Generated rather
// than hardcoded so the lint-docs Stellar-seed scan (§5b) stays
// meaningful — a literal S… seed in the tree is always a finding.
const userKeypair = Keypair.random();
const operatorKeypair = Keypair.random();
const OPERATOR_PUBLIC = operatorKeypair.publicKey();
const OPERATOR_SECRET = operatorKeypair.secret();
const USER_PUBLIC = userKeypair.publicKey();
const GBPLOOP_ISSUER = 'GCI6YY2KRKTFC3SW7O7O5BLDAZUC3SMOPADWCQRZMND7PLM3K5WM3FKL';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { envState } = vi.hoisted(() => ({
  envState: {
    LOOP_WALLET_PROVIDER: 'privy' as string,
    LOOP_STELLAR_OPERATOR_SECRET: undefined as string | undefined,
  },
}));
vi.mock('../../env.js', () => ({
  env: new Proxy(
    {},
    {
      get: (_t, key: string) => {
        if (key in envState) return envState[key as keyof typeof envState];
        switch (key) {
          case 'PRIVY_APP_ID':
            return 'app-id';
          case 'PRIVY_APP_SECRET':
            return 'app-secret';
          case 'LOOP_STELLAR_HORIZON_URL':
            return 'https://horizon.test';
          case 'LOOP_STELLAR_NETWORK_PASSPHRASE':
            return Networks.TESTNET;
          case 'LOOP_PAYOUT_FEE_BASE_STROOPS':
            return 100;
          case 'LOOP_PAYOUT_FEE_CAP_STROOPS':
            return 100_000;
          case 'LOOP_PAYOUT_FEE_MULTIPLIER':
            return 2;
          default:
            return undefined;
        }
      },
    },
  ),
}));

// The provider factory is replaced wholesale — the real privy.ts
// adapter has its own suite; here a real-keypair signer stands in.
const { providerState } = vi.hoisted(() => ({
  providerState: {
    enabled: true,
    createWallet: vi.fn(),
    rawSign: vi.fn(),
  },
}));
vi.mock('../provider.js', async () => {
  const actual = await vi.importActual<typeof ProviderModule>('../provider.js');
  return {
    ...actual,
    getWalletProvider: () =>
      providerState.enabled
        ? {
            name: 'privy' as const,
            createWallet: providerState.createWallet,
            rawSign: providerState.rawSign,
          }
        : null,
  };
});

const { assetsState } = vi.hoisted(() => ({
  assetsState: { assets: [] as Array<{ code: string; issuer: string }> },
}));
vi.mock('../../credits/payout-asset.js', () => ({
  configuredLoopPayableAssets: () => assetsState.assets,
}));

const { trustlinesMock } = vi.hoisted(() => ({ trustlinesMock: vi.fn() }));
vi.mock('../../payments/horizon-trustlines.js', () => ({
  getAccountTrustlines: (account: string) => trustlinesMock(account),
}));

const { submitMock } = vi.hoisted(() => ({
  submitMock: vi.fn(async (_args: unknown) => ({ txHash: 'feedface', ledger: 7 })),
}));
vi.mock('../../payments/payout-submit.js', async () => {
  const actual = await vi.importActual<typeof PayoutSubmitModule>(
    '../../payments/payout-submit.js',
  );
  return { ...actual, submitPreSignedTransaction: submitMock };
});

const { notifyStuckMock } = vi.hoisted(() => ({ notifyStuckMock: vi.fn() }));
vi.mock('../../discord.js', () => ({
  notifyWalletProvisioningStuck: (args: unknown) => notifyStuckMock(args),
}));

vi.mock('../../runtime-health.js', () => ({
  markWorkerStarted: vi.fn(),
  markWorkerStopped: vi.fn(),
  markWorkerTickFailure: vi.fn(),
  markWorkerTickSuccess: vi.fn(),
}));

// Horizon.Server.loadAccount → real Account object, zero network.
vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof StellarSdkModule>('@stellar/stellar-sdk');
  class FakeServer {
    async loadAccount(accountId: string): Promise<InstanceType<typeof actual.Account>> {
      return new actual.Account(accountId, '4242');
    }
  }
  return { ...actual, Horizon: { ...actual.Horizon, Server: FakeServer } };
});

// db mock — select chains are thenable (drizzle awaits the builder);
// update chains record `.set()` payloads and support `.returning()`.
const { dbMock, dbState } = vi.hoisted(() => {
  const s = {
    /** Rows returned by every select (the current "user row"). */
    selectRows: [] as unknown[],
    /** When non-null, consecutive selects consume from this FIFO. */
    selectQueue: null as unknown[][] | null,
    /** Sweeper candidate rows (used when .orderBy is called). */
    sweepRows: [] as unknown[],
    updates: [] as Array<Record<string, unknown>>,
    updateMatches: true,
  };
  function nextSelectRows(): unknown[] {
    if (s.selectQueue !== null && s.selectQueue.length > 0) {
      return s.selectQueue.length === 1 ? s.selectQueue[0]! : s.selectQueue.shift()!;
    }
    return s.selectRows;
  }
  function makeSelectChain(): Record<string, unknown> {
    let isSweep = false;
    const chain: Record<string, unknown> = {};
    chain['from'] = vi.fn(() => chain);
    chain['where'] = vi.fn(() => chain);
    chain['orderBy'] = vi.fn(() => {
      isSweep = true;
      return chain;
    });
    chain['limit'] = vi.fn(async () => s.sweepRows);
    chain['then'] = (resolve: (rows: unknown[]) => unknown, reject?: (err: unknown) => unknown) =>
      Promise.resolve(isSweep ? s.sweepRows : nextSelectRows()).then(resolve, reject);
    return chain;
  }
  const m = {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn(() => {
      let lastSet: Record<string, unknown> | null = null;
      const chain: Record<string, unknown> = {};
      chain['set'] = vi.fn((vals: Record<string, unknown>) => {
        lastSet = vals;
        return chain;
      });
      chain['where'] = vi.fn(() => chain);
      chain['returning'] = vi.fn(async () => {
        if (lastSet !== null) s.updates.push(lastSet);
        return s.updateMatches ? [{ id: 'updated' }] : [];
      });
      chain['then'] = (resolve: (v: unknown) => unknown, reject?: (err: unknown) => unknown) => {
        if (lastSet !== null) s.updates.push(lastSet);
        return Promise.resolve([]).then(resolve, reject);
      };
      return chain;
    }),
  };
  return { dbMock: m, dbState: s };
});
vi.mock('../../db/client.js', () => ({ db: dbMock }));

import {
  buildActivationTransaction,
  provisionUserWallet,
  runWalletProvisioningTick,
  walletProvisioningDelayMs,
  WALLET_PROVISIONING_MAX_ATTEMPTS,
} from '../provisioning.js';

const USER_ID = 'b4b3c0de-0000-4000-8000-000000000001';
const GBP_ASSET = { code: 'GBPLOOP', issuer: GBPLOOP_ISSUER };

function userRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: USER_ID,
    walletId: 'wallet-privy-1',
    walletAddress: USER_PUBLIC,
    walletProvisioning: 'wallet_created',
    walletProvisioningAttempts: 0,
    ...overrides,
  };
}

function emptyTrustlines(accountExists: boolean): unknown {
  return { account: USER_PUBLIC, accountExists, trustlines: new Map(), asOfMs: Date.now() };
}

beforeEach(() => {
  envState.LOOP_WALLET_PROVIDER = 'privy';
  envState.LOOP_STELLAR_OPERATOR_SECRET = OPERATOR_SECRET;
  providerState.enabled = true;
  providerState.createWallet.mockReset();
  providerState.rawSign.mockReset();
  providerState.rawSign.mockImplementation(async (_walletId: string, hashHex: string) =>
    userKeypair.sign(Buffer.from(hashHex, 'hex')).toString('hex'),
  );
  assetsState.assets = [GBP_ASSET];
  trustlinesMock.mockReset();
  submitMock.mockClear();
  notifyStuckMock.mockClear();
  dbState.selectRows = [];
  dbState.selectQueue = null;
  dbState.sweepRows = [];
  dbState.updates = [];
  dbState.updateMatches = true;
});

// ─── Activation envelope shape ──────────────────────────────────────────────

describe('buildActivationTransaction', () => {
  function build(args?: {
    accountExists?: boolean;
    assets?: Array<{ code: string; issuer: string }>;
  }): Transaction {
    return buildActivationTransaction({
      operatorAccount: new Account(OPERATOR_PUBLIC, '7'),
      userAddress: USER_PUBLIC,
      assets: args?.assets ?? [GBP_ASSET],
      accountExists: args?.accountExists ?? false,
      networkPassphrase: Networks.TESTNET,
      feeStroops: '100',
    });
  }

  it('builds the sponsorship sandwich: begin → createAccount(0) → changeTrust → end', () => {
    const tx = build();
    expect(tx.source).toBe(OPERATOR_PUBLIC);
    expect(tx.operations).toHaveLength(4);

    const [begin, create, trust, end] = tx.operations;
    expect(begin!.type).toBe('beginSponsoringFutureReserves');
    expect((begin as Operation.BeginSponsoringFutureReserves).sponsoredId).toBe(USER_PUBLIC);
    // begin's source is the tx source (operator) — undefined per-op.
    expect(begin!.source).toBeUndefined();

    expect(create!.type).toBe('createAccount');
    const createOp = create as Operation.CreateAccount;
    expect(createOp.destination).toBe(USER_PUBLIC);
    // SDK normalises the balance to 7-decimal form on parse-back.
    expect(createOp.startingBalance).toBe('0.0000000');
    expect(create!.source).toBeUndefined();

    expect(trust!.type).toBe('changeTrust');
    const trustOp = trust as Operation.ChangeTrust;
    expect(trust!.source).toBe(USER_PUBLIC);
    expect((trustOp.line as { code: string; issuer: string }).code).toBe('GBPLOOP');
    expect((trustOp.line as { code: string; issuer: string }).issuer).toBe(GBPLOOP_ISSUER);

    expect(end!.type).toBe('endSponsoringFutureReserves');
    expect(end!.source).toBe(USER_PUBLIC);
  });

  it('emits one changeTrust per configured asset, sandwiched by begin/end', () => {
    const tx = build({
      assets: [
        GBP_ASSET,
        { code: 'USDLOOP', issuer: OPERATOR_PUBLIC }, // any valid issuer for shape purposes
      ],
    });
    expect(tx.operations.map((o) => o.type)).toEqual([
      'beginSponsoringFutureReserves',
      'createAccount',
      'changeTrust',
      'changeTrust',
      'endSponsoringFutureReserves',
    ]);
  });

  it('omits createAccount on re-activation of an existing account', () => {
    const tx = build({ accountExists: true });
    expect(tx.operations.map((o) => o.type)).toEqual([
      'beginSponsoringFutureReserves',
      'changeTrust',
      'endSponsoringFutureReserves',
    ]);
  });

  it('refuses an empty asset list (an activated wallet without trustlines is a payout trap)', () => {
    expect(() => build({ assets: [] })).toThrow(/at least one LOOP asset/);
  });
});

// ─── State machine ──────────────────────────────────────────────────────────

describe('provisionUserWallet', () => {
  it('walks none → wallet_created → activated in one drive (fresh user)', async () => {
    providerState.createWallet.mockResolvedValue({
      walletId: 'wallet-privy-1',
      address: USER_PUBLIC,
    });
    // First read: no wallet. Second read (post-persist): wallet_created.
    dbState.selectQueue = [
      [userRow({ walletId: null, walletAddress: null, walletProvisioning: 'none' })],
      [userRow()],
    ];
    trustlinesMock.mockResolvedValue(emptyTrustlines(false));

    const outcome = await provisionUserWallet(USER_ID);

    expect(outcome).toBe('activated');
    expect(providerState.createWallet).toHaveBeenCalledWith(USER_ID);
    // Persisted the wallet linkage + wallet_created…
    expect(dbState.updates.some((u) => u['walletProvisioning'] === 'wallet_created')).toBe(true);
    // …signed + submitted ONE activation tx…
    expect(submitMock).toHaveBeenCalledTimes(1);
    // …and marked activated.
    expect(dbState.updates.some((u) => u['walletProvisioning'] === 'activated')).toBe(true);
  });

  it('submits a dual-signed envelope: operator + provider-sourced user signature both verify', async () => {
    dbState.selectRows = [userRow()];
    trustlinesMock.mockResolvedValue(emptyTrustlines(false));

    await provisionUserWallet(USER_ID);

    expect(submitMock).toHaveBeenCalledTimes(1);
    const { tx } = submitMock.mock.calls[0]![0] as unknown as { tx: Transaction };
    expect(tx.signatures).toHaveLength(2);
    const hash = tx.hash();
    const verifies = (kp: Keypair): boolean =>
      tx.signatures.some((d) => kp.verify(hash, d.signature()));
    expect(verifies(operatorKeypair)).toBe(true);
    expect(verifies(userKeypair)).toBe(true);
    // The provider was asked to sign exactly the tx hash.
    expect(providerState.rawSign).toHaveBeenCalledWith('wallet-privy-1', hash.toString('hex'));
  });

  it('is idempotent: detect-and-mark when the account already exists with all trustlines', async () => {
    dbState.selectRows = [userRow()];
    trustlinesMock.mockResolvedValue({
      account: USER_PUBLIC,
      accountExists: true,
      trustlines: new Map([
        [`GBPLOOP::${GBPLOOP_ISSUER}`, { code: 'GBPLOOP', issuer: GBPLOOP_ISSUER }],
      ]),
      asOfMs: Date.now(),
    });

    const outcome = await provisionUserWallet(USER_ID);

    expect(outcome).toBe('activated');
    expect(submitMock).not.toHaveBeenCalled();
    expect(providerState.rawSign).not.toHaveBeenCalled();
    expect(dbState.updates.some((u) => u['walletProvisioning'] === 'activated')).toBe(true);
  });

  it('re-activates an existing account missing trustlines with a changeTrust-only tx', async () => {
    dbState.selectRows = [userRow()];
    trustlinesMock.mockResolvedValue(emptyTrustlines(true));

    const outcome = await provisionUserWallet(USER_ID);

    expect(outcome).toBe('activated');
    const { tx } = submitMock.mock.calls[0]![0] as unknown as { tx: Transaction };
    expect(tx.operations.map((o) => o.type)).toEqual([
      'beginSponsoringFutureReserves',
      'changeTrust',
      'endSponsoringFutureReserves',
    ]);
  });

  it('no-ops on an already-activated row', async () => {
    dbState.selectRows = [userRow({ walletProvisioning: 'activated' })];
    const outcome = await provisionUserWallet(USER_ID);
    expect(outcome).toBe('already_activated');
    expect(providerState.createWallet).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('returns config-shaped outcomes without burning the row (provider off / no assets / no operator)', async () => {
    providerState.enabled = false;
    expect(await provisionUserWallet(USER_ID)).toBe('provider_disabled');

    providerState.enabled = true;
    dbState.selectRows = [userRow()];
    assetsState.assets = [];
    expect(await provisionUserWallet(USER_ID)).toBe('no_assets_configured');

    assetsState.assets = [GBP_ASSET];
    envState.LOOP_STELLAR_OPERATOR_SECRET = undefined;
    expect(await provisionUserWallet(USER_ID)).toBe('operator_unconfigured');

    expect(submitMock).not.toHaveBeenCalled();
    expect(dbState.updates).toHaveLength(0);
  });

  it('propagates provider failures (the sweeper records the attempt)', async () => {
    dbState.selectRows = [userRow({ walletId: null, walletAddress: null })];
    providerState.createWallet.mockRejectedValue(new Error('privy 500'));
    await expect(provisionUserWallet(USER_ID)).rejects.toThrow('privy 500');
  });
});

// ─── Sweeper ────────────────────────────────────────────────────────────────

describe('runWalletProvisioningTick', () => {
  it('backoff: 1min → 2min → … capped at 8h', () => {
    expect(walletProvisioningDelayMs(0)).toBe(60_000);
    expect(walletProvisioningDelayMs(1)).toBe(120_000);
    expect(walletProvisioningDelayMs(4)).toBe(960_000);
    expect(walletProvisioningDelayMs(20)).toBe(8 * 60 * 60 * 1000);
  });

  it('skips rows whose backoff window has not elapsed', async () => {
    const now = 1_900_000_000_000;
    dbState.sweepRows = [
      { id: USER_ID, attempts: 3, lastAttemptAt: new Date(now - 60_000) }, // due at +8min
    ];
    const r = await runWalletProvisioningTick({ now });
    expect(r).toMatchObject({ picked: 1, notDueYet: 1, activated: 0, errors: 0 });
  });

  it('records the attempt and pages ops when the cap is crossed', async () => {
    const now = 1_900_000_000_000;
    dbState.sweepRows = [
      {
        id: USER_ID,
        attempts: WALLET_PROVISIONING_MAX_ATTEMPTS - 1,
        lastAttemptAt: new Date(now - 9 * 60 * 60 * 1000),
      },
    ];
    // The drive throws — user row reads resolve, Horizon read fails.
    dbState.selectRows = [
      userRow({ walletProvisioningAttempts: WALLET_PROVISIONING_MAX_ATTEMPTS - 1 }),
    ];
    trustlinesMock.mockRejectedValue(new Error('horizon down'));

    const r = await runWalletProvisioningTick({ now });

    expect(r.errors).toBe(1);
    expect(notifyStuckMock).toHaveBeenCalledTimes(1);
    expect(notifyStuckMock.mock.calls[0]![0]).toMatchObject({
      userId: USER_ID,
      attempts: WALLET_PROVISIONING_MAX_ATTEMPTS,
    });
  });

  it('aborts without burning attempts when the deployment is unconfigured', async () => {
    const now = 1_900_000_000_000;
    assetsState.assets = [];
    dbState.sweepRows = [
      { id: USER_ID, attempts: 0, lastAttemptAt: null },
      { id: 'second-user', attempts: 0, lastAttemptAt: null },
    ];
    dbState.selectRows = [userRow()];

    const r = await runWalletProvisioningTick({ now });

    expect(r.abortedUnconfigured).toBe(true);
    expect(r.errors).toBe(0);
    expect(notifyStuckMock).not.toHaveBeenCalled();
    expect(dbState.updates).toHaveLength(0);
  });

  it('activates due rows', async () => {
    const now = 1_900_000_000_000;
    dbState.sweepRows = [{ id: USER_ID, attempts: 0, lastAttemptAt: null }];
    dbState.selectRows = [userRow()];
    trustlinesMock.mockResolvedValue(emptyTrustlines(false));

    const r = await runWalletProvisioningTick({ now });

    expect(r).toMatchObject({ picked: 1, activated: 1, errors: 0 });
    expect(submitMock).toHaveBeenCalledTimes(1);
  });
});
