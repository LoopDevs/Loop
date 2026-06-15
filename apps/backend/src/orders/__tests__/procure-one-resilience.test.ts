/**
 * CF-12 / CF-13: `procureOne` must DEFER (revert procuring → paid),
 * not FAIL, when CTX is rate-limiting us (429) or every operator
 * bearer is expired (401). A self-sustaining hot loop that marks real
 * paid orders `failed` on transient back-pressure is the exact failure
 * the audit flagged.
 *
 * Pure unit test — every dependency `procureOne` touches before /
 * around the operator fetch is mocked, so no postgres / Horizon /
 * Stellar is needed (the integration ladder in
 * `__tests__/integration/procurement-worker.test.ts` covers the
 * real-postgres happy path + pool-unavailable revert).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Order } from '../repo.js';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

// Phase-1 mode skips the Horizon USDC-balance read entirely, so the
// asset picker / balance read never run. Pin XLM the way production does.
// `GIFT_CARD_API_BASE_URL` is needed because `upstreamUrl('/gift-cards')`
// reads it when building the operator-fetch URL (before the mocked fetch).
vi.mock('../../env.js', () => ({
  env: {
    GIFT_CARD_API_BASE_URL: 'https://ctx.test',
    LOOP_PHASE_1_ONLY: true,
    LOOP_STELLAR_USDC_FLOOR_STROOPS: null,
    LOOP_STELLAR_DEPOSIT_ADDRESS: undefined,
  },
}));

// State-transition spies — the heart of the assertion.
const { markProcuring, markFailed, revertToPaid, markFulfilled } = vi.hoisted(() => ({
  markProcuring: vi.fn(),
  markFailed: vi.fn(),
  revertToPaid: vi.fn(),
  markFulfilled: vi.fn(),
}));
vi.mock('../transitions.js', () => ({
  markOrderProcuring: markProcuring,
  markOrderFailed: markFailed,
  revertOrderProcuringToPaid: revertToPaid,
  markOrderFulfilled: markFulfilled,
}));

// operatorFetch is the seam we drive to throw the transient errors.
// Import the real error classes so `instanceof` in procureOne matches.
const { operatorFetchMock } = vi.hoisted(() => ({ operatorFetchMock: vi.fn() }));
vi.mock('../../ctx/operator-pool.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, operatorFetch: operatorFetchMock };
});

// Everything else procureOne references — stubbed so the module loads.
vi.mock('../../discord.js', () => ({
  notifyCashbackCredited: vi.fn(),
  notifyUsdcBelowFloor: vi.fn(),
}));
vi.mock('../../merchants/sync.js', () => ({
  getMerchants: () => ({ merchantsById: new Map() }),
}));
vi.mock('../procurement-redemption.js', () => ({
  waitForRedemption: vi.fn(async () => ({ code: null, pin: null, url: null })),
}));
vi.mock('../procurement-asset-picker.js', () => ({
  pickProcurementAsset: () => 'XLM',
  readUsdcBalanceSafely: vi.fn(async () => null),
  shouldAlertBelowFloor: () => false,
}));

import { procureOne } from '../procure-one.js';
import { OperatorPoolUnavailableError, OperatorRateLimitedError } from '../../ctx/operator-pool.js';

function fakeOrder(): Order {
  return {
    id: 'order-1',
    merchantId: 'amazon',
    currency: 'USD',
    faceValueMinor: 1000n,
  } as unknown as Order;
}

beforeEach(() => {
  markProcuring.mockReset();
  markFailed.mockReset();
  revertToPaid.mockReset();
  markFulfilled.mockReset();
  operatorFetchMock.mockReset();
  // Claim succeeds — return the order row so procureOne proceeds.
  markProcuring.mockResolvedValue(fakeOrder());
  revertToPaid.mockResolvedValue(fakeOrder());
});

describe('procureOne — CF-12/CF-13 transient deferral', () => {
  it('CF-12: a 429 (OperatorRateLimitedError) reverts procuring → paid and does NOT fail the order', async () => {
    operatorFetchMock.mockRejectedValue(new OperatorRateLimitedError('all operators 429', 7000));
    const outcome = await procureOne(fakeOrder());
    expect(outcome).toBe('skipped');
    expect(revertToPaid).toHaveBeenCalledWith('order-1');
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('CF-13: an all-401 (OperatorPoolUnavailableError) reverts procuring → paid and does NOT fail the order', async () => {
    operatorFetchMock.mockRejectedValue(
      new OperatorPoolUnavailableError('all operators 401 (bearer expired)'),
    );
    const outcome = await procureOne(fakeOrder());
    expect(outcome).toBe('skipped');
    expect(revertToPaid).toHaveBeenCalledWith('order-1');
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('a genuinely unexpected throw still marks the order failed (no regression)', async () => {
    operatorFetchMock.mockRejectedValue(new Error('kaboom'));
    const outcome = await procureOne(fakeOrder());
    expect(outcome).toBe('failed');
    expect(markFailed).toHaveBeenCalled();
    expect(revertToPaid).not.toHaveBeenCalled();
  });
});
