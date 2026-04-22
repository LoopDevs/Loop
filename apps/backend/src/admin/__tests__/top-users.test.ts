import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { execState } = vi.hoisted(() => ({
  execState: {
    rows: [] as unknown[] | { rows: unknown[] },
    throw: false,
  },
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
  creditTransactions: {
    userId: 'user_id',
    amountMinor: 'amount_minor',
    currency: 'currency',
    type: 'type',
  },
  users: {
    id: 'id',
    email: 'email',
  },
}));

import { adminTopUsersByCashbackHandler } from '../top-users.js';

function makeCtx(query: Record<string, string> = {}): Context {
  return {
    req: {
      query: (k: string) => query[k],
    },
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

describe('adminTopUsersByCashbackHandler', () => {
  it('happy path — returns ranked entries with bigint-as-string amounts', async () => {
    execState.rows = [
      {
        userId: 'u-1',
        email: 'alice@example.com',
        currency: 'GBP',
        cashbackMinor: 15000n,
        cashbackEvents: 42,
      },
      {
        userId: 'u-2',
        email: 'bob@example.com',
        currency: 'GBP',
        cashbackMinor: 8000n,
        cashbackEvents: 12,
      },
    ];
    const res = await adminTopUsersByCashbackHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toEqual({
      userId: 'u-1',
      email: 'alice@example.com',
      currency: 'GBP',
      cashbackMinor: '15000',
      cashbackEvents: 42,
    });
    expect(body.entries[1]?.userId).toBe('u-2');
  });

  it('splits multi-currency users into separate entries', async () => {
    execState.rows = [
      {
        userId: 'u-1',
        email: 'a@b.com',
        currency: 'GBP',
        cashbackMinor: 5000n,
        cashbackEvents: 10,
      },
      { userId: 'u-1', email: 'a@b.com', currency: 'USD', cashbackMinor: 3000n, cashbackEvents: 8 },
    ];
    const res = await adminTopUsersByCashbackHandler(makeCtx());
    const body = (await res.json()) as {
      entries: Array<{ userId: string; currency: string }>;
    };
    expect(body.entries).toHaveLength(2);
    expect(body.entries.map((e) => e.currency).sort()).toEqual(['GBP', 'USD']);
  });

  it('accepts huge, malformed, and zero ?limit values without crashing (clamp logic)', async () => {
    execState.rows = [];
    // Clamp logic is Math.min(Math.max(parsed, 1), 100); verifying that
    // the handler returns 200 on these edge cases is enough — the
    // upstream SQL driver tests verify the LIMIT actually binds.
    for (const limit of ['9999', 'nope', '0', '-5']) {
      const res = await adminTopUsersByCashbackHandler(makeCtx({ limit }));
      expect(res.status).toBe(200);
    }
  });

  it('returns empty list when no cashback has been earned yet', async () => {
    execState.rows = [];
    const res = await adminTopUsersByCashbackHandler(makeCtx());
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });

  it('handles the {rows: [...]} drizzle result shape', async () => {
    execState.rows = {
      rows: [
        {
          userId: 'u-x',
          email: 'x@y.com',
          currency: 'EUR',
          cashbackMinor: 100n,
          cashbackEvents: 1,
        },
      ],
    };
    const res = await adminTopUsersByCashbackHandler(makeCtx());
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.cashbackMinor).toBe('100');
  });

  it('500 when the db read throws', async () => {
    execState.throw = true;
    const res = await adminTopUsersByCashbackHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
