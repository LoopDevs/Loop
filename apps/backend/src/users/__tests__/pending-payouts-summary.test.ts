import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<{
    assetCode: string;
    state: string;
    count: number;
    totalStroops: bigint;
    oldestCreatedAtMs: number;
  }>,
  /** When false, `c.get('auth')` returns undefined — simulates missing auth. */
  authPresent: true,
  /** When null, `getUserById` returns null — triggers the 401 path. */
  dbUser: { id: 'user-1', email: 'u@x.com' } as { id: string; email: string } | null,
}));

vi.mock('../../credits/pending-payouts.js', () => ({
  pendingPayoutsSummaryForUser: vi.fn(async () => state.rows),
}));

vi.mock('../../db/users.js', () => ({
  getUserById: vi.fn(async () => state.dbUser),
  upsertUserFromCtx: vi.fn(async () => state.dbUser),
}));

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(), update: vi.fn(), query: { userCredits: { findFirst: vi.fn() } } },
}));

vi.mock('../../db/schema.js', () => ({
  users: {},
  creditTransactions: {},
  userCredits: {},
  orders: {},
  HOME_CURRENCIES: ['USD', 'GBP', 'EUR'],
  PAYOUT_STATES: ['pending', 'submitted', 'confirmed', 'failed'],
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { getUserPendingPayoutsSummaryHandler } from '../handler.js';

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
  state.rows = [];
  state.authPresent = true;
  state.dbUser = { id: 'user-1', email: 'u@x.com' };
});

describe('getUserPendingPayoutsSummaryHandler', () => {
  it('returns empty rows for a user with no in-flight payouts', async () => {
    const res = await getUserPendingPayoutsSummaryHandler(fakeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it('serialises bigint totalStroops as strings and ISO dates', async () => {
    state.rows = [
      {
        assetCode: 'USDLOOP',
        state: 'pending',
        count: 2,
        totalStroops: 12_345_000n,
        oldestCreatedAtMs: Date.parse('2026-04-22T10:00:00Z'),
      },
      {
        assetCode: 'USDLOOP',
        state: 'submitted',
        count: 1,
        totalStroops: 5_000_000n,
        oldestCreatedAtMs: Date.parse('2026-04-22T11:30:00Z'),
      },
    ];
    const res = await getUserPendingPayoutsSummaryHandler(fakeCtx());
    const body = (await res.json()) as {
      rows: Array<{
        assetCode: string;
        state: string;
        count: number;
        totalStroops: string;
        oldestCreatedAt: string;
      }>;
    };
    expect(body.rows).toEqual([
      {
        assetCode: 'USDLOOP',
        state: 'pending',
        count: 2,
        totalStroops: '12345000',
        oldestCreatedAt: '2026-04-22T10:00:00.000Z',
      },
      {
        assetCode: 'USDLOOP',
        state: 'submitted',
        count: 1,
        totalStroops: '5000000',
        oldestCreatedAt: '2026-04-22T11:30:00.000Z',
      },
    ]);
  });

  it('401 when auth context is missing', async () => {
    state.authPresent = false;
    const res = await getUserPendingPayoutsSummaryHandler(fakeCtx());
    expect(res.status).toBe(401);
  });

  it('401 when getUserById returns null (stale jwt / deleted user)', async () => {
    state.dbUser = null;
    const res = await getUserPendingPayoutsSummaryHandler(fakeCtx());
    expect(res.status).toBe(401);
  });
});
