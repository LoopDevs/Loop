// Order-repository tests (ADR 052 mirror model)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, __resetDbForTests } from '../../db/client.js';
import {
  createOrder,
  IdempotentOrderConflictError,
  recordCtxCreate,
  recordOrderEconomics,
  getOrderById,
  getOrderByCtxOrderId,
  listOpenMirrorOrders,
  findOwnedOrder,
} from '../repo.js';

beforeEach(() => {
  __resetDbForTests();
});

describe('createOrder', () => {
  it('inserts an unpaid mirror doc with the charge provisionally pinned to face value', async () => {
    const row = await createOrder({
      userId: 'u-1',
      merchantId: 'm-1',
      faceValueMinor: 2500n,
      currency: 'USD',
      paymentCryptoCurrency: 'XLM',
    });
    const stored = await db.collection('orders').findOne({ id: row.id });
    expect(stored).toMatchObject({
      userId: 'u-1',
      merchantId: 'm-1',
      faceValueMinor: 2500,
      currency: 'USD',
      chargeMinor: 2500,
      chargeCurrency: 'USD',
      userCashbackMinor: 0,
      paymentCryptoCurrency: 'XLM',
      state: 'unpaid',
      idempotencyKey: null,
      ctxOrderId: null,
    });
  });

  it('carries the idempotency key onto the doc when supplied', async () => {
    const row = await createOrder({
      userId: 'u-1',
      merchantId: 'm-1',
      faceValueMinor: 100n,
      currency: 'GBP',
      paymentCryptoCurrency: 'DASH',
      idempotencyKey: 'k'.repeat(20),
    });
    const stored = await db.collection('orders').findOne({ id: row.id });
    expect(stored?.idempotencyKey).toBe('k'.repeat(20));
  });

  it('A2-2003: a (user, key) unique violation resolves to IdempotentOrderConflictError carrying the prior doc', async () => {
    const prior = await createOrder({
      userId: 'u-1',
      merchantId: 'm-1',
      faceValueMinor: 100n,
      currency: 'USD',
      paymentCryptoCurrency: 'XLM',
      idempotencyKey: 'k'.repeat(20),
    });
    await expect(
      createOrder({
        userId: 'u-1',
        merchantId: 'm-1',
        faceValueMinor: 100n,
        currency: 'USD',
        paymentCryptoCurrency: 'XLM',
        idempotencyKey: 'k'.repeat(20),
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(IdempotentOrderConflictError);
      expect((err as IdempotentOrderConflictError).existing.id).toBe(prior.id);
      return true;
    });
    expect(await db.collection('orders').count({ userId: 'u-1' })).toBe(1);
  });

  it('the same key under DIFFERENT users does not conflict', async () => {
    await createOrder({
      userId: 'u-1',
      merchantId: 'm-1',
      faceValueMinor: 100n,
      currency: 'USD',
      paymentCryptoCurrency: 'XLM',
      idempotencyKey: 'shared-key-1234567890',
    });
    await expect(
      createOrder({
        userId: 'u-2',
        merchantId: 'm-1',
        faceValueMinor: 100n,
        currency: 'USD',
        paymentCryptoCurrency: 'XLM',
        idempotencyKey: 'shared-key-1234567890',
      }),
    ).resolves.toMatchObject({ userId: 'u-2' });
  });

  it('key-less orders never trip the idempotency tuple (null-exempt partial unique)', async () => {
    await createOrder({
      userId: 'u-1',
      merchantId: 'm-1',
      faceValueMinor: 100n,
      currency: 'USD',
      paymentCryptoCurrency: 'XLM',
    });
    await createOrder({
      userId: 'u-1',
      merchantId: 'm-1',
      faceValueMinor: 100n,
      currency: 'USD',
      paymentCryptoCurrency: 'XLM',
    });
    expect(await db.collection('orders').count({ userId: 'u-1' })).toBe(2);
  });

  it('rethrows non-idempotency insert failures unchanged', async () => {
    const orders = db.collection('orders');
    const insertSpy = vi
      .spyOn(orders, 'insertOne')
      .mockRejectedValueOnce(new Error('connection reset'));
    await expect(
      createOrder({
        userId: 'u-1',
        merchantId: 'm-1',
        faceValueMinor: 100n,
        currency: 'USD',
        paymentCryptoCurrency: 'XLM',
      }),
    ).rejects.toThrow('connection reset');
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });
});

describe('recordCtxCreate', () => {
  async function seed(): Promise<string> {
    const row = await createOrder({
      userId: 'u-1',
      merchantId: 'm-1',
      faceValueMinor: 2500n,
      currency: 'USD',
      paymentCryptoCurrency: 'XLM',
    });
    return row.id;
  }

  it('writes the CTX identifiers + actual charge', async () => {
    const id = await seed();
    await recordCtxCreate(id, {
      ctxOrderId: 'ctx-1',
      ctxPaymentId: 'pay-1',
      chargeMinor: 2400n,
      chargeCurrency: 'USD',
    });
    const stored = await db.collection('orders').findOne({ id });
    expect(stored).toMatchObject({
      ctxOrderId: 'ctx-1',
      ctxPaymentId: 'pay-1',
      chargeMinor: 2400,
      chargeCurrency: 'USD',
    });
  });

  it('leaves absent fields untouched (null = unknown, never overwrite)', async () => {
    const id = await seed();
    await recordCtxCreate(id, {
      ctxOrderId: 'ctx-1',
      ctxPaymentId: null,
      chargeMinor: null,
      chargeCurrency: null,
    });
    const stored = await db.collection('orders').findOne({ id });
    expect(stored?.ctxOrderId).toBe('ctx-1');
    expect(stored?.ctxPaymentId).toBeNull();
    expect(stored?.chargeMinor).toBe(2500);
    expect(stored?.chargeCurrency).toBe('USD');
  });
});

describe('recordOrderEconomics', () => {
  async function seed(): Promise<string> {
    const row = await createOrder({
      userId: 'u-1',
      merchantId: 'm-1',
      faceValueMinor: 2500n,
      currency: 'USD',
      paymentCryptoCurrency: 'XLM',
    });
    return row.id;
  }

  it('writes only the non-null economics fields', async () => {
    const id = await seed();
    await recordOrderEconomics(id, {
      userCashbackMinor: 50n,
      expectedCommissionMinor: null,
    });
    const stored = await db.collection('orders').findOne({ id });
    expect(stored?.userCashbackMinor).toBe(50);
    expect(stored?.expectedCommissionMinor).toBeNull();
  });

  it('is a no-op when both fields are unknown', async () => {
    const id = await seed();
    const orders = db.collection('orders');
    const updateSpy = vi.spyOn(orders, 'updateOne');
    await recordOrderEconomics(id, {
      userCashbackMinor: null,
      expectedCommissionMinor: null,
    });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe('read helpers', () => {
  it('getOrderById / getOrderByCtxOrderId / findOwnedOrder resolve the right docs', async () => {
    const row = await createOrder({
      userId: 'u-1',
      merchantId: 'm-1',
      faceValueMinor: 100n,
      currency: 'USD',
      paymentCryptoCurrency: 'XLM',
    });
    await recordCtxCreate(row.id, {
      ctxOrderId: 'ctx-42',
      ctxPaymentId: null,
      chargeMinor: null,
      chargeCurrency: null,
    });
    expect((await getOrderById(row.id))?.id).toBe(row.id);
    expect(await getOrderById('missing')).toBeNull();
    expect((await getOrderByCtxOrderId('ctx-42'))?.id).toBe(row.id);
    expect((await findOwnedOrder('u-1', row.id))?.id).toBe(row.id);
    expect(await findOwnedOrder('u-2', row.id)).toBeNull();
  });

  it('listOpenMirrorOrders returns only non-terminal docs, oldest-first, honouring the limit', async () => {
    const a = await createOrder({
      userId: 'u-1',
      merchantId: 'm-1',
      faceValueMinor: 100n,
      currency: 'USD',
      paymentCryptoCurrency: 'XLM',
    });
    const b = await createOrder({
      userId: 'u-1',
      merchantId: 'm-2',
      faceValueMinor: 100n,
      currency: 'USD',
      paymentCryptoCurrency: 'XLM',
    });
    const c = await createOrder({
      userId: 'u-1',
      merchantId: 'm-3',
      faceValueMinor: 100n,
      currency: 'USD',
      paymentCryptoCurrency: 'XLM',
    });
    const orders = db.collection('orders');
    await orders.updateOne({ id: a.id }, { $set: { createdAt: new Date('2026-01-01T00:00:00Z') } });
    await orders.updateOne(
      { id: b.id },
      { $set: { createdAt: new Date('2026-01-02T00:00:00Z'), state: 'paid' } },
    );
    await orders.updateOne(
      { id: c.id },
      { $set: { createdAt: new Date('2026-01-03T00:00:00Z'), state: 'fulfilled' } },
    );

    const open = await listOpenMirrorOrders(10);
    expect(open.map((o) => o.id)).toEqual([a.id, b.id]);
    expect(await listOpenMirrorOrders(1)).toHaveLength(1);
  });
});
