import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// fetchRedemption is the unit under the sweeper — fully mocked here;
// its own fetch/parse behaviour is covered by redemption.test.ts.
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
  // CF-12: backfill now also aborts (without burning attempts) on a
  // CTX rate-limit; the module imports this error for the instanceof.
  class CtxRateLimitedError extends Error {
    readonly retryAfterMs: number | null;
    constructor(message: string, retryAfterMs: number | null = null) {
      super(message);
      this.name = 'CtxRateLimitedError';
      this.retryAfterMs = retryAfterMs;
    }
  }
  return { CtxUnavailableError, CtxRateLimitedError };
});

import { db, __resetDbForTests, withSingleFlight } from '../../db/client.js';
import type { OrderDoc } from '../../db/types.js';
import { CtxUnavailableError, CtxRateLimitedError } from '../../ctx/api-fetch.js';
import {
  runRedemptionBackfillTick,
  redemptionBackfillDelayMs,
  REDEMPTION_BACKFILL_MAX_ATTEMPTS,
} from '../redemption-backfill.js';

const NOW = 1_900_000_000_000;

/**
 * Seeds a fulfilled candidate doc (ctxOrderId captured, no redemption
 * payload) into the real store — the sweeper's candidate shape.
 */
async function seedRow(
  overrides: Partial<{
    id: string;
    userId: string;
    merchantId: string;
    ctxOrderId: string | null;
    fulfilledAt: Date | null;
    attempts: number;
    lastAttemptAt: Date | null;
  }> = {},
): Promise<void> {
  await db.collection('orders').insertOne({
    id: overrides.id ?? 'order-1',
    userId: overrides.userId ?? 'user-1',
    merchantId: overrides.merchantId ?? 'merchant-1',
    faceValueMinor: 1000,
    currency: 'USD',
    chargeMinor: 1000,
    chargeCurrency: 'USD',
    userCashbackMinor: 0,
    expectedCommissionMinor: null,
    ctxOrderId: overrides.ctxOrderId !== undefined ? overrides.ctxOrderId : 'ctx-1',
    ctxPaymentId: null,
    paymentCryptoCurrency: 'XLM',
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    redemptionBackfillAttempts: overrides.attempts ?? 0,
    redemptionBackfillLastAttemptAt: overrides.lastAttemptAt ?? null,
    state: 'fulfilled',
    failureReason: null,
    idempotencyKey: null,
    createdAt: new Date(NOW - 2 * 60 * 60 * 1000),
    fulfilledAt:
      overrides.fulfilledAt !== undefined ? overrides.fulfilledAt : new Date(NOW - 60 * 60 * 1000),
    failedAt: null,
  });
}

async function getRow(id: string): Promise<OrderDoc | null> {
  return db.collection('orders').findOne({ id });
}

beforeEach(() => {
  __resetDbForTests();
  fetchRedemptionMock.mockReset();
  notifyExhaustedMock.mockReset();
});

describe('redemptionBackfillDelayMs', () => {
  it('grows exponentially from the 1-minute base', () => {
    expect(redemptionBackfillDelayMs(0)).toBe(60_000);
    expect(redemptionBackfillDelayMs(1)).toBe(120_000);
    expect(redemptionBackfillDelayMs(3)).toBe(480_000);
  });

  it('caps at 8 hours', () => {
    expect(redemptionBackfillDelayMs(9)).toBe(8 * 60 * 60 * 1000);
    expect(redemptionBackfillDelayMs(30)).toBe(8 * 60 * 60 * 1000);
  });
});

