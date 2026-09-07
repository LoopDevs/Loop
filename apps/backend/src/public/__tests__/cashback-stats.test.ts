import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { db, __resetDbForTests } from '../../db/client.js';
import type { OrderState } from '../../db/types.js';
import {
  publicCashbackStatsHandler,
  __resetPublicCashbackStatsCache,
  __expirePublicCashbackStatsCache,
} from '../cashback-stats.js';

/**
 * ADR 020 / ADR 052 public cashback stats, against the real in-memory
 * document store: the fulfilled-orders aggregate, the never-500
 * last-known-good fallback, and the CF-29 / PERF-001 TTL memo.
 */
function makeCtx(): Context {
  const headers = new Map<string, string>();
  return {
    req: {
      query: (_k: string) => undefined,
      param: (_k: string) => undefined,
    },
    header: (k: string, v: string) => headers.set(k, v),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: Object.assign(
          { 'content-type': 'application/json' },
          Object.fromEntries(headers.entries()),
        ),
      }),
  } as unknown as Context;
}

async function seedOrder(args: {
  userId: string;
  currency: string;
  userCashbackMinor: number;
  state?: OrderState;
}): Promise<void> {
  const now = new Date();
  await db.collection('orders').insertOne({
    id: randomUUID(),
    userId: args.userId,
    merchantId: 'm-1',
    faceValueMinor: 1000,
    currency: args.currency,
    chargeMinor: 1000,
    chargeCurrency: args.currency,
    userCashbackMinor: args.userCashbackMinor,
    expectedCommissionMinor: null,
    ctxOrderId: null,
    ctxPaymentId: null,
    paymentCryptoCurrency: 'XLM',
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    redemptionBackfillAttempts: 0,
    redemptionBackfillLastAttemptAt: null,
    state: args.state ?? 'fulfilled',
    failureReason: null,
    idempotencyKey: null,
    createdAt: now,
    fulfilledAt: now,
    failedAt: null,
  });
}

beforeEach(() => {
  __resetDbForTests();
  __resetPublicCashbackStatsCache();
});

describe('publicCashbackStatsHandler', () => {
  it('returns zeros on a fresh store with no orders', async () => {
    const res = await publicCashbackStatsHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      totalUsersWithCashback: 0,
      fulfilledOrders: 0,
      totalCashbackByCurrency: [],
    });
    expect(typeof body['asOf']).toBe('string');
  });

  it('aggregates per currency, counting only fulfilled orders and cashback-earning users', async () => {
    // Two GBP cashback orders for the same user (dedup to one user).
    await seedOrder({ userId: 'u-1', currency: 'GBP', userCashbackMinor: 5_000_000 });
    await seedOrder({ userId: 'u-1', currency: 'GBP', userCashbackMinor: 4_000_000 });
    await seedOrder({ userId: 'u-2', currency: 'USD', userCashbackMinor: 4_500_000 });
    await seedOrder({ userId: 'u-3', currency: 'EUR', userCashbackMinor: 1_200_000 });
    // Fulfilled but zero cashback: counts as an order, not a cashback user.
    await seedOrder({ userId: 'u-4', currency: 'USD', userCashbackMinor: 0 });
    // Not fulfilled: excluded from everything.
    await seedOrder({ userId: 'u-5', currency: 'USD', userCashbackMinor: 100, state: 'paid' });

    const res = await publicCashbackStatsHandler(makeCtx());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['totalUsersWithCashback']).toBe(3);
    expect(body['fulfilledOrders']).toBe(5);
    expect(body['totalCashbackByCurrency']).toEqual([
      { currency: 'EUR', amountMinor: '1200000' },
      { currency: 'GBP', amountMinor: '9000000' },
      { currency: 'USD', amountMinor: '4500000' },
    ]);
  });

  it('never 500s — DB throws serve zeros on bootstrap with max-age=60', async () => {
    const orders = db.collection('orders');
    vi.spyOn(orders, 'findMany').mockRejectedValueOnce(new Error('db exploded'));
    const res = await publicCashbackStatsHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['totalUsersWithCashback']).toBe(0);
    expect(body['totalCashbackByCurrency']).toEqual([]);
  });

  it('serves last-known-good on DB failure after a successful run', async () => {
    await seedOrder({ userId: 'u-1', currency: 'GBP', userCashbackMinor: 999 });
    const first = await publicCashbackStatsHandler(makeCtx());
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody['totalUsersWithCashback']).toBe(1);
    expect(firstBody['fulfilledOrders']).toBe(1);

    // Expire the TTL memo so the second request recomputes (and hits the
    // injected DB failure) rather than serving the still-fresh snapshot.
    __expirePublicCashbackStatsCache();
    const orders = db.collection('orders');
    vi.spyOn(orders, 'findMany').mockRejectedValueOnce(new Error('db exploded'));
    const second = await publicCashbackStatsHandler(makeCtx());
    expect(second.status).toBe(200);
    expect(second.headers.get('cache-control')).toBe('public, max-age=60');
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody['totalUsersWithCashback']).toBe(1);
    expect(secondBody['fulfilledOrders']).toBe(1);
  });

  it('emits cache-control: public, max-age=300 on the happy path', async () => {
    const res = await publicCashbackStatsHandler(makeCtx());
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('CF-29/PERF-001: serves the TTL memo without re-querying the store inside the window', async () => {
    await seedOrder({ userId: 'u-1', currency: 'USD', userCashbackMinor: 100 });
    const orders = db.collection('orders');
    const findManySpy = vi.spyOn(orders, 'findMany');
    const first = await publicCashbackStatsHandler(makeCtx());
    expect(first.status).toBe(200);
    const callsAfterFirst = findManySpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0); // first call did compute

    // Second request inside the TTL window — must serve the memo and
    // issue zero new store queries (the crawler-storm guard).
    const second = await publicCashbackStatsHandler(makeCtx());
    expect(second.status).toBe(200);
    expect(second.headers.get('cache-control')).toBe('public, max-age=300');
    expect(findManySpy.mock.calls.length).toBe(callsAfterFirst); // no extra queries
    const body = (await second.json()) as Record<string, unknown>;
    expect(body['totalUsersWithCashback']).toBe(1);
  });

  it('CF-29/PERF-001: recomputes once the memo is expired', async () => {
    await seedOrder({ userId: 'u-1', currency: 'USD', userCashbackMinor: 100 });
    await publicCashbackStatsHandler(makeCtx());
    __expirePublicCashbackStatsCache();
    // New data lands after the first compute; the recompute must see it.
    await seedOrder({ userId: 'u-2', currency: 'USD', userCashbackMinor: 100 });
    const res = await publicCashbackStatsHandler(makeCtx());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['totalUsersWithCashback']).toBe(2);
  });
});
