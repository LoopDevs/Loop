import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

/**
 * `GET /api/me/wallet` handler tests (ADR 030 Phase C4): response
 * shape, provisioning passthrough, and the never-500 last-known-good
 * fallback when Horizon errors.
 */

const USER_PUBLIC = 'GBLQXKHX7QX3AWMKFZSE7N44XUGG3M2YSYBQWS7X6MF4U7KGVCVSHKWT';
const GBPLOOP_ISSUER = 'GCI6YY2KRKTFC3SW7O7O5BLDAZUC3SMOPADWCQRZMND7PLM3K5WM3FKL';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// ADR 031: `interestApyBps` is only advertised when the on-chain
// mint path is enabled — a mutable holder lets the truthfulness
// tests flip the flag per case.
const { envState } = vi.hoisted(() => ({
  envState: {
    env: { INTEREST_APY_BASIS_POINTS: 400, LOOP_INTEREST_ONCHAIN_ENABLED: true } as {
      INTEREST_APY_BASIS_POINTS: number;
      LOOP_INTEREST_ONCHAIN_ENABLED: boolean;
    },
  },
}));
vi.mock('../../env.js', () => ({
  get env() {
    return envState.env;
  },
}));

const { resolveUserMock } = vi.hoisted(() => ({ resolveUserMock: vi.fn() }));
vi.mock('../../auth/authenticated-user.js', () => ({
  resolveLoopAuthenticatedUser: (c: unknown) => resolveUserMock(c),
}));

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

import { getMyWalletHandler, __resetWalletBalanceFallbackForTests } from '../wallet-handler.js';

function makeCtx(): Context {
  return {
    get: () => undefined,
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

function activatedUser(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'user-uuid',
    walletAddress: USER_PUBLIC,
    walletProvisioning: 'activated',
    ...overrides,
  };
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  __resetWalletBalanceFallbackForTests();
  resolveUserMock.mockReset();
  trustlinesMock.mockReset();
  assetsState.assets = [{ code: 'GBPLOOP', issuer: GBPLOOP_ISSUER }];
  envState.env = { INTEREST_APY_BASIS_POINTS: 400, LOOP_INTEREST_ONCHAIN_ENABLED: true };
});

describe('getMyWalletHandler', () => {
  it('401 when the caller is not loop-authed', async () => {
    resolveUserMock.mockResolvedValue(null);
    const res = await getMyWalletHandler(makeCtx());
    expect(res.status).toBe(401);
  });

  it('503 (never-500) when the user resolve itself throws', async () => {
    resolveUserMock.mockRejectedValue(new Error('db down'));
    const res = await getMyWalletHandler(makeCtx());
    expect(res.status).toBe(503);
    expect((await bodyOf(res))['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('returns the empty shape for a user with no wallet yet', async () => {
    resolveUserMock.mockResolvedValue(
      activatedUser({ walletAddress: null, walletProvisioning: 'none' }),
    );
    const res = await getMyWalletHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({
      address: null,
      provisioning: 'none',
      balances: [],
      interestApyBps: 400,
      stale: false,
    });
    expect(trustlinesMock).not.toHaveBeenCalled();
  });

  it('returns on-chain balances for configured LOOP assets only', async () => {
    resolveUserMock.mockResolvedValue(activatedUser());
    trustlinesMock.mockResolvedValue({
      account: USER_PUBLIC,
      accountExists: true,
      trustlines: new Map([
        [
          `GBPLOOP::${GBPLOOP_ISSUER}`,
          {
            code: 'GBPLOOP',
            issuer: GBPLOOP_ISSUER,
            balanceStroops: 50_000_000n,
            limitStroops: 0n,
          },
        ],
        // A trustline to an UNCONFIGURED asset must not leak through.
        [
          'ROGUE::GROGUE',
          { code: 'ROGUE', issuer: 'GROGUE', balanceStroops: 1n, limitStroops: 0n },
        ],
      ]),
      asOfMs: Date.now(),
    });

    const res = await getMyWalletHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({
      address: USER_PUBLIC,
      provisioning: 'activated',
      balances: [{ assetCode: 'GBPLOOP', balance: '5.0000000' }],
      interestApyBps: 400,
      stale: false,
    });
    expect(trustlinesMock).toHaveBeenCalledWith(USER_PUBLIC);
  });

  it('omits assets whose trustline is not established yet (wallet_created)', async () => {
    resolveUserMock.mockResolvedValue(activatedUser({ walletProvisioning: 'wallet_created' }));
    trustlinesMock.mockResolvedValue({
      account: USER_PUBLIC,
      accountExists: false,
      trustlines: new Map(),
      asOfMs: Date.now(),
    });
    const res = await getMyWalletHandler(makeCtx());
    const body = await bodyOf(res);
    expect(body['provisioning']).toBe('wallet_created');
    expect(body['balances']).toEqual([]);
    expect(body['stale']).toBe(false);
  });

  it('serves the last-known-good snapshot with stale:true when Horizon errors', async () => {
    resolveUserMock.mockResolvedValue(activatedUser());
    trustlinesMock.mockResolvedValueOnce({
      account: USER_PUBLIC,
      accountExists: true,
      trustlines: new Map([
        [
          `GBPLOOP::${GBPLOOP_ISSUER}`,
          {
            code: 'GBPLOOP',
            issuer: GBPLOOP_ISSUER,
            balanceStroops: 70_000_000n,
            limitStroops: 0n,
          },
        ],
      ]),
      asOfMs: Date.now(),
    });
    // Prime the LKG cache…
    expect((await bodyOf(await getMyWalletHandler(makeCtx())))['stale']).toBe(false);

    // …then Horizon goes down.
    trustlinesMock.mockRejectedValue(new Error('horizon 504'));
    const res = await getMyWalletHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({
      address: USER_PUBLIC,
      provisioning: 'activated',
      balances: [{ assetCode: 'GBPLOOP', balance: '7.0000000' }],
      interestApyBps: 400,
      stale: true,
    });
  });

  it('falls back to empty balances + stale:true when Horizon errors with no prior snapshot', async () => {
    resolveUserMock.mockResolvedValue(activatedUser());
    trustlinesMock.mockRejectedValue(new Error('horizon 504'));
    const res = await getMyWalletHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({
      address: USER_PUBLIC,
      provisioning: 'activated',
      balances: [],
      interestApyBps: 400,
      stale: true,
    });
  });
});

describe('interestApyBps truthfulness (ADR 031 Phase D)', () => {
  it('advertises the APY only while the on-chain mint path is enabled', async () => {
    resolveUserMock.mockResolvedValue(
      activatedUser({ walletAddress: null, walletProvisioning: 'none' }),
    );
    envState.env = { INTEREST_APY_BASIS_POINTS: 400, LOOP_INTEREST_ONCHAIN_ENABLED: false };
    // Legacy off-chain accrual may be configured (APY 400) but never
    // moves the on-chain balance this surface shows — the chip must
    // read 0, not 400.
    const res = await getMyWalletHandler(makeCtx());
    expect((await bodyOf(res))['interestApyBps']).toBe(0);

    envState.env = { INTEREST_APY_BASIS_POINTS: 400, LOOP_INTEREST_ONCHAIN_ENABLED: true };
    const res2 = await getMyWalletHandler(makeCtx());
    expect((await bodyOf(res2))['interestApyBps']).toBe(400);
  });
});
