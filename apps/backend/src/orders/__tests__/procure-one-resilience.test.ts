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

// CF-28: pay-ctx is the seam we drive to FAIL once the order has reached
// the principal-switch hop. Keep the REAL error classes
// (PayCtxConfigError / PayCtxReconcileError) so `instanceof` in
// procureOne matches; only `payCtxOrder` is replaced.
const { payCtxOrderMock } = vi.hoisted(() => ({ payCtxOrderMock: vi.fn() }));
vi.mock('../pay-ctx.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, payCtxOrder: payCtxOrderMock };
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
import { PayCtxConfigError, PayCtxReconcileError } from '../pay-ctx.js';
import { PayoutSubmitError } from '../../payments/payout-submit.js';

function fakeOrder(): Order {
  return {
    id: 'order-1',
    merchantId: 'amazon',
    currency: 'USD',
    faceValueMinor: 1000n,
  } as unknown as Order;
}

// A valid CTX create-response with a well-formed SEP-7 XLM payment URI,
// so procureOne sails past the schema / paymentUrls / SEP-7-parse guards
// and reaches the payCtxOrder hop (the CF-28 surface). `as Response`
// keeps the seam honest — procureOne only touches `.ok`/`.json()`.
function okCtxResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'ctx-order-1',
      paymentUrls: {
        XLM: 'web+stellar:pay?destination=GCTX1234&amount=0.1198323&memo=order-1',
      },
      paymentCryptoAmount: '0.1198323',
    }),
    text: async () => '',
  } as unknown as Response;
}

// A CTX response whose XLM paymentUrls entry is present but NOT a valid
// SEP-7 URI — exercises the real `parseSep7PayUri` reject branch.
function badSep7CtxResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'ctx-order-1',
      paymentUrls: { XLM: 'not-a-sep7-uri' },
    }),
    text: async () => '',
  } as unknown as Response;
}

// A CTX response with NO paymentUrls — the missing-paymentUrls branch.
function noPaymentUrlsCtxResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ id: 'ctx-order-1' }),
    text: async () => '',
  } as unknown as Response;
}

beforeEach(() => {
  markProcuring.mockReset();
  markFailed.mockReset();
  revertToPaid.mockReset();
  markFulfilled.mockReset();
  operatorFetchMock.mockReset();
  payCtxOrderMock.mockReset();
  // Claim succeeds — return the order row so procureOne proceeds.
  markProcuring.mockResolvedValue(fakeOrder());
  revertToPaid.mockResolvedValue(fakeOrder());
  // Fulfillment, if ever reached, returns a no-cashback row.
  markFulfilled.mockResolvedValue({
    id: 'order-1',
    merchantId: 'amazon',
    userId: 'user-1',
    userCashbackMinor: 0n,
    chargeCurrency: 'USD',
  });
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

/**
 * CF-28 (x-tests X-T-01, v-orders P2-01) — the stranded-order /
 * pay-ctx regression guard. This branch's namesake. When the
 * principal-switch hop (`payCtxOrder`) FAILS, the order MUST be marked
 * `failed` and MUST NEVER reach `markOrderFulfilled` — a fulfilled
 * order that is `unpaid` on CTX's side is the exact pre-#1366 stranded
 * class (four real orders fulfilled in our ledger but never paid CTX).
 *
 * A refactor that reorders `markOrderFulfilled` ahead of `payCtxOrder`,
 * or swallows a pay-ctx throw, would re-strand orders — every previous
 * test mocked `payCtxOrder` to SUCCEED, so none of them would catch it.
 * These do.
 */
describe('procureOne — CF-28 pay-ctx failure NEVER fulfils (stranded-order guard)', () => {
  beforeEach(() => {
    // Operator create-call succeeds with a valid SEP-7 URI so we always
    // reach the payCtxOrder hop in these cases.
    operatorFetchMock.mockResolvedValue(okCtxResponse());
  });

  it.each([
    ['PayCtxConfigError', () => new PayCtxConfigError('operator secret missing')],
    ['PayCtxReconcileError', () => new PayCtxReconcileError('amount/asset mismatch')],
    [
      'PayoutSubmitError',
      () => new PayoutSubmitError('transient_horizon', 'horizon 504', { transaction: 'tx_failed' }),
    ],
    ['a generic Error', () => new Error('unexpected pay-ctx blowup')],
  ])('payCtxOrder throwing %s → order failed, NEVER fulfilled', async (_label, makeErr) => {
    payCtxOrderMock.mockRejectedValue(makeErr());
    const outcome = await procureOne(fakeOrder());
    expect(outcome).toBe('failed');
    expect(markFailed).toHaveBeenCalledWith('order-1', expect.any(String));
    // The invariant: a pay-ctx failure must not fulfil the order.
    expect(markFulfilled).not.toHaveBeenCalled();
    // And it's a failure, not a transient defer.
    expect(revertToPaid).not.toHaveBeenCalled();
  });

  it('missing paymentUrls in the CTX response → failed, never fulfilled (no pay-ctx call)', async () => {
    operatorFetchMock.mockResolvedValue(noPaymentUrlsCtxResponse());
    const outcome = await procureOne(fakeOrder());
    expect(outcome).toBe('failed');
    expect(markFailed).toHaveBeenCalledWith('order-1', expect.stringContaining('paymentUrls'));
    expect(payCtxOrderMock).not.toHaveBeenCalled();
    expect(markFulfilled).not.toHaveBeenCalled();
  });

  it('paymentUrls entry that fails SEP-7 parse → failed, never fulfilled (no pay-ctx call)', async () => {
    operatorFetchMock.mockResolvedValue(badSep7CtxResponse());
    const outcome = await procureOne(fakeOrder());
    expect(outcome).toBe('failed');
    expect(markFailed).toHaveBeenCalledWith('order-1', expect.stringContaining('SEP-7'));
    expect(payCtxOrderMock).not.toHaveBeenCalled();
    expect(markFulfilled).not.toHaveBeenCalled();
  });

  it('sanity: payCtxOrder SUCCEEDING does fulfil — proves the guard tests are not vacuous', async () => {
    payCtxOrderMock.mockResolvedValue({ txHash: 'abc123', submitted: true });
    const outcome = await procureOne(fakeOrder());
    expect(outcome).toBe('fulfilled');
    expect(markFulfilled).toHaveBeenCalledWith(
      'order-1',
      expect.objectContaining({ ctxOrderId: 'ctx-order-1' }),
    );
    expect(markFailed).not.toHaveBeenCalled();
  });
});
