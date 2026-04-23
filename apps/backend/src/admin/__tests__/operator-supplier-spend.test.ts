import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const { state, executeMock } = vi.hoisted(() => {
  const state = {
    rows: [] as unknown,
    throwErr: null as Error | null,
  };
  const executeMock = vi.fn(async () => {
    if (state.throwErr !== null) throw state.throwErr;
    return state.rows;
  });
  return { state, executeMock };
});

vi.mock('../../db/client.js', () => ({
  db: { execute: executeMock },
}));

vi.mock('../../db/schema.js', () => ({
  orders: {
    ctxOperatorId: 'orders.ctx_operator_id',
    state: 'orders.state',
    currency: 'orders.currency',
    faceValueMinor: 'orders.face_value_minor',
    wholesaleMinor: 'orders.wholesale_minor',
    userCashbackMinor: 'orders.user_cashback_minor',
    loopMarginMinor: 'orders.loop_margin_minor',
    fulfilledAt: 'orders.fulfilled_at',
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

import { adminOperatorSupplierSpendHandler } from '../operator-supplier-spend.js';

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
  executeMock.mockClear();
});

describe('adminOperatorSupplierSpendHandler', () => {
  it('400 when operatorId is missing', async () => {
    const res = await adminOperatorSupplierSpendHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when operatorId has disallowed characters', async () => {
    const res = await adminOperatorSupplierSpendHandler(makeCtx({ operatorId: 'bad slug' }));
    expect(res.status).toBe(400);
  });

  it('400 when operatorId exceeds 128 chars', async () => {
    const res = await adminOperatorSupplierSpendHandler(makeCtx({ operatorId: 'x'.repeat(200) }));
    expect(res.status).toBe(400);
  });

  it('400 on malformed ?since', async () => {
    const res = await adminOperatorSupplierSpendHandler(
      makeCtx({ operatorId: 'primary' }, { since: 'not-a-date' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when ?since is more than 366 days ago', async () => {
    const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminOperatorSupplierSpendHandler(
      makeCtx({ operatorId: 'primary' }, { since: oldDate }),
    );
    expect(res.status).toBe(400);
  });

  it('returns empty rows for an operator with no fulfilled orders in the window', async () => {
    state.rows = [];
    const res = await adminOperatorSupplierSpendHandler(
      makeCtx({ operatorId: 'drained_operator' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      operatorId: string;
      rows: unknown[];
    };
    expect(body.operatorId).toBe('drained_operator');
    expect(body.rows).toEqual([]);
  });

  it('maps rows into the per-currency aggregate shape', async () => {
    state.rows = [
      {
        currency: 'USD',
        count: 50n,
        face_value_minor: 2500000n,
        wholesale_minor: 2400000n,
        user_cashback_minor: 75000n,
        loop_margin_minor: 25000n,
      },
      {
        currency: 'GBP',
        count: 12n,
        face_value_minor: 600000n,
        wholesale_minor: 580000n,
        user_cashback_minor: 15000n,
        loop_margin_minor: 5000n,
      },
    ];
    const res = await adminOperatorSupplierSpendHandler(makeCtx({ operatorId: 'primary' }));
    const body = (await res.json()) as {
      rows: Array<{
        currency: string;
        count: number;
        wholesaleMinor: string;
      }>;
    };
    expect(body.rows).toEqual([
      {
        currency: 'USD',
        count: 50,
        faceValueMinor: '2500000',
        wholesaleMinor: '2400000',
        userCashbackMinor: '75000',
        loopMarginMinor: '25000',
      },
      {
        currency: 'GBP',
        count: 12,
        faceValueMinor: '600000',
        wholesaleMinor: '580000',
        userCashbackMinor: '15000',
        loopMarginMinor: '5000',
      },
    ]);
  });

  it('preserves bigint precision past 2^53 on wholesale sums', async () => {
    state.rows = [
      {
        currency: 'USD',
        count: 1n,
        face_value_minor: 9007199254740992n + 53n,
        wholesale_minor: 9007199254740992n + 53n,
        user_cashback_minor: 0n,
        loop_margin_minor: 0n,
      },
    ];
    const res = await adminOperatorSupplierSpendHandler(makeCtx({ operatorId: 'primary' }));
    const body = (await res.json()) as {
      rows: Array<{ wholesaleMinor: string }>;
    };
    expect(body.rows[0]?.wholesaleMinor).toBe('9007199254741045');
  });

  it('handles the { rows } envelope shape', async () => {
    state.rows = {
      rows: [
        {
          currency: 'USD',
          count: 1n,
          face_value_minor: 100n,
          wholesale_minor: 95n,
          user_cashback_minor: 3n,
          loop_margin_minor: 2n,
        },
      ],
    };
    const res = await adminOperatorSupplierSpendHandler(makeCtx({ operatorId: 'primary' }));
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
  });

  it('500 when the db throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminOperatorSupplierSpendHandler(makeCtx({ operatorId: 'primary' }));
    expect(res.status).toBe(500);
  });
});
