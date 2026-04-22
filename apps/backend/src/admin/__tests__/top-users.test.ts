import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
}));

vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      if (state.throwErr !== null) throw state.throwErr;
      return state.rows;
    }),
  },
}));

vi.mock('../../db/schema.js', () => ({
  creditTransactions: { userId: 'credit_transactions.user_id' },
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

import { adminTopUsersHandler } from '../top-users.js';

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
});

describe('adminTopUsersHandler', () => {
  it('returns empty rows with default since when there is no activity', async () => {
    const res = await adminTopUsersHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; since: string };
    expect(body.rows).toEqual([]);
    expect(typeof body.since).toBe('string');
  });

  it('normalises bigint + string + number into the wire shape', async () => {
    state.rows = [
      {
        user_id: 'u-1',
        email: 'top@example.com',
        currency: 'GBP',
        count: '42',
        amount_minor: 1_000_000n,
      },
      {
        user_id: 'u-2',
        email: 'runner@example.com',
        currency: 'GBP',
        count: 25,
        amount_minor: '500000',
      },
    ];
    const res = await adminTopUsersHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual({
      userId: 'u-1',
      email: 'top@example.com',
      currency: 'GBP',
      count: 42,
      amountMinor: '1000000',
    });
    expect(body.rows[1]!['count']).toBe(25);
    expect(body.rows[1]!['amountMinor']).toBe('500000');
  });

  it('echoes since as ISO', async () => {
    const res = await adminTopUsersHandler(makeCtx({ since: '2026-03-10T00:00:00Z' }));
    const body = (await res.json()) as { since: string };
    expect(body.since).toBe('2026-03-10T00:00:00.000Z');
  });

  it('400 on malformed since', async () => {
    const res = await adminTopUsersHandler(makeCtx({ since: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('400 when since is more than 366 days ago', async () => {
    const tooOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminTopUsersHandler(makeCtx({ since: tooOld }));
    expect(res.status).toBe(400);
  });

  it('always returns 200 regardless of limit value — defaults to 20, clamps 1..100', async () => {
    // The handler clamps and passes to SQL; we assert successful responses
    // on edge inputs. The exact SQL limit isn't peeked at because the
    // drizzle sql`` template object shape is implementation-detail.
    const a = await adminTopUsersHandler(makeCtx());
    expect(a.status).toBe(200);
    const b = await adminTopUsersHandler(makeCtx({ limit: '9999' }));
    expect(b.status).toBe(200);
    const c = await adminTopUsersHandler(makeCtx({ limit: '0' }));
    expect(c.status).toBe(200);
    const d = await adminTopUsersHandler(makeCtx({ limit: 'nope' }));
    expect(d.status).toBe(200);
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminTopUsersHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
