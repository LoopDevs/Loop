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

import { adminOrdersActivityHandler } from '../orders-activity.js';

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

describe('adminOrdersActivityHandler', () => {
  it('returns empty rows when the DB returns nothing', async () => {
    const res = await adminOrdersActivityHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number; rows: unknown[] };
    expect(body.days).toBe(30);
    expect(body.rows).toEqual([]);
  });

  it('shapes each day with bigint + number coercion', async () => {
    state.rows = [
      {
        day: '2026-04-20',
        count: '5',
        face_value_minor: 25_000n,
        wholesale_minor: '20000',
        user_cashback_minor: 3000,
        loop_margin_minor: 2000n,
      },
      {
        day: '2026-04-21',
        count: 0,
        face_value_minor: 0,
        wholesale_minor: '0',
        user_cashback_minor: 0n,
        loop_margin_minor: '0',
      },
    ];
    const res = await adminOrdersActivityHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual({
      day: '2026-04-20',
      count: 5,
      faceValueMinor: '25000',
      wholesaleMinor: '20000',
      userCashbackMinor: '3000',
      loopMarginMinor: '2000',
    });
    expect(body.rows[1]).toEqual({
      day: '2026-04-21',
      count: 0,
      faceValueMinor: '0',
      wholesaleMinor: '0',
      userCashbackMinor: '0',
      loopMarginMinor: '0',
    });
  });

  it('handles Date-typed day values from the pg driver', async () => {
    state.rows = [
      {
        day: new Date('2026-04-20T00:00:00Z'),
        count: '1',
        face_value_minor: '100',
        wholesale_minor: '80',
        user_cashback_minor: '12',
        loop_margin_minor: '8',
      },
    ];
    const res = await adminOrdersActivityHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows[0]!['day']).toBe('2026-04-20');
  });

  it('clamps days — huge → 180, bad → 30, 0 → 1', async () => {
    const huge = (await (await adminOrdersActivityHandler(makeCtx({ days: '9999' }))).json()) as {
      days: number;
    };
    expect(huge.days).toBe(180);

    const bad = (await (await adminOrdersActivityHandler(makeCtx({ days: 'nope' }))).json()) as {
      days: number;
    };
    expect(bad.days).toBe(30);

    const zero = (await (await adminOrdersActivityHandler(makeCtx({ days: '0' }))).json()) as {
      days: number;
    };
    expect(zero.days).toBe(1);
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [
        {
          day: '2026-04-22',
          count: 2,
          face_value_minor: 1n,
          wholesale_minor: 1n,
          user_cashback_minor: 1n,
          loop_margin_minor: 1n,
        },
      ],
    } as unknown as Array<Record<string, unknown>>;
    const res = await adminOrdersActivityHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!['day']).toBe('2026-04-22');
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminOrdersActivityHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
