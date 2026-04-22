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
  orders: {
    currency: 'orders.currency',
    state: 'orders.state',
    fulfilledAt: 'orders.fulfilled_at',
    faceValueMinor: 'orders.face_value_minor',
    wholesaleMinor: 'orders.wholesale_minor',
    userCashbackMinor: 'orders.user_cashback_minor',
    loopMarginMinor: 'orders.loop_margin_minor',
  },
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminSupplierSpendHandler } from '../supplier-spend.js';

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

describe('adminSupplierSpendHandler', () => {
  it('returns empty rows when there is nothing in the window', async () => {
    const res = await adminSupplierSpendHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; since: string };
    expect(body.rows).toEqual([]);
    expect(typeof body.since).toBe('string');
  });

  it('normalises bigint/number aggregates to string and preserves count as number', async () => {
    state.rows = [
      {
        currency: 'GBP',
        count: '42',
        face_value_minor: '420000',
        wholesale_minor: 336000n,
        user_cashback_minor: 50400,
        loop_margin_minor: '33600',
      },
      {
        currency: 'USD',
        count: 7,
        face_value_minor: '70000',
        wholesale_minor: '56000',
        user_cashback_minor: '8400',
        loop_margin_minor: '5600',
      },
    ];
    const res = await adminSupplierSpendHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual({
      currency: 'GBP',
      count: 42,
      faceValueMinor: '420000',
      wholesaleMinor: '336000',
      userCashbackMinor: '50400',
      loopMarginMinor: '33600',
    });
    expect(body.rows[1]!['count']).toBe(7);
    expect(body.rows[1]!['wholesaleMinor']).toBe('56000');
  });

  it('accepts an ISO-8601 since and echoes it back', async () => {
    const since = '2026-04-15T00:00:00Z';
    const res = await adminSupplierSpendHandler(makeCtx({ since }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { since: string };
    expect(body.since).toBe('2026-04-15T00:00:00.000Z');
  });

  it('400 on malformed since', async () => {
    const res = await adminSupplierSpendHandler(makeCtx({ since: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('400 when since is more than 366 days ago', async () => {
    const tooOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminSupplierSpendHandler(makeCtx({ since: tooOld }));
    expect(res.status).toBe(400);
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [
        {
          currency: 'EUR',
          count: 1,
          face_value_minor: '1000',
          wholesale_minor: '800',
          user_cashback_minor: '120',
          loop_margin_minor: '80',
        },
      ],
    } as unknown as Array<Record<string, unknown>>;
    const res = await adminSupplierSpendHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!['currency']).toBe('EUR');
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminSupplierSpendHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
