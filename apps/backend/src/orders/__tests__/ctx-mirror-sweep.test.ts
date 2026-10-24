// Mirror sweep reconciles every open row against CTX (ADR 052)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CtxUnavailableError } from '../../ctx/api-fetch.js';
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
    listCtxCardsAsOperator: vi.fn(async () => [] as { id: string; displayStatus: string }[]),
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
  ctxOrderMock.listCtxCardsAsOperator.mockResolvedValue([]);
});

describe('runMirrorSweepTick', () => {
  it('reads the operator pending list once for the whole batch', async () => {
    const a = await seedOrder('unpaid');
    const b = await seedOrder('unpaid');
    ctxOrderMock.listCtxCardsAsOperator.mockResolvedValue([
      { id: a.ctxOrderId as string, displayStatus: 'paid' },
      { id: b.ctxOrderId as string, displayStatus: 'unpaid' },
    ]);
    const r = await runMirrorSweepTick();
    expect(r.applied).toBe(2);
    expect(ctxOrderMock.listCtxCardsAsOperator).toHaveBeenCalledExactlyOnceWith(['unpaid', 'paid']);
    expect(ctxOrderMock.fetchCtxCardAsOperator).not.toHaveBeenCalled();
    expect((await load(a.id))?.state).toBe('paid');
    expect((await load(b.id))?.state).toBe('unpaid');
  });

  it('reads a card individually only once it has left the pending list', async () => {
    const order = await seedOrder('unpaid');
    ctxOrderMock.fetchCtxCardAsOperator.mockResolvedValue({
      id: order.ctxOrderId as string,
      displayStatus: 'expired',
    });
    await runMirrorSweepTick();
    expect(ctxOrderMock.fetchCtxCardAsOperator).toHaveBeenCalledExactlyOnceWith(order.ctxOrderId);
    const stored = await load(order.id);
    expect(stored?.state).toBe('expired');
    expect(stored?.failureReason).toBe('payment window expired');
  });

  it('never picks expired rows', async () => {
    await seedOrder('expired');
    const r = await runMirrorSweepTick();
    expect(r.picked).toBe(0);
    expect(ctxOrderMock.listCtxCardsAsOperator).not.toHaveBeenCalled();
    expect(ctxOrderMock.fetchCtxCardAsOperator).not.toHaveBeenCalled();
  });

  it('aborts the tick when the pending list is unavailable', async () => {
    const order = await seedOrder('unpaid');
    ctxOrderMock.listCtxCardsAsOperator.mockRejectedValue(new CtxUnavailableError('down'));
    const r = await runMirrorSweepTick();
    expect(r.abortedCtxUnavailable).toBe(true);
    expect(r.applied).toBe(0);
    expect(ctxOrderMock.fetchCtxCardAsOperator).not.toHaveBeenCalled();
    expect((await load(order.id))?.mirrorSyncedAt).toBeNull();
  });

  it('leaves an unpaid row unpaid however long CTX leaves the card unpaid', async () => {
    const order = await seedOrder('unpaid', {
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    ctxOrderMock.listCtxCardsAsOperator.mockResolvedValue([
      { id: order.ctxOrderId as string, displayStatus: 'unpaid' },
    ]);
    const r = await runMirrorSweepTick(Date.parse('2026-03-01T00:00:00Z'));
    expect(r.applied).toBe(1);
    const stored = await load(order.id);
    expect(stored?.state).toBe('unpaid');
    expect(stored?.failureReason).toBeNull();
  });

  it('stamps mirrorSyncedAt so the least-recently-synced rows come first next tick', async () => {
    const order = await seedOrder('unpaid');
    const now = Date.parse('2026-02-01T00:00:00Z');
    await runMirrorSweepTick(now);
    expect((await load(order.id))?.mirrorSyncedAt?.getTime()).toBe(now);
  });

  it('skips rows that CTX already reports in their current state', async () => {
    const order = await seedOrder('paid');
    ctxOrderMock.listCtxCardsAsOperator.mockResolvedValue([
      { id: order.ctxOrderId as string, displayStatus: 'paid' },
    ]);
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
