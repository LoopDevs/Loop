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
    id: 'orders.id',
    state: 'orders.state',
    currency: 'orders.currency',
    fulfilledAt: 'orders.fulfilled_at',
    faceValueMinor: 'orders.face_value_minor',
    wholesaleMinor: 'orders.wholesale_minor',
    userCashbackMinor: 'orders.user_cashback_minor',
    loopMarginMinor: 'orders.loop_margin_minor',
  },
  HOME_CURRENCIES: ['USD', 'GBP', 'EUR'] as const,
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminSupplierSpendActivityHandler } from '../supplier-spend-activity.js';

function makeCtx(query: Record<string, string | undefined> = {}): Context {
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

describe('adminSupplierSpendActivityHandler', () => {
  it('defaults to 30 days with no currency filter', async () => {
    const res = await adminSupplierSpendActivityHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      windowDays: number;
      currency: string | null;
      days: unknown[];
    };
    expect(body.windowDays).toBe(30);
    expect(body.currency).toBeNull();
    expect(body.days).toEqual([]);
  });

  it('clamps ?days to [1, 180]', async () => {
    const below = await adminSupplierSpendActivityHandler(makeCtx({ days: '0' }));
    expect(((await below.json()) as { windowDays: number }).windowDays).toBe(1);

    const above = await adminSupplierSpendActivityHandler(makeCtx({ days: '9999' }));
    expect(((await above.json()) as { windowDays: number }).windowDays).toBe(180);
  });

  it('coerces NaN ?days back to default 30', async () => {
    const res = await adminSupplierSpendActivityHandler(makeCtx({ days: 'nope' }));
    expect(((await res.json()) as { windowDays: number }).windowDays).toBe(30);
  });

  it('normalises ?currency to upper case', async () => {
    const res = await adminSupplierSpendActivityHandler(makeCtx({ currency: 'gbp' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { currency: string }).currency).toBe('GBP');
  });

  it('400 on unknown ?currency', async () => {
    const res = await adminSupplierSpendActivityHandler(makeCtx({ currency: 'JPY' }));
    expect(res.status).toBe(400);
  });

  it('maps rows preserving bigint precision on wholesale sums', async () => {
    state.rows = [
      {
        day: '2026-04-20',
        currency: 'USD',
        count: 42n,
        face_value_minor: '2500000',
        wholesale_minor: '2400000',
        user_cashback_minor: '75000',
        loop_margin_minor: '25000',
      },
      {
        day: new Date('2026-04-21T00:00:00Z'),
        currency: 'GBP',
        count: 5,
        face_value_minor: 100n,
        wholesale_minor: 95n,
        user_cashback_minor: 3n,
        loop_margin_minor: 2n,
      },
    ];
    const res = await adminSupplierSpendActivityHandler(makeCtx());
    const body = (await res.json()) as {
      days: Array<Record<string, unknown>>;
    };
    expect(body.days).toEqual([
      {
        day: '2026-04-20',
        currency: 'USD',
        count: 42,
        faceValueMinor: '2500000',
        wholesaleMinor: '2400000',
        userCashbackMinor: '75000',
        loopMarginMinor: '25000',
      },
      {
        day: '2026-04-21',
        currency: 'GBP',
        count: 5,
        faceValueMinor: '100',
        wholesaleMinor: '95',
        userCashbackMinor: '3',
        loopMarginMinor: '2',
      },
    ]);
  });

  it('preserves bigint precision past 2^53 on wholesale sums', async () => {
    state.rows = [
      {
        day: '2026-04-20',
        currency: 'USD',
        count: 1n,
        face_value_minor: '9007199254741045',
        wholesale_minor: '9007199254741045',
        user_cashback_minor: '0',
        loop_margin_minor: '0',
      },
    ];
    const res = await adminSupplierSpendActivityHandler(makeCtx({ currency: 'USD' }));
    const body = (await res.json()) as { days: Array<Record<string, string>> };
    expect(body.days[0]!['wholesaleMinor']).toBe('9007199254741045');
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [
        {
          day: '2026-04-22',
          currency: 'USD',
          count: 1,
          face_value_minor: '100',
          wholesale_minor: '95',
          user_cashback_minor: '3',
          loop_margin_minor: '2',
        },
      ],
    };
    const res = await adminSupplierSpendActivityHandler(makeCtx({ currency: 'USD' }));
    const body = (await res.json()) as { days: unknown[] };
    expect(body.days).toHaveLength(1);
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminSupplierSpendActivityHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
