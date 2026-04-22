import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

/**
 * The handler makes three distinct db.select().from().where(...) chains:
 *   1. credit_transactions grouped by currency (array of rows)
 *   2. credit_transactions COUNT(DISTINCT user_id) (single-row array)
 *   3. orders COUNT + COUNT(DISTINCT merchant_id) (single-row array)
 *
 * The db mock exposes `.where()` as thenable; queued results are
 * consumed in call order. Tests push three arrays to satisfy the
 * three queries and mapping logic reads the first row of each.
 */
const { results, throwMode } = vi.hoisted(() => ({
  results: [] as unknown[][],
  throwMode: { on: false },
}));

vi.mock('../../db/client.js', () => {
  const leaf = {
    where: vi.fn((..._args: unknown[]) => {
      const self = {
        groupBy: vi.fn(async () => {
          if (throwMode.on) throw new Error('db exploded');
          return results.shift() ?? [];
        }),
        then(resolve: (rows: unknown[]) => void, reject?: (e: unknown) => void): unknown {
          try {
            if (throwMode.on) throw new Error('db exploded');
            return Promise.resolve(results.shift() ?? []).then(resolve, reject);
          } catch (err) {
            if (reject !== undefined) reject(err);
            return Promise.reject(err);
          }
        },
      };
      return self;
    }),
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
  creditTransactions: {
    userId: 'userId',
    type: 'type',
    amountMinor: 'amountMinor',
    currency: 'currency',
  },
  orders: {
    merchantId: 'merchantId',
    state: 'state',
  },
}));

import { publicStatsHandler } from '../stats.js';

function makeCtx(): { ctx: Context; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    ctx: {
      header: (k: string, v: string) => {
        headers[k] = v;
      },
      json: (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as Context,
  };
}

beforeEach(() => {
  results.length = 0;
  throwMode.on = false;
});

describe('publicStatsHandler', () => {
  it('returns zero-shape stats when the ledger is empty', async () => {
    // 3 queries, each with empty / zero-row result:
    //   1. cashback-per-currency: no rows
    //   2. distinct user count: [{ count: '0' }]
    //   3. orders aggregate: [{ merchantsCount: '0', fulfilledCount: '0' }]
    results.push([], [{ count: '0' }], [{ merchantsCount: '0', fulfilledCount: '0' }]);

    const { ctx, headers } = makeCtx();
    const res = await publicStatsHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      paidCashbackMinor: Record<string, string>;
      paidUserCount: string;
      merchantsWithOrders: string;
      fulfilledOrderCount: string;
    };
    expect(body).toEqual({
      paidCashbackMinor: {},
      paidUserCount: '0',
      merchantsWithOrders: '0',
      fulfilledOrderCount: '0',
    });
    expect(headers['Cache-Control']).toMatch(/max-age=3600/);
  });

  it('aggregates cashback totals per currency with bigint-string precision', async () => {
    results.push(
      [
        { currency: 'GBP', total: '123456789' },
        { currency: 'USD', total: '9999999999999999' },
      ],
      [{ count: '42' }],
      [{ merchantsCount: '12', fulfilledCount: '120' }],
    );

    const { ctx } = makeCtx();
    const body = (await (await publicStatsHandler(ctx)).json()) as {
      paidCashbackMinor: Record<string, string>;
      paidUserCount: string;
      merchantsWithOrders: string;
      fulfilledOrderCount: string;
    };
    expect(body.paidCashbackMinor).toEqual({
      GBP: '123456789',
      USD: '9999999999999999',
    });
    expect(body.paidUserCount).toBe('42');
    expect(body.merchantsWithOrders).toBe('12');
    expect(body.fulfilledOrderCount).toBe('120');
  });

  it('falls back to zero-shape + short cache on db failure (never 500s the marketing surface)', async () => {
    throwMode.on = true;
    const { ctx, headers } = makeCtx();
    const res = await publicStatsHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      paidCashbackMinor: Record<string, string>;
      paidUserCount: string;
    };
    expect(body.paidCashbackMinor).toEqual({});
    expect(body.paidUserCount).toBe('0');
    // Shorter cache on error so a recovered DB flows through quickly.
    expect(headers['Cache-Control']).toMatch(/max-age=60\b/);
  });
});
