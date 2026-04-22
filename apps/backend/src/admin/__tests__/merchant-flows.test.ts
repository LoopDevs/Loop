import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: [] as unknown[],
  },
}));

vi.mock('../../db/client.js', () => {
  const leaf = {
    where: vi.fn(() => leaf),
    groupBy: vi.fn(() => leaf),
    orderBy: vi.fn(async () => dbState.rows),
  };
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => leaf),
      })),
    },
  };
});

vi.mock('../../db/schema.js', () => ({
  orders: {
    merchantId: 'merchantId',
    chargeCurrency: 'chargeCurrency',
    state: 'state',
    faceValueMinor: 'faceValueMinor',
    wholesaleMinor: 'wholesaleMinor',
    userCashbackMinor: 'userCashbackMinor',
    loopMarginMinor: 'loopMarginMinor',
  },
}));

import { adminMerchantFlowsHandler } from '../merchant-flows.js';

function makeCtx(): Context {
  return {
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  dbState.rows = [];
});

describe('adminMerchantFlowsHandler', () => {
  it('returns an empty flows array when no fulfilled orders exist', async () => {
    const res = await adminMerchantFlowsHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flows: unknown[] };
    expect(body.flows).toEqual([]);
  });

  it('shapes each bucket as { merchantId, currency, count, *Minor }', async () => {
    dbState.rows = [
      {
        merchantId: 'tesco',
        currency: 'GBP',
        count: '12',
        faceValue: '120000',
        wholesale: '96000',
        userCashback: '6000',
        loopMargin: '18000',
      },
      {
        merchantId: 'amazon-us',
        currency: 'USD',
        count: '3',
        faceValue: '30000',
        wholesale: '24000',
        userCashback: '1500',
        loopMargin: '4500',
      },
    ];
    const res = await adminMerchantFlowsHandler(makeCtx());
    const body = (await res.json()) as {
      flows: Array<{
        merchantId: string;
        currency: string;
        count: string;
        faceValueMinor: string;
        wholesaleMinor: string;
        userCashbackMinor: string;
        loopMarginMinor: string;
      }>;
    };
    expect(body.flows).toEqual([
      {
        merchantId: 'tesco',
        currency: 'GBP',
        count: '12',
        faceValueMinor: '120000',
        wholesaleMinor: '96000',
        userCashbackMinor: '6000',
        loopMarginMinor: '18000',
      },
      {
        merchantId: 'amazon-us',
        currency: 'USD',
        count: '3',
        faceValueMinor: '30000',
        wholesaleMinor: '24000',
        userCashbackMinor: '1500',
        loopMarginMinor: '4500',
      },
    ]);
  });

  it('splits the same merchant into separate rows per charge currency', async () => {
    dbState.rows = [
      {
        merchantId: 'amazon-uk',
        currency: 'GBP',
        count: '5',
        faceValue: '50000',
        wholesale: '40000',
        userCashback: '2500',
        loopMargin: '7500',
      },
      {
        merchantId: 'amazon-uk',
        currency: 'EUR',
        count: '2',
        faceValue: '20000',
        wholesale: '16000',
        userCashback: '1000',
        loopMargin: '3000',
      },
    ];
    const res = await adminMerchantFlowsHandler(makeCtx());
    const body = (await res.json()) as { flows: Array<{ merchantId: string; currency: string }> };
    expect(body.flows).toHaveLength(2);
    expect(body.flows.map((f) => f.currency).sort()).toEqual(['EUR', 'GBP']);
  });
});
