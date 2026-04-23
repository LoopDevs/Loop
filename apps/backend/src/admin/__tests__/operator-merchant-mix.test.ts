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
    merchantId: 'orders.merchant_id',
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

import { adminOperatorMerchantMixHandler } from '../operator-merchant-mix.js';

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

describe('adminOperatorMerchantMixHandler', () => {
  it('400 when operatorId is missing', async () => {
    const res = await adminOperatorMerchantMixHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when operatorId has disallowed characters', async () => {
    const res = await adminOperatorMerchantMixHandler(makeCtx({ operatorId: 'bad slug' }));
    expect(res.status).toBe(400);
  });

  it('400 when operatorId exceeds 128 chars', async () => {
    const res = await adminOperatorMerchantMixHandler(makeCtx({ operatorId: 'x'.repeat(200) }));
    expect(res.status).toBe(400);
  });

  it('400 on malformed ?since', async () => {
    const res = await adminOperatorMerchantMixHandler(
      makeCtx({ operatorId: 'op-alpha-01' }, { since: 'nope' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when ?since is more than 366 days ago', async () => {
    const tooOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminOperatorMerchantMixHandler(
      makeCtx({ operatorId: 'op-alpha-01' }, { since: tooOld }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 200 with empty rows for an operator with no attributed orders', async () => {
    state.rows = [];
    const res = await adminOperatorMerchantMixHandler(makeCtx({ operatorId: 'op-idle' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      operatorId: string;
      rows: unknown[];
      since: string;
    };
    expect(body.operatorId).toBe('op-idle');
    expect(body.rows).toEqual([]);
    expect(typeof body.since).toBe('string');
  });

  it('maps rows with bigint/number normalisation and ISO lastOrderAt', async () => {
    state.rows = [
      {
        merchant_id: 'mctx-starbucks',
        order_count: 42n,
        fulfilled_count: '40',
        failed_count: 2,
        last_order_at: new Date('2026-04-22T11:00:00Z'),
      },
      {
        merchant_id: 'mctx-target',
        order_count: 5,
        fulfilled_count: 5n,
        failed_count: '0',
        last_order_at: '2026-04-21T18:00:00Z',
      },
    ];
    const res = await adminOperatorMerchantMixHandler(makeCtx({ operatorId: 'op-alpha-01' }));
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows).toEqual([
      {
        merchantId: 'mctx-starbucks',
        orderCount: 42,
        fulfilledCount: 40,
        failedCount: 2,
        lastOrderAt: '2026-04-22T11:00:00.000Z',
      },
      {
        merchantId: 'mctx-target',
        orderCount: 5,
        fulfilledCount: 5,
        failedCount: 0,
        lastOrderAt: '2026-04-21T18:00:00.000Z',
      },
    ]);
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [
        {
          merchant_id: 'mctx-solo',
          order_count: 1,
          fulfilled_count: 1,
          failed_count: 0,
          last_order_at: '2026-04-22T10:00:00Z',
        },
      ],
    };
    const res = await adminOperatorMerchantMixHandler(makeCtx({ operatorId: 'op-alpha-01' }));
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminOperatorMerchantMixHandler(makeCtx({ operatorId: 'op-alpha-01' }));
    expect(res.status).toBe(500);
  });
});
