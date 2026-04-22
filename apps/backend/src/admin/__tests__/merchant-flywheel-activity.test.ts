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
    merchantId: 'orders.merchant_id',
    state: 'orders.state',
    paymentMethod: 'orders.payment_method',
    chargeMinor: 'orders.charge_minor',
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

import { adminMerchantFlywheelActivityHandler } from '../merchant-flywheel-activity.js';

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

describe('adminMerchantFlywheelActivityHandler', () => {
  it('400 when merchantId is missing', async () => {
    const res = await adminMerchantFlywheelActivityHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when merchantId has disallowed characters', async () => {
    const res = await adminMerchantFlywheelActivityHandler(makeCtx({ merchantId: 'bad slug' }));
    expect(res.status).toBe(400);
  });

  it('400 when merchantId exceeds 128 chars', async () => {
    const res = await adminMerchantFlywheelActivityHandler(
      makeCtx({ merchantId: 'x'.repeat(200) }),
    );
    expect(res.status).toBe(400);
  });

  it('defaults to 30 days and clamps ?days to [1, 180]', async () => {
    state.rows = [];
    const dflt = await adminMerchantFlywheelActivityHandler(makeCtx({ merchantId: 'm' }));
    expect(((await dflt.json()) as { days: number }).days).toBe(30);

    const tooBig = await adminMerchantFlywheelActivityHandler(
      makeCtx({ merchantId: 'm' }, { days: '500' }),
    );
    expect(((await tooBig.json()) as { days: number }).days).toBe(180);

    const tooSmall = await adminMerchantFlywheelActivityHandler(
      makeCtx({ merchantId: 'm' }, { days: '0' }),
    );
    expect(((await tooSmall.json()) as { days: number }).days).toBe(1);

    const coerce = await adminMerchantFlywheelActivityHandler(
      makeCtx({ merchantId: 'm' }, { days: 'banana' }),
    );
    expect(((await coerce.json()) as { days: number }).days).toBe(30);
  });

  it('maps rows into (day, recycledCount, totalCount, charge minors) entries', async () => {
    state.rows = [
      {
        day: '2026-04-20',
        recycled_count: 3n,
        total_count: 10n,
        recycled_charge_minor: 6000n,
        total_charge_minor: 25000n,
      },
      {
        day: '2026-04-21',
        recycled_count: 0,
        total_count: 0,
        recycled_charge_minor: 0,
        total_charge_minor: 0,
      },
    ];
    const res = await adminMerchantFlywheelActivityHandler(
      makeCtx({ merchantId: 'amazon_us' }, { days: '2' }),
    );
    const body = (await res.json()) as {
      merchantId: string;
      rows: Array<{
        day: string;
        recycledCount: number;
        totalCount: number;
        recycledChargeMinor: string;
        totalChargeMinor: string;
      }>;
    };
    expect(body.merchantId).toBe('amazon_us');
    expect(body.rows).toEqual([
      {
        day: '2026-04-20',
        recycledCount: 3,
        totalCount: 10,
        recycledChargeMinor: '6000',
        totalChargeMinor: '25000',
      },
      {
        day: '2026-04-21',
        recycledCount: 0,
        totalCount: 0,
        recycledChargeMinor: '0',
        totalChargeMinor: '0',
      },
    ]);
  });

  it('formats Date-typed day values to YYYY-MM-DD', async () => {
    state.rows = [
      {
        day: new Date(Date.UTC(2026, 3, 22)),
        recycled_count: 1n,
        total_count: 1n,
        recycled_charge_minor: 100n,
        total_charge_minor: 100n,
      },
    ];
    const res = await adminMerchantFlywheelActivityHandler(
      makeCtx({ merchantId: 'm' }, { days: '1' }),
    );
    const body = (await res.json()) as { rows: Array<{ day: string }> };
    expect(body.rows[0]?.day).toBe('2026-04-22');
  });

  it('preserves bigint precision past 2^53 on charge sums', async () => {
    state.rows = [
      {
        day: '2026-04-22',
        recycled_count: 1n,
        total_count: 1n,
        recycled_charge_minor: 9007199254740992n + 37n,
        total_charge_minor: 9007199254740992n + 37n,
      },
    ];
    const res = await adminMerchantFlywheelActivityHandler(
      makeCtx({ merchantId: 'm' }, { days: '1' }),
    );
    const body = (await res.json()) as {
      rows: Array<{ recycledChargeMinor: string; totalChargeMinor: string }>;
    };
    expect(body.rows[0]?.recycledChargeMinor).toBe('9007199254741029');
    expect(body.rows[0]?.totalChargeMinor).toBe('9007199254741029');
  });

  it('coerces null aggregates to "0" / 0 for zero-volume LEFT-JOIN days', async () => {
    state.rows = [
      {
        day: '2026-04-22',
        recycled_count: null,
        total_count: null,
        recycled_charge_minor: null,
        total_charge_minor: null,
      },
    ];
    const res = await adminMerchantFlywheelActivityHandler(
      makeCtx({ merchantId: 'm' }, { days: '1' }),
    );
    const body = (await res.json()) as {
      rows: Array<{
        recycledCount: number;
        totalCount: number;
        recycledChargeMinor: string;
        totalChargeMinor: string;
      }>;
    };
    expect(body.rows[0]).toEqual({
      day: '2026-04-22',
      recycledCount: 0,
      totalCount: 0,
      recycledChargeMinor: '0',
      totalChargeMinor: '0',
    });
  });

  it('handles the { rows } envelope shape', async () => {
    state.rows = {
      rows: [
        {
          day: '2026-04-22',
          recycled_count: 1n,
          total_count: 1n,
          recycled_charge_minor: 100n,
          total_charge_minor: 100n,
        },
      ],
    };
    const res = await adminMerchantFlywheelActivityHandler(
      makeCtx({ merchantId: 'm' }, { days: '1' }),
    );
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
  });

  it('500 when the db throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminMerchantFlywheelActivityHandler(makeCtx({ merchantId: 'm' }));
    expect(res.status).toBe(500);
  });
});
