/**
 * Per-user wallet card + reprovision action (ADR 037 §4.1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  trustlines: null as null | {
    account: string;
    accountExists: boolean;
    trustlines: Map<string, unknown>;
    asOfMs: number;
  },
  trustlinesThrow: null as Error | null,
  updateWheres: [] as unknown[],
  enqueueCalls: [] as string[],
  priorSnapshot: null as null | { status: number; body: Record<string, unknown> },
  discordCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../db/users.js', () => ({
  getUserById: vi.fn(async () => state.user),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    update: () => ({
      set: () => ({
        where: vi.fn(async (w: unknown) => {
          state.updateWheres.push(w);
          return [];
        }),
      }),
    }),
  },
}));

vi.mock('../../payments/horizon-trustlines.js', () => ({
  getAccountTrustlines: vi.fn(async () => {
    if (state.trustlinesThrow !== null) throw state.trustlinesThrow;
    return state.trustlines;
  }),
}));

vi.mock('../../wallet/provisioning.js', () => ({
  enqueueWalletProvisioning: vi.fn((userId: string) => {
    state.enqueueCalls.push(userId);
  }),
}));

vi.mock('../idempotency.js', () => ({
  IDEMPOTENCY_KEY_MIN: 16,
  IDEMPOTENCY_KEY_MAX: 128,
  validateIdempotencyKey: (k: string | undefined): k is string =>
    k !== undefined && k.length >= 16 && k.length <= 128,
  withIdempotencyGuard: vi.fn(
    async (
      _args: unknown,
      doWrite: () => Promise<{ status: number; body: Record<string, unknown> }>,
    ) => {
      if (state.priorSnapshot !== null) {
        return {
          replayed: true,
          status: state.priorSnapshot.status,
          body: state.priorSnapshot.body,
        };
      }
      const { status, body } = await doWrite();
      return { replayed: false, status, body };
    },
  ),
}));

vi.mock('../../discord.js', () => ({
  notifyAdminAudit: vi.fn((args: Record<string, unknown>) => {
    state.discordCalls.push(args);
  }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminGetUserWalletHandler, adminWalletReprovisionHandler } from '../user-wallet.js';

const TARGET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ADDRESS = `G${'A'.repeat(55)}`;
const actor = { id: '11111111-1111-1111-1111-111111111111', email: 'support@loop.test' };
const validKey = 'k'.repeat(32);

const walletUser = {
  id: TARGET_ID,
  email: 'target@loop.test',
  walletProvider: 'privy',
  walletId: 'clw123',
  walletAddress: ADDRESS,
  stellarAddress: null,
  walletProvisioning: 'wallet_created',
  walletProvisioningAttempts: 10,
  walletProvisioningLastAttemptAt: new Date('2026-06-11T00:00:00Z'),
};

function makeCtx(args: {
  userId?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Context {
  const store = new Map<string, unknown>([['user', actor]]);
  return {
    req: {
      param: (k: string) => (k === 'userId' ? (args.userId ?? TARGET_ID) : undefined),
      header: (k: string) => args.headers?.[k.toLowerCase()],
      json: async () => {
        if (args.body === undefined) throw new Error('no body');
        return args.body;
      },
    },
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.user = { ...walletUser };
  state.trustlines = {
    account: ADDRESS,
    accountExists: true,
    trustlines: new Map([
      [
        `USDLOOP::${ADDRESS}`,
        {
          code: 'USDLOOP',
          issuer: ADDRESS,
          balanceStroops: 123_456_700n,
          limitStroops: 10_000_000_000n,
        },
      ],
    ]),
    asOfMs: Date.parse('2026-06-12T09:00:00Z'),
  };
  state.trustlinesThrow = null;
  state.updateWheres = [];
  state.enqueueCalls = [];
  state.priorSnapshot = null;
  state.discordCalls = [];
});

describe('adminGetUserWalletHandler', () => {
  it('400 on bad uuid; 404 on missing user', async () => {
    expect((await adminGetUserWalletHandler(makeCtx({ userId: 'nope' }))).status).toBe(400);
    state.user = null;
    expect((await adminGetUserWalletHandler(makeCtx({}))).status).toBe(404);
  });

  it('returns provisioning state + on-chain balances (bigint-as-string)', async () => {
    const res = await adminGetUserWalletHandler(makeCtx({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({
      userId: TARGET_ID,
      provider: 'privy',
      walletId: 'clw123',
      walletAddress: ADDRESS,
      provisioning: 'wallet_created',
      provisioningAttempts: 10,
      provisioningLastAttemptAt: '2026-06-11T00:00:00.000Z',
    });
    expect(body.onChain.accountExists).toBe(true);
    expect(body.onChain.balances).toEqual([
      {
        assetCode: 'USDLOOP',
        assetIssuer: ADDRESS,
        balanceStroops: '123456700',
        limitStroops: '10000000000',
      },
    ]);
  });

  it('no wallet address → definitive empty on-chain snapshot, no Horizon call', async () => {
    state.user = { ...walletUser, walletAddress: null, walletProvisioning: 'none' };
    const res = await adminGetUserWalletHandler(makeCtx({}));
    const body = (await res.json()) as Record<string, any>;
    expect(body.onChain).toMatchObject({ accountExists: false, balances: [] });
  });

  it('Horizon outage → onChain null (no stale fallback on the admin card)', async () => {
    state.trustlinesThrow = new Error('horizon 504');
    const res = await adminGetUserWalletHandler(makeCtx({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.onChain).toBeNull();
  });
});

describe('adminWalletReprovisionHandler', () => {
  const reprovision = (over?: Partial<Parameters<typeof makeCtx>[0]>): Promise<Response> =>
    adminWalletReprovisionHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { reason: 'provisioning stuck — privy outage resolved' },
        ...over,
      }),
    );

  it('200: resets the budget, re-enqueues after commit, envelope + audit', async () => {
    const res = await reprovision();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toEqual({
      userId: TARGET_ID,
      priorProvisioning: 'wallet_created',
      attempts: 0,
      requeued: true,
    });
    expect(state.updateWheres).toHaveLength(1);
    expect(state.enqueueCalls).toEqual([TARGET_ID]);
    expect(state.discordCalls).toHaveLength(1);
  });

  it('409 WALLET_ALREADY_ACTIVATED when nothing needs re-driving', async () => {
    state.user = { ...walletUser, walletProvisioning: 'activated' };
    const res = await reprovision();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('WALLET_ALREADY_ACTIVATED');
    expect(state.enqueueCalls).toEqual([]);
  });

  it('404 on a missing user; 400 on missing key / reason', async () => {
    state.user = null;
    expect((await reprovision()).status).toBe(404);
    state.user = { ...walletUser };
    expect((await reprovision({ headers: {} })).status).toBe(400);
    expect((await reprovision({ body: { reason: 'x' } })).status).toBe(400);
  });

  it('a replayed snapshot does NOT re-enqueue provisioning', async () => {
    state.priorSnapshot = {
      status: 200,
      body: { result: { userId: TARGET_ID }, audit: { replayed: true } },
    };
    const res = await reprovision();
    expect(res.status).toBe(200);
    expect(state.enqueueCalls).toEqual([]);
    expect(state.discordCalls).toHaveLength(0);
  });
});
