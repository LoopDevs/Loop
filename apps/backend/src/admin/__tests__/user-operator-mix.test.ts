import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as unknown,
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
    userId: 'orders.user_id',
    ctxOperatorId: 'orders.ctx_operator_id',
  },
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

import { adminUserOperatorMixHandler } from '../user-operator-mix.js';

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

function makeCtx(
  params: Record<string, string | undefined> = {},
  query: Record<string, string | undefined> = {},
): Context {
  return {
    req: {
      query: (k: string) => query[k],
      param: (k: string) => params[k],
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

describe('adminUserOperatorMixHandler', () => {
  it('400 when userId is missing', async () => {
    const res = await adminUserOperatorMixHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when userId is not a UUID', async () => {
    const res = await adminUserOperatorMixHandler(makeCtx({ userId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('400 on malformed ?since', async () => {
    const res = await adminUserOperatorMixHandler(
      makeCtx({ userId: VALID_UUID }, { since: 'nope' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when ?since is more than 366 days ago', async () => {
    const tooOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminUserOperatorMixHandler(
      makeCtx({ userId: VALID_UUID }, { since: tooOld }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 200 with empty rows for a user with no attributed orders', async () => {
    state.rows = [];
    const res = await adminUserOperatorMixHandler(makeCtx({ userId: VALID_UUID }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userId: string;
      rows: unknown[];
      since: string;
    };
    expect(body.userId).toBe(VALID_UUID);
    expect(body.rows).toEqual([]);
    expect(typeof body.since).toBe('string');
  });

  it('maps rows with bigint/number normalisation and ISO lastOrderAt', async () => {
    state.rows = [
      {
        operator_id: 'op-alpha-01',
        order_count: 12n,
        fulfilled_count: '11',
        failed_count: 1,
        last_order_at: new Date('2026-04-22T11:00:00Z'),
      },
      {
        operator_id: 'op-beta-02',
        order_count: 2,
        fulfilled_count: 2n,
        failed_count: '0',
        last_order_at: '2026-04-21T18:00:00Z',
      },
    ];
    const res = await adminUserOperatorMixHandler(makeCtx({ userId: VALID_UUID }));
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows).toEqual([
      {
        operatorId: 'op-alpha-01',
        orderCount: 12,
        fulfilledCount: 11,
        failedCount: 1,
        lastOrderAt: '2026-04-22T11:00:00.000Z',
      },
      {
        operatorId: 'op-beta-02',
        orderCount: 2,
        fulfilledCount: 2,
        failedCount: 0,
        lastOrderAt: '2026-04-21T18:00:00.000Z',
      },
    ]);
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
    };
    const res = await adminUserOperatorMixHandler(makeCtx({ userId: VALID_UUID }));
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminUserOperatorMixHandler(makeCtx({ userId: VALID_UUID }));
    expect(res.status).toBe(500);
  });
});
