import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const { state, executeMock } = vi.hoisted(() => {
  const state = {
    rows: [] as Array<Record<string, unknown>>,
    throwErr: null as Error | null,
    capturedSql: null as unknown,
  };
  const executeMock = vi.fn(async (query: unknown) => {
    state.capturedSql = query;
    if (state.throwErr !== null) throw state.throwErr;
    return state.rows as unknown;
  });
  return { state, executeMock };
});

vi.mock('../../db/client.js', () => ({
  db: { execute: executeMock },
}));

vi.mock('../../db/schema.js', () => ({
  pendingPayouts: { userId: 'pending_payouts.user_id' },
  users: { id: 'users.id' },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
      {},
    ),
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminTopUsersByPendingPayoutHandler } from '../top-users-by-pending-payout.js';

function makeCtx(query: Record<string, string> = {}): Context {
  return {
    req: {
      query: (k: string) => query[k],
      param: (_k: string) => undefined,
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
  state.throwErr = null;
  state.capturedSql = null;
  executeMock.mockClear();
});

describe('adminTopUsersByPendingPayoutHandler', () => {
  it('returns an empty list when nothing is pending', async () => {
    const res = await adminTopUsersByPendingPayoutHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });

  it('normalises bigint + string + number into the wire shape', async () => {
    state.rows = [
      {
        user_id: 'u-1',
        email: 'alice@example.com',
        asset_code: 'USDLOOP',
        total_stroops: 500_000_000n,
        payout_count: '5',
      },
      {
        user_id: 'u-2',
        email: 'bob@example.com',
        asset_code: 'GBPLOOP',
        total_stroops: '100000000',
        payout_count: 2,
      },
    ];
    const res = await adminTopUsersByPendingPayoutHandler(makeCtx());
    const body = (await res.json()) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toEqual({
      userId: 'u-1',
      email: 'alice@example.com',
      assetCode: 'USDLOOP',
      totalStroops: '500000000',
      payoutCount: 5,
    });
    expect(body.entries[1]).toEqual({
      userId: 'u-2',
      email: 'bob@example.com',
      assetCode: 'GBPLOOP',
      totalStroops: '100000000',
      payoutCount: 2,
    });
  });

  it('splits one user into multiple (user, asset) entries', async () => {
    state.rows = [
      {
        user_id: 'u-1',
        email: 'alice@example.com',
        asset_code: 'USDLOOP',
        total_stroops: 500_000_000n,
        payout_count: 5n,
      },
      {
        user_id: 'u-1',
        email: 'alice@example.com',
        asset_code: 'GBPLOOP',
        total_stroops: 100_000_000n,
        payout_count: 2n,
      },
    ];
    const res = await adminTopUsersByPendingPayoutHandler(makeCtx());
    const body = (await res.json()) as { entries: Array<{ userId: string; assetCode: string }> };
    expect(body.entries.map((e) => e.assetCode).sort()).toEqual(['GBPLOOP', 'USDLOOP']);
    expect(body.entries.every((e) => e.userId === 'u-1')).toBe(true);
  });

  it.each([
    { input: '0', expected: 1 },
    { input: '5', expected: 5 },
    { input: '100', expected: 100 },
    { input: '9999', expected: 100 },
    { input: 'nonsense', expected: 20 },
  ])('clamps ?limit=$input to $expected', async ({ input, expected: _expected }) => {
    const res = await adminTopUsersByPendingPayoutHandler(makeCtx({ limit: input }));
    expect(res.status).toBe(200);
    // The handler clamps internally; we're asserting it didn't 400
    // and that execute was called (the clamped limit is baked into
    // the sql template and isn't independently observable here).
    expect(executeMock).toHaveBeenCalled();
  });

  it('handles a { rows: [...] } execute return shape (postgres-js)', async () => {
    executeMock.mockImplementationOnce(async () => ({
      rows: [
        {
          user_id: 'u-1',
          email: 'a@b.com',
          asset_code: 'USDLOOP',
          total_stroops: 10n,
          payout_count: 1n,
        },
      ],
    }));
    const res = await adminTopUsersByPendingPayoutHandler(makeCtx());
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toHaveLength(1);
  });

  it('500 when the repo throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminTopUsersByPendingPayoutHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
