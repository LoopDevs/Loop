import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

/**
 * `GET /api/me/vault-apy` handler tests (ADR 031 §D8, V5b): auth
 * gating, per-asset assembly (LOOPUSD/LOOPEUR from the vault list,
 * GBPLOOP behind the same truthfulness gate `wallet-handler.ts` uses),
 * never-500 on a DB failure, and — the ADR 031 §User-facing display
 * requirement — no yield-source/mechanism word ever appears in the
 * response.
 */

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { envState } = vi.hoisted(() => ({
  envState: {
    env: { LOOP_INTEREST_ONCHAIN_ENABLED: true } as { LOOP_INTEREST_ONCHAIN_ENABLED: boolean },
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
vi.mock('../../credits/interest-mint.js', () => ({
  ONCHAIN_MINT_ELIGIBLE_ASSETS: new Set(['GBPLOOP']),
}));

const { vaultApyMocks } = vi.hoisted(() => ({
  vaultApyMocks: {
    listVaultApyAssets: vi.fn(),
    computeGbploopApy: vi.fn(),
  },
}));
vi.mock('../../credits/vaults/vault-apy.js', () => ({
  listVaultApyAssets: vaultApyMocks.listVaultApyAssets,
  computeGbploopApy: vaultApyMocks.computeGbploopApy,
}));

import { getVaultApyHandler } from '../vault-apy-handler.js';

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

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  resolveUserMock.mockReset();
  resolveUserMock.mockResolvedValue({ id: 'user-uuid' });
  envState.env = { LOOP_INTEREST_ONCHAIN_ENABLED: true };
  assetsState.assets = [
    { code: 'GBPLOOP', issuer: 'GISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
  ];
  vaultApyMocks.listVaultApyAssets.mockReset();
  vaultApyMocks.listVaultApyAssets.mockResolvedValue([]);
  vaultApyMocks.computeGbploopApy.mockReset();
  vaultApyMocks.computeGbploopApy.mockResolvedValue({ past30dApy: null, past90dRange: null });
});

describe('getVaultApyHandler', () => {
  it('401 when the caller is not loop-authed', async () => {
    resolveUserMock.mockResolvedValue(null);
    const res = await getVaultApyHandler(makeCtx());
    expect(res.status).toBe(401);
  });

  it('503 (never-500) when resolving the user throws', async () => {
    resolveUserMock.mockRejectedValue(new Error('db down'));
    const res = await getVaultApyHandler(makeCtx());
    expect(res.status).toBe(503);
    expect((await bodyOf(res))['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('503 (never-500) when computing APY throws', async () => {
    vaultApyMocks.listVaultApyAssets.mockRejectedValue(new Error('db down'));
    const res = await getVaultApyHandler(makeCtx());
    expect(res.status).toBe(503);
    expect((await bodyOf(res))['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('returns an empty asset list when vaults are disabled and no GBPLOOP interest path is configured', async () => {
    vaultApyMocks.listVaultApyAssets.mockResolvedValue([]);
    assetsState.assets = [];
    const res = await getVaultApyHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body['assets']).toEqual([]);
    expect(typeof body['disclaimerKey']).toBe('string');
  });

  it('includes every active vault asset with its computed APY', async () => {
    vaultApyMocks.listVaultApyAssets.mockResolvedValue([
      {
        assetCode: 'LOOPUSD',
        network: 'testnet',
        apy: { past30dApy: 0.031, past90dRange: { minApy: 0.028, maxApy: 0.035 } },
      },
      { assetCode: 'LOOPEUR', network: 'testnet', apy: { past30dApy: null, past90dRange: null } },
    ]);
    assetsState.assets = [];
    const res = await getVaultApyHandler(makeCtx());
    const body = await bodyOf(res);
    expect(body['assets']).toEqual([
      { assetCode: 'LOOPUSD', past30dApy: 0.031, past90dRange: { minApy: 0.028, maxApy: 0.035 } },
      { assetCode: 'LOOPEUR', past30dApy: null, past90dRange: null },
    ]);
  });

  it('includes GBPLOOP only when the on-chain mint path is enabled AND this deployment has GBPLOOP configured', async () => {
    vaultApyMocks.computeGbploopApy.mockResolvedValue({
      past30dApy: 0.03,
      past90dRange: { minApy: 0.029, maxApy: 0.031 },
    });

    // Flag off — omitted even though GBPLOOP is configured.
    envState.env = { LOOP_INTEREST_ONCHAIN_ENABLED: false };
    let res = await getVaultApyHandler(makeCtx());
    expect((await bodyOf(res))['assets']).toEqual([]);
    expect(vaultApyMocks.computeGbploopApy).not.toHaveBeenCalled();

    // Flag on, but this deployment has no GBPLOOP configured — still omitted.
    envState.env = { LOOP_INTEREST_ONCHAIN_ENABLED: true };
    assetsState.assets = [
      { code: 'USDLOOP', issuer: 'GUSDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
    ];
    res = await getVaultApyHandler(makeCtx());
    expect((await bodyOf(res))['assets']).toEqual([]);

    // Flag on AND configured — included.
    assetsState.assets = [
      { code: 'GBPLOOP', issuer: 'GISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
    ];
    res = await getVaultApyHandler(makeCtx());
    expect((await bodyOf(res))['assets']).toEqual([
      { assetCode: 'GBPLOOP', past30dApy: 0.03, past90dRange: { minApy: 0.029, maxApy: 0.031 } },
    ]);
  });

  it('never mentions the yield mechanism anywhere in the response (ADR 031 §User-facing display)', async () => {
    vaultApyMocks.listVaultApyAssets.mockResolvedValue([
      {
        assetCode: 'LOOPUSD',
        network: 'testnet',
        apy: { past30dApy: 0.031, past90dRange: { minApy: 0.028, maxApy: 0.035 } },
      },
    ]);
    vaultApyMocks.computeGbploopApy.mockResolvedValue({
      past30dApy: 0.03,
      past90dRange: { minApy: 0.029, maxApy: 0.031 },
    });
    const res = await getVaultApyHandler(makeCtx());
    const raw = JSON.stringify(await bodyOf(res));
    expect(raw).not.toMatch(/defindex|blend|soroban|strategy/i);
  });
});
