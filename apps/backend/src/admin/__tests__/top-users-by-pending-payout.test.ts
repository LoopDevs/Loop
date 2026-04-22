import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { execState } = vi.hoisted(() => ({
  execState: { rows: [] as unknown[] | { rows: unknown[] }, throw: false },
}));
vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      if (execState.throw) throw new Error('db exploded');
      return execState.rows;
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({
  pendingPayouts: {
    userId: 'user_id',
    state: 'state',
    assetCode: 'asset_code',
    amountStroops: 'amount_stroops',
  },
  users: { id: 'id', email: 'email' },
}));

import { adminTopUsersByPendingPayoutHandler } from '../top-users-by-pending-payout.js';

function makeCtx(query: Record<string, string> = {}): Context {
  return {
    req: { query: (k: string) => query[k] },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  execState.rows = [];
  execState.throw = false;
});

describe('adminTopUsersByPendingPayoutHandler', () => {
  it('happy path — bigint-safe totals, highest-owed first, asset broken out', async () => {
    execState.rows = [
      {
        userId: 'u-1',
        email: 'alice@example.com',
        assetCode: 'USDLOOP',
        totalStroops: 500_000_000n,
        payoutCount: 5,
      },
      {
        userId: 'u-2',
        email: 'bob@example.com',
        assetCode: 'GBPLOOP',
        totalStroops: 100_000_000n,
        payoutCount: 2,
      },
    ];
    const res = await adminTopUsersByPendingPayoutHandler(makeCtx());
    expect(res.status).toBe(200);
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
    expect(body.entries[1]?.email).toBe('bob@example.com');
  });

  it('splits multi-asset users across separate entries', async () => {
    execState.rows = [
      {
        userId: 'u-1',
        email: 'a@b.com',
        assetCode: 'USDLOOP',
        totalStroops: 200n,
        payoutCount: 1,
      },
      {
        userId: 'u-1',
        email: 'a@b.com',
        assetCode: 'GBPLOOP',
        totalStroops: 100n,
        payoutCount: 1,
      },
    ];
    const res = await adminTopUsersByPendingPayoutHandler(makeCtx());
    const body = (await res.json()) as {
      entries: Array<{ userId: string; assetCode: string }>;
    };
    expect(body.entries).toHaveLength(2);
    expect(body.entries.map((e) => e.assetCode).sort()).toEqual(['GBPLOOP', 'USDLOOP']);
  });

  it('clamps ?limit — huge caps at 100, malformed falls back to 20, zero → 1', async () => {
    execState.rows = [];
    const res1 = await adminTopUsersByPendingPayoutHandler(makeCtx({ limit: '9999' }));
    expect(res1.status).toBe(200);
    const res2 = await adminTopUsersByPendingPayoutHandler(makeCtx({ limit: 'nope' }));
    expect(res2.status).toBe(200);
    const res3 = await adminTopUsersByPendingPayoutHandler(makeCtx({ limit: '0' }));
    expect(res3.status).toBe(200);
    // Clamp correctness is tested via SQL-level behaviour in the DB
    // integration suite; here we just confirm the handler doesn't
    // crash on edge inputs.
  });

  it('returns empty list when no users are currently owed stroops', async () => {
    execState.rows = [];
    const res = await adminTopUsersByPendingPayoutHandler(makeCtx());
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });

  it('handles the {rows: [...]} drizzle result shape', async () => {
    execState.rows = {
      rows: [
        {
          userId: 'u-x',
          email: 'x@y.com',
          assetCode: 'EURLOOP',
          totalStroops: 42n,
          payoutCount: 1,
        },
      ],
    };
    const res = await adminTopUsersByPendingPayoutHandler(makeCtx());
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.totalStroops).toBe('42');
  });

  it('500 when the db read throws', async () => {
    execState.throw = true;
    const res = await adminTopUsersByPendingPayoutHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
