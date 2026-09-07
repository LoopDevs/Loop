import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { LoopAuthContext } from '../../auth/handler.js';
import { randomUUID } from 'node:crypto';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { db, __resetDbForTests } from '../../db/client.js';
import type { OrderState, UserDoc } from '../../db/types.js';
import { getUserOrdersSummaryHandler } from '../orders-summary.js';

/**
 * `GET /api/users/me/orders/summary` — the compact 5-number header —
 * against the real in-memory document store: bucket semantics
 * (pending = unpaid|paid, failed = rejected|refunded|expired),
 * fulfilled-only spend, and the home-currency lock.
 */
const LOOP_AUTH: LoopAuthContext = {
  kind: 'loop',
  userId: 'user-uuid',
  email: 'a@b.com',
  bearerToken: 'loop-jwt',
} as LoopAuthContext;

function makeCtx(auth: LoopAuthContext | undefined): Context {
  const store = new Map<string, unknown>();
  if (auth !== undefined) store.set('auth', auth);
  return {
    req: {
      query: (_k: string) => undefined,
      param: (_k: string) => undefined,
    },
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

async function seedUser(): Promise<UserDoc> {
  const now = new Date();
  const doc: UserDoc = {
    id: 'user-uuid',
    ctxUserId: null,
    email: 'a@b.com',
    tokenVersion: 0,
    homeCurrency: 'GBP',
    createdAt: now,
    updatedAt: now,
  };
  await db.collection('users').insertOne(doc);
  return doc;
}

async function seedOrder(args: {
  state: OrderState;
  chargeMinor?: number;
  chargeCurrency?: string;
  userId?: string;
}): Promise<void> {
  const now = new Date();
  await db.collection('orders').insertOne({
    id: randomUUID(),
    userId: args.userId ?? 'user-uuid',
    merchantId: 'm-1',
    faceValueMinor: args.chargeMinor ?? 1000,
    currency: args.chargeCurrency ?? 'GBP',
    chargeMinor: args.chargeMinor ?? 1000,
    chargeCurrency: args.chargeCurrency ?? 'GBP',
    userCashbackMinor: 0,
    expectedCommissionMinor: null,
    ctxOrderId: null,
    ctxPaymentId: null,
    paymentCryptoCurrency: 'XLM',
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    redemptionBackfillAttempts: 0,
    redemptionBackfillLastAttemptAt: null,
    state: args.state,
    failureReason: null,
    idempotencyKey: null,
    createdAt: now,
    fulfilledAt: null,
    failedAt: null,
  });
}

beforeEach(() => {
  __resetDbForTests();
});

describe('getUserOrdersSummaryHandler', () => {
  it('401 when no auth context is attached', async () => {
    const res = await getUserOrdersSummaryHandler(makeCtx(undefined));
    expect(res.status).toBe(401);
  });

  it('returns zeros when the user has no orders', async () => {
    await seedUser();
    const res = await getUserOrdersSummaryHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      currency: 'GBP',
      totalOrders: 0,
      fulfilledCount: 0,
      pendingCount: 0,
      failedCount: 0,
      totalSpentMinor: '0',
    });
  });

  it('buckets the states and sums fulfilled spend only', async () => {
    await seedUser();
    // Fulfilled: counted + spend.
    await seedOrder({ state: 'fulfilled', chargeMinor: 20_000 });
    await seedOrder({ state: 'fulfilled', chargeMinor: 15_000 });
    // In-flight bucket: unpaid + paid.
    await seedOrder({ state: 'unpaid', chargeMinor: 9_999 });
    await seedOrder({ state: 'paid', chargeMinor: 9_999 });
    // Didn't-succeed bucket: rejected + refunded + expired.
    await seedOrder({ state: 'rejected' });
    await seedOrder({ state: 'refunded' });
    await seedOrder({ state: 'expired' });

    const res = await getUserOrdersSummaryHandler(makeCtx(LOOP_AUTH));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      currency: 'GBP',
      totalOrders: 7,
      fulfilledCount: 2,
      pendingCount: 2,
      failedCount: 3,
      // Pending / failed orders never count toward lifetime spend.
      totalSpentMinor: '35000',
    });
  });

  it('is home-currency locked — other-currency and other-user orders are excluded', async () => {
    await seedUser();
    await seedOrder({ state: 'fulfilled', chargeMinor: 5_000 });
    // Cross-currency order (support-mediated region flip) — excluded.
    await seedOrder({ state: 'fulfilled', chargeMinor: 7_000, chargeCurrency: 'USD' });
    // Another user's order — excluded.
    await seedOrder({ state: 'fulfilled', chargeMinor: 9_000, userId: 'other-user' });

    const res = await getUserOrdersSummaryHandler(makeCtx(LOOP_AUTH));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['totalOrders']).toBe(1);
    expect(body['totalSpentMinor']).toBe('5000');
  });

  it('500 when the query throws', async () => {
    await seedUser();
    const orders = db.collection('orders');
    vi.spyOn(orders, 'findMany').mockRejectedValueOnce(new Error('db exploded'));
    const res = await getUserOrdersSummaryHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(500);
  });
});
