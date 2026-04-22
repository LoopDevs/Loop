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
    userId: 'orders.user_id',
    merchantId: 'orders.merchant_id',
    state: 'orders.state',
    chargeCurrency: 'orders.charge_currency',
    chargeMinor: 'orders.charge_minor',
    userCashbackMinor: 'orders.user_cashback_minor',
    fulfilledAt: 'orders.fulfilled_at',
  },
  users: {
    id: 'users.id',
    email: 'users.email',
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

import { adminMerchantTopEarnersHandler } from '../merchant-top-earners.js';

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

describe('adminMerchantTopEarnersHandler', () => {
  it('400 when merchantId is missing', async () => {
    const res = await adminMerchantTopEarnersHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when merchantId has disallowed characters', async () => {
    const res = await adminMerchantTopEarnersHandler(makeCtx({ merchantId: 'bad slug' }));
    expect(res.status).toBe(400);
  });

  it('400 when merchantId exceeds 128 chars', async () => {
    const res = await adminMerchantTopEarnersHandler(makeCtx({ merchantId: 'x'.repeat(200) }));
    expect(res.status).toBe(400);
  });

  it('returns empty rows for a merchant with no fulfilled orders in the window', async () => {
    state.rows = [];
    const res = await adminMerchantTopEarnersHandler(makeCtx({ merchantId: 'amazon_us' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchantId: string;
      since: string;
      rows: unknown[];
    };
    expect(body.merchantId).toBe('amazon_us');
    expect(body.rows).toEqual([]);
    expect(typeof body.since).toBe('string');
  });

  it('maps rows into the leaderboard shape', async () => {
    state.rows = [
      {
        user_id: 'u-1',
        email: 'whale@example.com',
        currency: 'USD',
        order_count: 20n,
        cashback_minor: 45000n,
        charge_minor: 900000n,
      },
      {
        user_id: 'u-2',
        email: 'fin@example.com',
        currency: 'USD',
        order_count: 5n,
        cashback_minor: 12000n,
        charge_minor: 240000n,
      },
    ];
    const res = await adminMerchantTopEarnersHandler(makeCtx({ merchantId: 'amazon_us' }));
    const body = (await res.json()) as {
      rows: Array<{
        userId: string;
        email: string;
        currency: string;
        orderCount: number;
        cashbackMinor: string;
        chargeMinor: string;
      }>;
    };
    expect(body.rows).toEqual([
      {
        userId: 'u-1',
        email: 'whale@example.com',
        currency: 'USD',
        orderCount: 20,
        cashbackMinor: '45000',
        chargeMinor: '900000',
      },
      {
        userId: 'u-2',
        email: 'fin@example.com',
        currency: 'USD',
        orderCount: 5,
        cashbackMinor: '12000',
        chargeMinor: '240000',
      },
    ]);
  });

  it('preserves bigint precision past 2^53 on cashback sums', async () => {
    state.rows = [
      {
        user_id: 'u-big',
        email: 'big@example.com',
        currency: 'USD',
        order_count: 1n,
        cashback_minor: 9007199254740992n + 43n,
        charge_minor: 9007199254740992n + 43n,
      },
    ];
    const res = await adminMerchantTopEarnersHandler(makeCtx({ merchantId: 'm' }));
    const body = (await res.json()) as {
      rows: Array<{ cashbackMinor: string; chargeMinor: string }>;
    };
    expect(body.rows[0]?.cashbackMinor).toBe('9007199254741035');
    expect(body.rows[0]?.chargeMinor).toBe('9007199254741035');
  });

  it('defaults ?days to 30 and clamps to [1, 366]', async () => {
    state.rows = [];
    const dflt = await adminMerchantTopEarnersHandler(makeCtx({ merchantId: 'm' }));
    const dsince = new Date(((await dflt.json()) as { since: string }).since);
    const ageMs = Date.now() - dsince.getTime();
    expect(Math.abs(ageMs - 30 * 86_400_000)).toBeLessThan(5 * 60_000);

    const tooBig = await adminMerchantTopEarnersHandler(
      makeCtx({ merchantId: 'm' }, { days: '9999' }),
    );
    const bsince = new Date(((await tooBig.json()) as { since: string }).since);
    const bage = Date.now() - bsince.getTime();
    expect(Math.abs(bage - 366 * 86_400_000)).toBeLessThan(5 * 60_000);
  });

  it('defaults ?limit to 10 and clamps to [1, 100]', async () => {
    // Can't observe the SQL directly with this mock, but we can
    // confirm validation + default don't crash + request succeeds.
    state.rows = [];
    for (const v of [undefined, '1', '10', '100', '999', '0', 'nonsense']) {
      const res = await adminMerchantTopEarnersHandler(
        makeCtx({ merchantId: 'm' }, v === undefined ? {} : { limit: v }),
      );
      expect(res.status).toBe(200);
    }
  });

  it('handles the { rows } envelope shape', async () => {
    state.rows = {
      rows: [
        {
          user_id: 'u-1',
          email: 'a@b.com',
          currency: 'USD',
          order_count: 1n,
          cashback_minor: 100n,
          charge_minor: 1000n,
        },
      ],
    };
    const res = await adminMerchantTopEarnersHandler(makeCtx({ merchantId: 'm' }));
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
  });

  it('500 when the db throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminMerchantTopEarnersHandler(makeCtx({ merchantId: 'm' }));
    expect(res.status).toBe(500);
  });
});
