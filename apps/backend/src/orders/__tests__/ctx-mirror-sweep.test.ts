// Mirror sweep reconciles every open row against CTX (ADR 052)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, __resetDbForTests } from '../../db/client.js';
import type { OrderDoc, OrderState } from '../../db/types.js';
import type * as CtxOrderModule from '../ctx-order.js';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('../../runtime-health.js', () => ({
  markWorkerStarted: vi.fn(),
  markWorkerStopped: vi.fn(),
  markWorkerTickFailure: vi.fn(),
  markWorkerTickSkippedLocked: vi.fn(),
  markWorkerTickSuccess: vi.fn(),
}));

const { ctxOrderMock, redemptionMock, discordMock } = vi.hoisted(() => ({
  ctxOrderMock: {
    fetchCtxCardAsOperator: vi.fn(async (id: string) => ({ id, displayStatus: 'unpaid' })),
    operatorProfitShareBp: vi.fn(async () => null),
    deriveOrderEconomics: vi.fn(() => ({
      chargeMinor: null,
      chargeCurrency: null,
      userCashbackMinor: null,
      expectedCommissionMinor: null,
    })),
  },
  redemptionMock: { fetchRedemption: vi.fn(async () => null) },
  discordMock: { notifyOrderFulfilled: vi.fn() },
}));
vi.mock('../ctx-order.js', async (importOriginal) => ({
  ...(await importOriginal<typeof CtxOrderModule>()),
  ...ctxOrderMock,
}));
vi.mock('../procurement-redemption.js', () => redemptionMock);
vi.mock('../../discord.js', () => discordMock);

import { resyncOrderFromCtx, runMirrorSweepTick } from '../ctx-mirror-sweep.js';

async function seedOrder(state: OrderState, overrides: Partial<OrderDoc> = {}): Promise<OrderDoc> {
  const doc: OrderDoc = {
    id: randomUUID(),
    userId: 'u-1',
    merchantId: 'm-1',
    faceValueMinor: 1000,
    currency: 'USD',
    chargeMinor: 1000,
    chargeCurrency: 'USD',
    userCashbackMinor: 0,
    expectedCommissionMinor: 50,
    ctxOrderId: randomUUID(),
    ctxPaymentId: 'pay-1',
    paymentCryptoCurrency: 'XLM',
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    redemptionBackfillAttempts: 0,
    redemptionBackfillLastAttemptAt: null,
    mirrorSyncedAt: null,
    state,
    failureReason: null,
    idempotencyKey: null,
    createdAt: new Date(),
    fulfilledAt: null,
    failedAt: null,
    ...overrides,
  };
  await db.collection('orders').insertOne(doc);
  return doc;
}

async function load(id: string): Promise<OrderDoc | null> {
  return db.collection('orders').findOne({ id });
}

beforeEach(() => {
  __resetDbForTests();
  vi.clearAllMocks();
  ctxOrderMock.fetchCtxCardAsOperator.mockImplementation(async (id: string) => ({
    id,
    displayStatus: 'unpaid',
  }));
});

describe('runMirrorSweepTick', () => {
  it('leaves an unpaid row unpaid however long CTX leaves the card unpaid', async () => {
    const order = await seedOrder('unpaid', {
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const r = await runMirrorSweepTick(Date.parse('2026-03-01T00:00:00Z'));
    expect(r.applied).toBe(1);
    const stored = await load(order.id);
    expect(stored?.state).toBe('unpaid');
    expect(stored?.failureReason).toBeNull();
  });

  it('moves an expired row to fulfilled when CTX reports the card fulfilled', async () => {
    const order = await seedOrder('expired', {
      failedAt: new Date(),
      failureReason: 'payment window expired',
    });
    ctxOrderMock.fetchCtxCardAsOperator.mockResolvedValue({
      id: order.ctxOrderId as string,
      displayStatus: 'fulfilled',
    });
    await runMirrorSweepTick();
    const stored = await load(order.id);
    expect(stored?.state).toBe('fulfilled');
    expect(stored?.failureReason).toBeNull();
  });

  it('stamps mirrorSyncedAt so the least-recently-synced rows come first next tick', async () => {
    const order = await seedOrder('unpaid');
    const now = Date.parse('2026-02-01T00:00:00Z');
    await runMirrorSweepTick(now);
    expect((await load(order.id))?.mirrorSyncedAt?.getTime()).toBe(now);
  });

  it('skips rows that CTX already reports in their current state', async () => {
    await seedOrder('paid');
    ctxOrderMock.fetchCtxCardAsOperator.mockImplementation(async (id: string) => ({
      id,
      displayStatus: 'paid',
    }));
    const r = await runMirrorSweepTick();
    expect(r.applied).toBe(1);
    expect(discordMock.notifyOrderFulfilled).not.toHaveBeenCalled();
  });
});

describe('resyncOrderFromCtx', () => {
  it('resyncs a rejected row to paid when CTX reports the card paid', async () => {
    const order = await seedOrder('rejected');
    ctxOrderMock.fetchCtxCardAsOperator.mockResolvedValue({
      id: order.ctxOrderId as string,
      displayStatus: 'paid',
    });
    expect(await resyncOrderFromCtx(order.id)).toEqual({ kind: 'resynced', state: 'paid' });
  });

  it('reports a missing order', async () => {
    expect(await resyncOrderFromCtx(randomUUID())).toEqual({ kind: 'order_not_found' });
  });
});
