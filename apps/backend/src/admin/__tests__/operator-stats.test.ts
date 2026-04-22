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
    state: 'orders.state',
    createdAt: 'orders.created_at',
    ctxOperatorId: 'orders.ctx_operator_id',
  },
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminOperatorStatsHandler } from '../operator-stats.js';

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

describe('adminOperatorStatsHandler', () => {
  it('returns empty rows when no orders in the window', async () => {
    const res = await adminOperatorStatsHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; since: string };
    expect(body.rows).toEqual([]);
    expect(typeof body.since).toBe('string');
  });

  it('normalises bigint/number counts and ISO-serialises lastOrderAt', async () => {
    state.rows = [
      {
        operator_id: 'op-alpha-01',
        order_count: '42',
        fulfilled_count: 39n,
        failed_count: 3,
        last_order_at: new Date('2026-04-22T09:30:00Z'),
      },
      {
        operator_id: 'op-beta-02',
        order_count: 11,
        fulfilled_count: '11',
        failed_count: '0',
        last_order_at: '2026-04-21T18:00:00Z',
      },
    ];
    const res = await adminOperatorStatsHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual({
      operatorId: 'op-alpha-01',
      orderCount: 42,
      fulfilledCount: 39,
      failedCount: 3,
      lastOrderAt: '2026-04-22T09:30:00.000Z',
    });
    expect(body.rows[1]!['lastOrderAt']).toBe('2026-04-21T18:00:00.000Z');
  });

  it('accepts an ISO-8601 since and echoes it back', async () => {
    const since = '2026-04-15T00:00:00Z';
    const res = await adminOperatorStatsHandler(makeCtx({ since }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { since: string };
    expect(body.since).toBe('2026-04-15T00:00:00.000Z');
  });

  it('400 on malformed since', async () => {
    const res = await adminOperatorStatsHandler(makeCtx({ since: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('400 when since is more than 366 days ago', async () => {
    const tooOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminOperatorStatsHandler(makeCtx({ since: tooOld }));
    expect(res.status).toBe(400);
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [
        {
          operator_id: 'op-solo',
          order_count: 1,
          fulfilled_count: 1,
          failed_count: 0,
          last_order_at: '2026-04-22T10:00:00Z',
        },
      ],
    } as unknown as Array<Record<string, unknown>>;
    const res = await adminOperatorStatsHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!['operatorId']).toBe('op-solo');
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminOperatorStatsHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
