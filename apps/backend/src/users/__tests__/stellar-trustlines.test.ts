import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  authPresent: true,
  dbUser: { id: 'user-1', email: 'u@x.com', stellarAddress: 'GUSER' as string | null } as {
    id: string;
    email: string;
    stellarAddress: string | null;
  } | null,
  configuredAssets: [
    { code: 'USDLOOP', issuer: 'GUSD' },
    { code: 'GBPLOOP', issuer: 'GGBP' },
    { code: 'EURLOOP', issuer: 'GEUR' },
  ] as ReadonlyArray<{ code: 'USDLOOP' | 'GBPLOOP' | 'EURLOOP'; issuer: string }>,
  snapshot: null as unknown,
  horizonThrow: null as Error | null,
}));

vi.mock('../../credits/payout-asset.js', () => ({
  configuredLoopPayableAssets: () => state.configuredAssets,
}));

vi.mock('../../payments/horizon-trustlines.js', () => ({
  getAccountTrustlines: vi.fn(async () => {
    if (state.horizonThrow !== null) throw state.horizonThrow;
    return state.snapshot;
  }),
}));

vi.mock('../../db/users.js', () => ({
  getUserById: vi.fn(async () => state.dbUser),
  upsertUserFromCtx: vi.fn(async () => state.dbUser),
}));

vi.mock('../../auth/jwt.js', () => ({
  decodeJwtPayload: vi.fn(() => ({ sub: 'user-1' })),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { getUserStellarTrustlinesHandler } from '../stellar-trustlines.js';

function fakeCtx(): Context {
  return {
    req: { query: (_k: string) => undefined, param: (_k: string) => undefined },
    get: (key: string) => {
      if (key !== 'auth') return undefined;
      return state.authPresent ? { kind: 'loop', userId: 'user-1' } : undefined;
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.authPresent = true;
  state.dbUser = { id: 'user-1', email: 'u@x.com', stellarAddress: 'GUSER' };
  state.snapshot = null;
  state.horizonThrow = null;
});

describe('getUserStellarTrustlinesHandler', () => {
  it('401 when auth context missing', async () => {
    state.authPresent = false;
    const res = await getUserStellarTrustlinesHandler(fakeCtx());
    expect(res.status).toBe(401);
  });

  it('returns stub rows + accountLinked=false when user has no address', async () => {
    state.dbUser = { id: 'user-1', email: 'u@x.com', stellarAddress: null };
    const res = await getUserStellarTrustlinesHandler(fakeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      address: string | null;
      accountLinked: boolean;
      accountExists: boolean;
      rows: Array<{ code: string; present: boolean }>;
    };
    expect(body.address).toBeNull();
    expect(body.accountLinked).toBe(false);
    expect(body.accountExists).toBe(false);
    expect(body.rows).toHaveLength(3);
    expect(body.rows.every((r) => !r.present)).toBe(true);
  });

  it('marks trustlines present + carries balance/limit when Horizon returns them', async () => {
    state.snapshot = {
      account: 'GUSER',
      accountExists: true,
      trustlines: new Map([
        [
          'USDLOOP::GUSD',
          {
            code: 'USDLOOP',
            issuer: 'GUSD',
            balanceStroops: 125_000_000n,
            limitStroops: 10_000_000_000n,
          },
        ],
      ]),
      asOfMs: 0,
    };
    const res = await getUserStellarTrustlinesHandler(fakeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accountLinked: boolean;
      accountExists: boolean;
      rows: Array<{
        code: string;
        issuer: string;
        present: boolean;
        balanceStroops: string;
        limitStroops: string;
      }>;
    };
    expect(body.accountLinked).toBe(true);
    expect(body.accountExists).toBe(true);
    const usd = body.rows.find((r) => r.code === 'USDLOOP');
    expect(usd?.present).toBe(true);
    expect(usd?.balanceStroops).toBe('125000000');
    expect(usd?.limitStroops).toBe('10000000000');
    const gbp = body.rows.find((r) => r.code === 'GBPLOOP');
    expect(gbp?.present).toBe(false);
    expect(gbp?.balanceStroops).toBe('0');
  });

  it('503 when Horizon throws', async () => {
    state.horizonThrow = new Error('Horizon 500');
    const res = await getUserStellarTrustlinesHandler(fakeCtx());
    expect(res.status).toBe(503);
  });

  it('carries accountExists=false through when Horizon reports an unfunded account', async () => {
    state.snapshot = {
      account: 'GUSER',
      accountExists: false,
      trustlines: new Map(),
      asOfMs: 0,
    };
    const res = await getUserStellarTrustlinesHandler(fakeCtx());
    const body = (await res.json()) as {
      accountLinked: boolean;
      accountExists: boolean;
      rows: Array<{ present: boolean }>;
    };
    expect(body.accountLinked).toBe(true);
    expect(body.accountExists).toBe(false);
    expect(body.rows.every((r) => !r.present)).toBe(true);
  });
});