describe('runRedemptionBackfillTick', () => {
  it('recovers redemption fields and persists them', async () => {
    await seedRow();
    fetchRedemptionMock.mockResolvedValueOnce({ code: 'C-123', pin: '99', url: null });
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.recovered).toBe(1);
    expect(r.stillEmpty).toBe(0);
    expect(fetchRedemptionMock).toHaveBeenCalledWith('ctx-1');
    const stored = (await getRow('order-1'))!;
    expect(stored.redeemCode).toBe('C-123'); // no envelope key in this env → plaintext
    expect(stored.redeemPin).toBe('99');
    expect(stored.redeemUrl).toBeNull();
    expect(stored.redemptionBackfillAttempts).toBe(1);
    expect(notifyExhaustedMock).not.toHaveBeenCalled();
  });

  it('still-empty payload bumps attempts + last-attempt timestamp only', async () => {
    await seedRow({ attempts: 2 });
    fetchRedemptionMock.mockResolvedValueOnce({ code: null, pin: null, url: null });
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.stillEmpty).toBe(1);
    expect(r.recovered).toBe(0);
    const stored = (await getRow('order-1'))!;
    expect(stored.redemptionBackfillAttempts).toBe(3);
    expect(stored.redemptionBackfillLastAttemptAt).toEqual(new Date(NOW));
    expect(stored.redeemCode).toBeNull();
    expect(notifyExhaustedMock).not.toHaveBeenCalled();
  });

  it('skips rows whose backoff window has not elapsed', async () => {
    // attempts=3 → next attempt due 8 min after the last; only 1 min
    // has passed.
    await seedRow({ attempts: 3, lastAttemptAt: new Date(NOW - 60_000) });
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.notDueYet).toBe(1);
    expect(fetchRedemptionMock).not.toHaveBeenCalled();
    expect((await getRow('order-1'))!.redemptionBackfillAttempts).toBe(3);
  });

  it('re-fetches once the backoff window has elapsed', async () => {
    await seedRow({ attempts: 3, lastAttemptAt: new Date(NOW - 9 * 60_000) });
    fetchRedemptionMock.mockResolvedValueOnce({ code: null, pin: null, url: 'https://r.example' });
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.recovered).toBe(1);
    expect(fetchRedemptionMock).toHaveBeenCalledTimes(1);
  });

  it('excludes rows at/past the attempts cap and rows that already have a payload', async () => {
    await seedRow({ id: 'order-capped', attempts: REDEMPTION_BACKFILL_MAX_ATTEMPTS });
    await seedRow({ id: 'order-has-payload' });
    await db
      .collection('orders')
      .updateOne({ id: 'order-has-payload' }, { $set: { redeemCode: 'ALREADY' } });
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.picked).toBe(0);
    expect(fetchRedemptionMock).not.toHaveBeenCalled();
  });

  it('pages ops exactly once when an order exhausts the attempts cap still empty', async () => {
    await seedRow({
      attempts: REDEMPTION_BACKFILL_MAX_ATTEMPTS - 1,
      lastAttemptAt: new Date(NOW - 24 * 60 * 60 * 1000),
    });
    fetchRedemptionMock.mockResolvedValueOnce({ code: null, pin: null, url: null });
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.exhausted).toBe(1);
    expect(notifyExhaustedMock).toHaveBeenCalledTimes(1);
    expect(notifyExhaustedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-1',
        userId: 'user-1',
        merchantId: 'merchant-1',
        ctxOrderId: 'ctx-1',
        attempts: REDEMPTION_BACKFILL_MAX_ATTEMPTS,
      }),
    );
  });

  it('does not page when the attempts-bump update loses the race', async () => {
    await seedRow({
      attempts: REDEMPTION_BACKFILL_MAX_ATTEMPTS - 1,
      lastAttemptAt: new Date(NOW - 24 * 60 * 60 * 1000),
    });
    // Simulate the concurrent writer owning the bump: the CAS filter
    // (`redemptionBackfillAttempts = row.attempts`) misses because the
    // stored count moved between the read and the write.
    const orders = db.collection('orders');
    const realUpdateOne = orders.updateOne.bind(orders);
    vi.spyOn(orders, 'updateOne').mockImplementationOnce(async (filter, update, options) => {
      await realUpdateOne(
        { id: 'order-1' },
        { $set: { redemptionBackfillAttempts: REDEMPTION_BACKFILL_MAX_ATTEMPTS } },
      );
      return realUpdateOne(filter, update, options);
    });
    fetchRedemptionMock.mockResolvedValueOnce({ code: null, pin: null, url: null });
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.exhausted).toBe(0);
    expect(notifyExhaustedMock).not.toHaveBeenCalled();
  });

  it('aborts the tick on pool-wide operator outage without burning attempts', async () => {
    await seedRow({ id: 'order-1' });
    await seedRow({ id: 'order-2', ctxOrderId: 'ctx-2' });
    fetchRedemptionMock.mockRejectedValueOnce(new CtxUnavailableError('pool down'));
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.abortedCtxUnavailable).toBe(true);
    // First row aborted the loop — second row never fetched, no
    // attempts consumed for either.
    expect(fetchRedemptionMock).toHaveBeenCalledTimes(1);
    expect((await getRow('order-1'))!.redemptionBackfillAttempts).toBe(0);
    expect((await getRow('order-2'))!.redemptionBackfillAttempts).toBe(0);
    expect(notifyExhaustedMock).not.toHaveBeenCalled();
  });

  it('CF-12: aborts the tick on a CTX rate-limit (429) without burning attempts', async () => {
    await seedRow({ id: 'order-1' });
    await seedRow({ id: 'order-2', ctxOrderId: 'ctx-2' });
    fetchRedemptionMock.mockRejectedValueOnce(new CtxRateLimitedError('rate limited', 5000));
    const r = await runRedemptionBackfillTick({ now: NOW });
    // A 429 is our-side back-pressure, not evidence CTX has no payload —
    // abort like a pool outage so neither row burns a retry.
    expect(r.abortedCtxUnavailable).toBe(true);
    expect(fetchRedemptionMock).toHaveBeenCalledTimes(1);
    expect((await getRow('order-1'))!.redemptionBackfillAttempts).toBe(0);
  });

  it('a non-pool fetch error records the attempt and continues to the next row', async () => {
    // Distinct fulfilledAt values pin the oldest-first sweep order.
    await seedRow({ id: 'order-1', fulfilledAt: new Date(NOW - 2 * 60 * 60 * 1000) });
    await seedRow({ id: 'order-2', ctxOrderId: 'ctx-2' });
    fetchRedemptionMock
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ code: 'C-2', pin: null, url: null });
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.errors).toBe(1);
    expect(r.recovered).toBe(1);
    expect(fetchRedemptionMock).toHaveBeenCalledTimes(2);
    // Attempts-bump for order-1, recovery for order-2.
    expect((await getRow('order-1'))!.redemptionBackfillAttempts).toBe(1);
    expect((await getRow('order-2'))!.redeemCode).toBe('C-2');
  });

  it('returns all-zero counters when no candidate rows exist', async () => {
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r).toEqual({
      picked: 0,
      notDueYet: 0,
      recovered: 0,
      stillEmpty: 0,
      exhausted: 0,
      errors: 0,
      abortedCtxUnavailable: false,
      skippedLocked: false,
    });
    expect(fetchRedemptionMock).not.toHaveBeenCalled();
  });

  it('releases the lock + returns empty when the sweep body exceeds the lease deadline', async () => {
    // A hung store read: the candidate scan never resolves. The lease
    // must fire so the single-flight key is released and the sweep is
    // not stalled forever.
    vi.useFakeTimers();
    try {
      const orders = db.collection('orders');
      vi.spyOn(orders, 'findMany').mockImplementationOnce(() => new Promise(() => undefined));
      const tickPromise = runRedemptionBackfillTick({ now: NOW });
      // Advance past the 240s lease — the Promise.race timeout wins.
      await vi.advanceTimersByTimeAsync(240_001);
      const r = await tickPromise;
      expect(r).toEqual({
        picked: 0,
        notDueYet: 0,
        recovered: 0,
        stillEmpty: 0,
        exhausted: 0,
        errors: 0,
        abortedCtxUnavailable: false,
        skippedLocked: false,
      });
      expect(fetchRedemptionMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('S4-8: skips the sweep while another caller holds the redemption-backfill single-flight', async () => {
    await seedRow();
    // Occupy the sweep's single-flight key with a slow holder, exactly
    // as an in-flight tick would.
    let releaseHolder!: () => void;
    const holder = withSingleFlight(
      'redemption-backfill',
      () => new Promise<void>((resolve) => (releaseHolder = resolve)),
    );
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r).toEqual({
      picked: 0,
      notDueYet: 0,
      recovered: 0,
      stillEmpty: 0,
      exhausted: 0,
      errors: 0,
      abortedCtxUnavailable: false,
      skippedLocked: true,
    });
    expect(fetchRedemptionMock).not.toHaveBeenCalled();
    releaseHolder();
    await holder;
  });
});
