// refetchOrderRedemption (ADR 037) — admin re-drive through backfill machinery
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { fetchRedemptionMock } = vi.hoisted(() => ({ fetchRedemptionMock: vi.fn() }));
vi.mock('../procurement-redemption.js', () => ({
  fetchRedemption: (ctxOrderId: string) => fetchRedemptionMock(ctxOrderId),
}));

const { notifyExhaustedMock } = vi.hoisted(() => ({ notifyExhaustedMock: vi.fn() }));
vi.mock('../../discord.js', () => ({
  notifyRedemptionBackfillExhausted: (args: unknown) => notifyExhaustedMock(args),
}));

vi.mock('../../ctx/api-fetch.js', () => {
  class CtxUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'CtxUnavailableError';
    }
  }
  class CtxRateLimitedError extends Error {
    readonly retryAfterMs: number | null = null;
  }
  return { CtxUnavailableError, CtxRateLimitedError };
});

import { db, __resetDbForTests } from '../../db/client.js';
import type { OrderDoc, OrderState } from '../../db/types.js';
import { CtxUnavailableError } from '../../ctx/api-fetch.js';
import {
  refetchOrderRedemption,
  REDEMPTION_BACKFILL_MAX_ATTEMPTS,
} from '../redemption-backfill.js';

const NOW = 1_900_000_000_000;
const ORDER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

async function seedRow(
  overrides: Partial<{
    state: OrderState;
    ctxOrderId: string | null;
    redeemCode: string | null;
    redeemUrl: string | null;
    attempts: number;
  }> = {},
): Promise<void> {
  await db.collection('orders').insertOne({
    id: ORDER_ID,
    userId: 'user-1',
    merchantId: 'merch-1',
    faceValueMinor: 1000,
    currency: 'USD',
    chargeMinor: 1000,
    chargeCurrency: 'USD',
    userCashbackMinor: 0,
    expectedCommissionMinor: null,
    ctxOrderId: overrides.ctxOrderId !== undefined ? overrides.ctxOrderId : 'ctx-1',
    ctxPaymentId: null,
    paymentCryptoCurrency: 'XLM',
    redeemCode: overrides.redeemCode ?? null,
    redeemPin: null,
    redeemUrl: overrides.redeemUrl ?? null,
    redemptionBackfillAttempts: overrides.attempts ?? 0,
    redemptionBackfillLastAttemptAt: null,
    state: overrides.state ?? 'fulfilled',
    failureReason: null,
    idempotencyKey: null,
    createdAt: new Date(NOW - 2 * 60 * 60 * 1000),
    fulfilledAt: new Date(NOW - 60 * 60 * 1000),
    failedAt: null,
  });
}

async function getRow(): Promise<OrderDoc | null> {
  return db.collection('orders').findOne({ id: ORDER_ID });
}

beforeEach(() => {
  __resetDbForTests();
  fetchRedemptionMock.mockReset();
  notifyExhaustedMock.mockReset();
});

describe('refetchOrderRedemption — eligibility gates', () => {
  it('order_not_found when no doc matches', async () => {
    const out = await refetchOrderRedemption(ORDER_ID, NOW);
    expect(out).toEqual({ kind: 'order_not_found' });
    expect(fetchRedemptionMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ state: 'paid' as const }, 'not_fulfilled'],
    [{ ctxOrderId: null }, 'no_ctx_order_id'],
    [{ redeemCode: 'CODE' }, 'already_present'],
    [{ redeemUrl: 'https://x' }, 'already_present'],
  ])('not_eligible %o → %s', async (overrides, reason) => {
    await seedRow(overrides);
    const out = await refetchOrderRedemption(ORDER_ID, NOW);
    expect(out).toEqual({ kind: 'not_eligible', reason });
    expect(fetchRedemptionMock).not.toHaveBeenCalled();
  });

  it('ctx_unavailable maps the CTX-unavailable error (no attempt burned)', async () => {
    await seedRow();
    fetchRedemptionMock.mockRejectedValue(new CtxUnavailableError('pool down'));
    const out = await refetchOrderRedemption(ORDER_ID, NOW);
    expect(out).toEqual({ kind: 'ctx_unavailable' });
    expect((await getRow())!.redemptionBackfillAttempts).toBe(0);
  });
});

describe('refetchOrderRedemption — recovery + bookkeeping', () => {
  it('persists a recovered payload through the idempotent guards', async () => {
    await seedRow({ attempts: 3 });
    fetchRedemptionMock.mockResolvedValue({ code: 'CODE', pin: null, url: null });
    const out = await refetchOrderRedemption(ORDER_ID, NOW);
    expect(out).toEqual({
      kind: 'recovered',
      attempts: 4,
      hasCode: true,
      hasPin: false,
      hasUrl: false,
    });
    const stored = (await getRow())!;
    expect(stored.redeemCode).toBe('CODE');
    expect(stored.redemptionBackfillAttempts).toBe(4);
  });

  it('losing the persist race still reports recovered (concurrent writer won)', async () => {
    await seedRow({ attempts: 3 });
    const orders = db.collection('orders');
    const realUpdateOne = orders.updateOne.bind(orders);
    vi.spyOn(orders, 'updateOne').mockImplementationOnce(async (filter, update, options) => {
      await realUpdateOne({ id: ORDER_ID }, { $set: { redeemCode: 'RACED-IN' } });
      return realUpdateOne(filter, update, options);
    });
    fetchRedemptionMock.mockResolvedValue({ code: 'CODE', pin: null, url: null });
    const out = await refetchOrderRedemption(ORDER_ID, NOW);
    expect(out).toMatchObject({ kind: 'recovered', attempts: 3 });
    expect((await getRow())!.redeemCode).toBe('RACED-IN');
  });

  it('still_empty bumps the attempts counter', async () => {
    await seedRow({ attempts: 4 });
    fetchRedemptionMock.mockResolvedValue({ code: null, pin: null, url: null });
    const out = await refetchOrderRedemption(ORDER_ID, NOW);
    expect(out).toMatchObject({ kind: 'still_empty', attempts: 5 });
    expect((await getRow())!.redemptionBackfillAttempts).toBe(5);
    expect(notifyExhaustedMock).not.toHaveBeenCalled();
  });

  it('runs past the sweeper cap without re-paging ops (no-cap contract)', async () => {
    await seedRow({ attempts: REDEMPTION_BACKFILL_MAX_ATTEMPTS });
    fetchRedemptionMock.mockResolvedValue({ code: null, pin: null, url: null });
    const out = await refetchOrderRedemption(ORDER_ID, NOW);
    expect(out).toMatchObject({
      kind: 'still_empty',
      attempts: REDEMPTION_BACKFILL_MAX_ATTEMPTS + 1,
    });
    expect(notifyExhaustedMock).not.toHaveBeenCalled();
  });

  it('pages ops exactly when the bump crosses the cap (parity with the sweeper)', async () => {
    await seedRow({ attempts: REDEMPTION_BACKFILL_MAX_ATTEMPTS - 1 });
    fetchRedemptionMock.mockResolvedValue({ code: null, pin: null, url: null });
    await refetchOrderRedemption(ORDER_ID, NOW);
    expect(notifyExhaustedMock).toHaveBeenCalledOnce();
  });
});
