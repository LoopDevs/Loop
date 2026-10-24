// Mirror application follows CTX displayStatus in every direction (ADR 052)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, __resetDbForTests } from '../../db/client.js';
import type { OrderDoc, OrderState } from '../../db/types.js';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));

const { redemptionMock, discordMock } = vi.hoisted(() => ({
  redemptionMock: {
    fetchRedemption: vi.fn(async () => ({ code: 'CODE-1', pin: null, url: null })),
  },
  discordMock: { notifyOrderFulfilled: vi.fn() },
}));
vi.mock('../procurement-redemption.js', () => redemptionMock);
vi.mock('../../discord.js', () => discordMock);

import { applyCtxCardStatus } from '../mirror-apply.js';

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
    expectedCommissionMinor: null,
    ctxOrderId: 'gc-1',
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

async function stateOf(id: string): Promise<OrderState | undefined> {
  return (await db.collection('orders').findOne({ id }))?.state;
}

beforeEach(() => {
  __resetDbForTests();
  vi.clearAllMocks();
});

describe('applyCtxCardStatus', () => {
  it('moves an expired row to fulfilled when CTX reports the card fulfilled', async () => {
    const order = await seedOrder('expired', {
      failedAt: new Date(),
      failureReason: 'payment window expired',
    });
    await applyCtxCardStatus(order, { id: 'gc-1', displayStatus: 'fulfilled' });
    const stored = await db.collection('orders').findOne({ id: order.id });
    expect(stored?.state).toBe('fulfilled');
    expect(stored?.failedAt).toBeNull();
    expect(stored?.failureReason).toBeNull();
    expect(stored?.redeemCode).toBe('CODE-1');
    expect(discordMock.notifyOrderFulfilled).toHaveBeenCalledTimes(1);
  });

  it('moves an expired row to paid when CTX reports the card paid', async () => {
    const order = await seedOrder('expired');
    await applyCtxCardStatus(order, { id: 'gc-1', displayStatus: 'paid' });
    expect(await stateOf(order.id)).toBe('paid');
  });

  it('moves a rejected row to paid when CTX reports the card paid', async () => {
    const order = await seedOrder('rejected');
    await applyCtxCardStatus(order, { id: 'gc-1', displayStatus: 'paid' });
    expect(await stateOf(order.id)).toBe('paid');
  });

  it('moves a fulfilled row back to unpaid when CTX reports the card unpaid', async () => {
    const order = await seedOrder('fulfilled');
    await applyCtxCardStatus(order, { id: 'gc-1', displayStatus: 'unpaid' });
    expect(await stateOf(order.id)).toBe('unpaid');
  });

  it('is a no-op when the local state already matches CTX', async () => {
    const order = await seedOrder('fulfilled', { redeemCode: 'KEEP' });
    await applyCtxCardStatus(order, { id: 'gc-1', displayStatus: 'fulfilled' });
    const stored = await db.collection('orders').findOne({ id: order.id });
    expect(stored?.redeemCode).toBe('KEEP');
    expect(discordMock.notifyOrderFulfilled).not.toHaveBeenCalled();
  });

  it('moves an unpaid row to expired when CTX reports the card expired', async () => {
    const order = await seedOrder('unpaid');
    await applyCtxCardStatus(order, { id: 'gc-1', displayStatus: 'expired' });
    const stored = await db.collection('orders').findOne({ id: order.id });
    expect(stored?.state).toBe('expired');
    expect(stored?.failedAt).toBeInstanceOf(Date);
    expect(stored?.failureReason).toBe('payment window expired');
  });

  it('leaves the row untouched on an unknown displayStatus', async () => {
    const order = await seedOrder('paid');
    await applyCtxCardStatus(order, { id: 'gc-1', displayStatus: 'archived' });
    expect(await stateOf(order.id)).toBe('paid');
  });
});
