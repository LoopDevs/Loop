import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { Keypair, Networks, type FeeBumpTransaction, type Operation } from '@stellar/stellar-sdk';
import type { LoopAuthContext } from '../../auth/handler.js';
import type * as ProviderModule from '../../wallet/provider.js';
import type * as PayoutSubmitModule from '../../payments/payout-submit.js';
import type * as StellarSdkModule from '@stellar/stellar-sdk';

/**
 * Pay-with-balance handler tests (ADR 030 Phase C3).
 *
 * Same Phase-B testing philosophy: the wallet provider is a REAL
 * local ed25519 keypair (rawSign signs the tx hash for real), so the
 * fee-bump envelope captured at the submit boundary carries an
 * actually-verifiable user signature. Only Horizon + the DB are
 * mocked.
 */

// Real ed25519 test keypairs, generated per run (never hardcode
// Stellar seeds — the lint-docs secret scan rejects S... literals
// in tracked files, and fresh keypairs prove the signature path
// rather than a memorised fixture).
const userKeypair = Keypair.random();
const operatorKeypair = Keypair.random();
const OPERATOR_PUBLIC = operatorKeypair.publicKey();
const OPERATOR_SECRET = operatorKeypair.secret();
const USER_PUBLIC = userKeypair.publicKey();
const GBPLOOP_ISSUER = 'GCI6YY2KRKTFC3SW7O7O5BLDAZUC3SMOPADWCQRZMND7PLM3K5WM3FKL';
const DEPOSIT_ADDRESS = 'GCKEGFRZD6UZ3A7VCZ6VHV2V6S5K6VXNDIGPMYBBKRI3MFKXCBWCAAYO';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { envState } = vi.hoisted(() => ({
  envState: {
    LOOP_AUTH_NATIVE_ENABLED: true,
    LOOP_STELLAR_DEPOSIT_ADDRESS: undefined as string | undefined,
    LOOP_STELLAR_OPERATOR_SECRET: undefined as string | undefined,
    LOOP_STELLAR_GBPLOOP_ISSUER: undefined as string | undefined,
  },
}));
vi.mock('../../env.js', () => ({
  env: new Proxy(
    {},
    {
      get: (_t, key: string) => {
        if (key in envState) return envState[key as keyof typeof envState];
        switch (key) {
          case 'LOOP_STELLAR_HORIZON_URL':
            return 'https://horizon.test';
          case 'LOOP_STELLAR_NETWORK_PASSPHRASE':
            return 'Test SDF Network ; September 2015';
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

const { orderState, advisoryLockState } = vi.hoisted(() => ({
  orderState: { row: undefined as unknown, freshRow: undefined as unknown },
  // `degraded: true` models a transaction-pooler DATABASE_URL, where
  // withAdvisoryLock runs the fn WITHOUT any lock (see db/client.ts).
  advisoryLockState: { held: new Set<string>(), degraded: false },
}));
vi.mock('../../db/client.js', () => ({
  db: {
    query: {
      orders: {
        findFirst: vi.fn(async (opts: unknown) => {
          // First call (owner-scoped) returns row; the post-submit
          // re-read returns freshRow when set.
          void opts;
          if (orderState.freshRow !== undefined && orderState.row === null) {
            return orderState.freshRow;
          }
          const r = orderState.row;
          return r;
        }),
      },
    },
  },
  withAdvisoryLock: async <T>(key: bigint, fn: () => Promise<T>) => {
    if (advisoryLockState.degraded) {
      return { ran: true as const, value: await fn() };
    }
    const lock = key.toString();
    if (advisoryLockState.held.has(lock)) return { ran: false as const };
    advisoryLockState.held.add(lock);
    try {
      return { ran: true as const, value: await fn() };
    } finally {
      advisoryLockState.held.delete(lock);
    }
  },
}));

const { userState } = vi.hoisted(() => ({ userState: { row: undefined as unknown } }));
vi.mock('../../db/users.js', () => ({
  getUserById: vi.fn(async () => userState.row),
}));

const { providerState } = vi.hoisted(() => ({
  providerState: { enabled: true, rawSign: vi.fn() },
}));
vi.mock('../../wallet/provider.js', async () => {
  const actual = await vi.importActual<typeof ProviderModule>('../../wallet/provider.js');
  return {
    ...actual,
    getWalletProvider: () =>
      providerState.enabled
        ? { name: 'privy' as const, createWallet: vi.fn(), rawSign: providerState.rawSign }
        : null,
  };
});

const { trustlinesMock } = vi.hoisted(() => ({ trustlinesMock: vi.fn() }));
vi.mock('../../payments/horizon-trustlines.js', () => ({
  getAccountTrustlines: (account: string) => trustlinesMock(account),
}));

const { submitMock } = vi.hoisted(() => ({
  submitMock: vi.fn(async (_args: unknown) => ({ txHash: 'cafebabe', ledger: 9 })),
}));
vi.mock('../../payments/payout-submit.js', async () => {
  const actual = await vi.importActual<typeof PayoutSubmitModule>(
    '../../payments/payout-submit.js',
  );
  return { ...actual, submitPreSignedTransaction: submitMock };
});

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof StellarSdkModule>('@stellar/stellar-sdk');
  class FakeServer {
    async loadAccount(accountId: string): Promise<InstanceType<typeof actual.Account>> {
      return new actual.Account(accountId, '99');
    }
  }
  return { ...actual, Horizon: { ...actual.Horizon, Server: FakeServer } };
});

import { PayoutSubmitError } from '../../payments/payout-submit.js';
import {
  redeemLoopOrderHandler,
  buildRedeemTransaction,
  __resetRedeemFenceForTests,
} from '../redeem.js';

const ORDER_ID = '0a1b2c3d-1111-4222-8333-444455556666';
const MEMO = 'ABCDEFGHIJKLMNOPQRST';

const LOOP_AUTH: LoopAuthContext = {
  kind: 'loop',
  userId: 'user-uuid',
  email: 'a@b.com',
  bearerToken: 'loop-access',
} as LoopAuthContext;

function makeCtx(opts: { auth?: LoopAuthContext | { kind: string }; param?: string }): Context {
  const store = new Map<string, unknown>();
  if (opts.auth !== undefined) store.set('auth', opts.auth);
  return {
    req: { param: (k: string) => (k === 'id' ? opts.param : undefined) },
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

function loopAssetOrder(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: ORDER_ID,
    userId: 'user-uuid',
    state: 'pending_payment',
    paymentMethod: 'loop_asset',
    paymentMemo: MEMO,
    chargeMinor: 250n, // £2.50 → 25_000_000 stroops of GBPLOOP
    chargeCurrency: 'GBP',
    ...overrides,
  };
}

function activatedUser(): Record<string, unknown> {
  return {
    id: 'user-uuid',
    walletProvider: 'privy',
    walletId: 'wallet-privy-1',
    walletAddress: USER_PUBLIC,
    walletProvisioning: 'activated',
  };
}

function fundedTrustlines(balanceStroops: bigint): unknown {
  return {
    account: USER_PUBLIC,
    accountExists: true,
    trustlines: new Map([
      [
        `GBPLOOP::${GBPLOOP_ISSUER}`,
        { code: 'GBPLOOP', issuer: GBPLOOP_ISSUER, balanceStroops, limitStroops: 10n ** 14n },
      ],
    ]),
    asOfMs: Date.now(),
  };
}

beforeEach(() => {
  __resetRedeemFenceForTests();
  advisoryLockState.held.clear();
  envState.LOOP_AUTH_NATIVE_ENABLED = true;
  envState.LOOP_STELLAR_DEPOSIT_ADDRESS = DEPOSIT_ADDRESS;
  envState.LOOP_STELLAR_OPERATOR_SECRET = OPERATOR_SECRET;
  envState.LOOP_STELLAR_GBPLOOP_ISSUER = GBPLOOP_ISSUER;
  orderState.row = loopAssetOrder();
  orderState.freshRow = undefined;
  userState.row = activatedUser();
  providerState.enabled = true;
  providerState.rawSign.mockReset();
  providerState.rawSign.mockImplementation(async (_walletId: string, hashHex: string) =>
    userKeypair.sign(Buffer.from(hashHex, 'hex')).toString('hex'),
  );
  trustlinesMock.mockReset();
  trustlinesMock.mockResolvedValue(fundedTrustlines(100_000_000n)); // 10 GBPLOOP
  submitMock.mockClear();
  submitMock.mockResolvedValue({ txHash: 'cafebabe', ledger: 9 });
});

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('redeemLoopOrderHandler — guards', () => {
  it('404 when the loop-native flag is off', async () => {
    envState.LOOP_AUTH_NATIVE_ENABLED = false;
    const res = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect(res.status).toBe(404);
  });

  it('401 without a loop auth context', async () => {
    expect((await redeemLoopOrderHandler(makeCtx({ param: ORDER_ID }))).status).toBe(401);
    expect(
      (await redeemLoopOrderHandler(makeCtx({ auth: { kind: 'ctx' }, param: ORDER_ID }))).status,
    ).toBe(401);
  });

  it('400 VALIDATION_ERROR on a non-uuid id', async () => {
    const res = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: 'loop' }));
    expect(res.status).toBe(400);
    expect((await bodyOf(res))['code']).toBe('VALIDATION_ERROR');
  });

  it('404 when the order does not exist / is not owned', async () => {
    orderState.row = null;
    const res = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect(res.status).toBe(404);
  });

  it('200 idempotent replay for already-paid states', async () => {
    for (const state of ['paid', 'procuring', 'fulfilled']) {
      orderState.row = loopAssetOrder({ state });
      const res = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
      expect(res.status).toBe(200);
      expect(await bodyOf(res)).toEqual({ state });
    }
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('400 ORDER_NOT_PAYABLE on terminal states and non-loop_asset methods', async () => {
    orderState.row = loopAssetOrder({ state: 'expired' });
    let res = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect(res.status).toBe(400);
    expect((await bodyOf(res))['code']).toBe('ORDER_NOT_PAYABLE');

    orderState.row = loopAssetOrder({ paymentMethod: 'usdc' });
    res = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect(res.status).toBe(400);
    expect((await bodyOf(res))['code']).toBe('ORDER_NOT_PAYABLE');
  });

  it('503 NOT_CONFIGURED when the wallet layer is off', async () => {
    providerState.enabled = false;
    const res = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect(res.status).toBe(503);
    expect((await bodyOf(res))['code']).toBe('NOT_CONFIGURED');
  });

  it('503 NOT_CONFIGURED when the LOOP issuer for the charge currency is unset', async () => {
    envState.LOOP_STELLAR_GBPLOOP_ISSUER = undefined;
    const res = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect(res.status).toBe(503);
    expect((await bodyOf(res))['code']).toBe('NOT_CONFIGURED');
  });

  it('400 WALLET_NOT_ACTIVATED when provisioning is incomplete', async () => {
    userState.row = { ...activatedUser(), walletProvisioning: 'wallet_created' };
    const res = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect(res.status).toBe(400);
    expect((await bodyOf(res))['code']).toBe('WALLET_NOT_ACTIVATED');
    expect(submitMock).not.toHaveBeenCalled();
  });
});

describe('redeemLoopOrderHandler — balance + fence', () => {
  it('400 INSUFFICIENT_BALANCE when the on-chain balance is below the charge', async () => {
    trustlinesMock.mockResolvedValue(fundedTrustlines(24_999_999n)); // one stroop short
    const res = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect(res.status).toBe(400);
    expect((await bodyOf(res))['code']).toBe('INSUFFICIENT_BALANCE');
    expect(providerState.rawSign).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('400 INSUFFICIENT_BALANCE when the trustline is missing entirely', async () => {
    trustlinesMock.mockResolvedValue({
      account: USER_PUBLIC,
      accountExists: true,
      trustlines: new Map(),
      asOfMs: Date.now(),
    });
    const res = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect((await bodyOf(res))['code']).toBe('INSUFFICIENT_BALANCE');
  });

  it('503 when the Horizon balance read fails', async () => {
    trustlinesMock.mockRejectedValue(new Error('horizon down'));
    const res = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect(res.status).toBe(503);
    expect((await bodyOf(res))['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('fences a concurrent double-call: second caller gets 400 PAYMENT_IN_FLIGHT', async () => {
    // Park the first call inside the Horizon read so the second
    // arrives while the fence is held.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    trustlinesMock.mockImplementationOnce(async () => {
      await gate;
      return fundedTrustlines(100_000_000n);
    });

    const first = redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    // Give the first call a tick to acquire the fence.
    await new Promise((r) => setImmediate(r));
    const second = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect(second.status).toBe(400);
    expect((await bodyOf(second))['code']).toBe('PAYMENT_IN_FLIGHT');

    release();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('inner-belt fence holds when the advisory lock is degraded to a no-op (pooled DATABASE_URL)', async () => {
    advisoryLockState.degraded = true;
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      trustlinesMock.mockImplementationOnce(async () => {
        await gate;
        return fundedTrustlines(100_000_000n);
      });

      const first = redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
      await new Promise((r) => setImmediate(r));
      // No advisory lock exists — only the in-process Set stands
      // between this second tap and a second Stellar submit.
      const second = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
      expect(second.status).toBe(400);
      expect((await bodyOf(second))['code']).toBe('PAYMENT_IN_FLIGHT');

      release();
      const firstRes = await first;
      expect(firstRes.status).toBe(200);
      expect(submitMock).toHaveBeenCalledTimes(1);
    } finally {
      advisoryLockState.degraded = false;
    }
  });

  it('releases the fence after completion (sequential retry is allowed)', async () => {
    const res1 = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect(res1.status).toBe(200);
    const res2 = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect(res2.status).toBe(200);
    expect(submitMock).toHaveBeenCalledTimes(2);
  });
});

describe('redeemLoopOrderHandler — fee-bump envelope', () => {
  it('submits an operator fee-bump wrapping the user-signed payment with the order memo', async () => {
    const res = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ state: 'pending_payment' });

    expect(submitMock).toHaveBeenCalledTimes(1);
    const { tx } = submitMock.mock.calls[0]![0] as unknown as { tx: FeeBumpTransaction };

    // Outer: operator is the fee source and has signed the bump.
    expect(tx.feeSource).toBe(OPERATOR_PUBLIC);
    expect(tx.signatures).toHaveLength(1);
    expect(operatorKeypair.verify(tx.hash(), tx.signatures[0]!.signature())).toBe(true);
    // Outer fee rate clears the CAP-15 floor (≥ inner rate, ≥ min).
    expect(Number(tx.fee)).toBeGreaterThanOrEqual(200 * 2); // baseFee × (ops + 1)

    // Inner: user wallet → deposit, GBPLOOP, exact charge, memo.
    const inner = tx.innerTransaction;
    expect(inner.source).toBe(USER_PUBLIC);
    expect(inner.memo.type).toBe('text');
    expect(inner.memo.value?.toString()).toBe(MEMO);
    expect(inner.operations).toHaveLength(1);
    const payment = inner.operations[0] as Operation.Payment;
    expect(payment.type).toBe('payment');
    expect(payment.destination).toBe(DEPOSIT_ADDRESS);
    expect(payment.amount).toBe('2.5000000'); // 250 minor × 100_000 stroops
    expect((payment.asset as { code: string; issuer: string }).code).toBe('GBPLOOP');
    expect((payment.asset as { code: string; issuer: string }).issuer).toBe(GBPLOOP_ISSUER);

    // Inner signature: exactly one, from the user wallet via rawSign.
    expect(inner.signatures).toHaveLength(1);
    expect(userKeypair.verify(inner.hash(), inner.signatures[0]!.signature())).toBe(true);
    expect(providerState.rawSign).toHaveBeenCalledWith(
      'wallet-privy-1',
      inner.hash().toString('hex'),
    );
  });

  it('maps a terminal op_underfunded submit to 400 INSUFFICIENT_BALANCE (pre-check race)', async () => {
    submitMock.mockRejectedValue(
      new PayoutSubmitError('terminal_underfunded', 'op_underfunded', {
        operations: ['op_underfunded'],
      }),
    );
    const res = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect(res.status).toBe(400);
    expect((await bodyOf(res))['code']).toBe('INSUFFICIENT_BALANCE');
  });

  it('maps transient Horizon submit failures to 503', async () => {
    submitMock.mockRejectedValue(new PayoutSubmitError('transient_horizon', 'Horizon 503'));
    const res = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect(res.status).toBe(503);
    expect((await bodyOf(res))['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('maps a transient provider rawSign failure to 503 without submitting', async () => {
    const { WalletProviderError } = await import('../../wallet/provider.js');
    providerState.rawSign.mockRejectedValue(
      new WalletProviderError('transient_provider', 'privy 503', 503),
    );
    const res = await redeemLoopOrderHandler(makeCtx({ auth: LOOP_AUTH, param: ORDER_ID }));
    expect(res.status).toBe(503);
    expect(submitMock).not.toHaveBeenCalled();
  });
});

describe('buildRedeemTransaction (pure)', () => {
  it('converts chargeMinor stroops to the 7-decimal SDK amount', async () => {
    const { Account } = await import('@stellar/stellar-sdk');
    const tx = buildRedeemTransaction({
      userAccount: new Account(USER_PUBLIC, '5'),
      depositAddress: DEPOSIT_ADDRESS,
      asset: { code: 'GBPLOOP', issuer: GBPLOOP_ISSUER },
      amountStroops: 1n, // smallest unit
      memoText: MEMO,
      networkPassphrase: Networks.TESTNET,
    });
    const payment = tx.operations[0] as Operation.Payment;
    expect(payment.amount).toBe('0.0000001');
  });
});
