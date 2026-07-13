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
    LOOP_CTX_PAYMENT_MAX_BPS_OF_EXPECTED: 12_500,
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
// procure-one's R3-5 retry guard reads the settlement repo directly;
// stub it (null → first attempt, band applies) so no real DB loads.
vi.mock('../ctx-settlements.js', () => ({
  getCtxSettlementByOrderId: vi.fn(async () => null),
  getOrCreateCtxSettlement: vi.fn(),
  recordCtxSettlementTxHash: vi.fn(),
  markCtxSettlementConfirmed: vi.fn(),
  backfillCtxSettlementFromChain: vi.fn(),
}));

// Everything else procureOne references — stubbed so the module loads.
const { notifyOrderFailedAfterCtxPaidMock, notifyCashbackCreditedMock } = vi.hoisted(() => ({
  notifyOrderFailedAfterCtxPaidMock: vi.fn(),
  notifyCashbackCreditedMock: vi.fn(),
}));
vi.mock('../../discord.js', () => ({
  notifyCashbackCredited: notifyCashbackCreditedMock,
  notifyCtxSchemaDrift: vi.fn(),
  notifyUsdcBelowFloor: vi.fn(),
  notifyOrderFailedAfterCtxPaid: notifyOrderFailedAfterCtxPaidMock,
}));

vi.mock('../../payments/price-feed.js', () => ({
  requiredStroopsForCharge: vi.fn(async (chargeMinor: bigint) => chargeMinor * 1_000_000n),
}));

// CF-20: the auto-refund seam. Keep the REAL error classes so
// `instanceof` in procureOne matches; only `applyOrderAutoRefund` is
// the spy we drive.
const { applyOrderAutoRefundMock } = vi.hoisted(() => ({ applyOrderAutoRefundMock: vi.fn() }));
vi.mock('../../credits/refunds.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, applyOrderAutoRefund: applyOrderAutoRefundMock };
});

vi.mock('../../merchants/sync.js', () => ({
  getMerchants: () => ({ merchantsById: new Map() }),
}));
const { waitForRedemptionMock } = vi.hoisted(() => ({
  waitForRedemptionMock: vi.fn(async () => ({ code: null, pin: null, url: null })),
}));
vi.mock('../procurement-redemption.js', () => ({
  waitForRedemption: waitForRedemptionMock,
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
import { RefundAlreadyIssuedError, RefundOrderInvalidError } from '../../credits/refunds.js';

function fakeOrder(): Order {
  return {
    id: 'order-1',
    merchantId: 'amazon',
    currency: 'USD',
    faceValueMinor: 1000n,
    // CF-20: the auto-refund reads these off the order row.
    userId: 'user-1',
    chargeMinor: 1000n,
    chargeCurrency: 'USD',
    wholesaleMinor: 1000n,
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
  applyOrderAutoRefundMock.mockReset();
  notifyOrderFailedAfterCtxPaidMock.mockReset();
  waitForRedemptionMock.mockReset();
  // Claim succeeds — return the order row so procureOne proceeds.
  markProcuring.mockResolvedValue(fakeOrder());
  revertToPaid.mockResolvedValue(fakeOrder());
  // Default: redemption wait resolves with an empty payload.
  waitForRedemptionMock.mockResolvedValue({ code: null, pin: null, url: null });
  // Default: auto-refund resolves successfully.
  applyOrderAutoRefundMock.mockResolvedValue({
    id: 'refund-1',
    userId: 'user-1',
    currency: 'USD',
    amountMinor: 1000n,
    orderId: 'order-1',
    newBalanceMinor: 1000n,
    priorBalanceMinor: 0n,
    createdAt: new Date(),
  });
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

  // FT-03 / MNY-15 (money finding): a terminal pay-ctx failure of an
  // already-PAID order must NOT strand the user. Before FT-03 these three
  // kinds marked the order `failed` and returned WITHOUT refunding or
  // paging — the user paid Loop, got no gift card, no refund, no alert
  // (funds stranded). The prior test here LOCKED IN that buggy posture
  // ("none of them auto-refund"); FT-03 supersedes it. Every terminal
  // failure of a paid order now refunds the user AND pages ops. The
  // `ctxPaid` flag differs per kind: config/terminal-submit never paid
  // CTX (false); a reconcile mismatch may mean a prior on-chain payment
  // exists, so ops is told to reconcile the possible operator-side debt
  // (true).
  it.each([
    ['PayCtxConfigError', () => new PayCtxConfigError('operator secret missing'), false],
    ['PayCtxReconcileError', () => new PayCtxReconcileError('amount/asset mismatch'), true],
    [
      'a terminal PayoutSubmitError',
      () => new PayoutSubmitError('terminal_no_trust', 'op_no_trust', { transaction: 'tx_failed' }),
      false,
    ],
  ] as const)(
    'payCtxOrder throwing %s → order failed, user auto-refunded + ops paged, NEVER fulfilled',
    async (_label, makeErr, expectedCtxPaid) => {
      payCtxOrderMock.mockRejectedValue(makeErr());
      const outcome = await procureOne(fakeOrder());
      expect(outcome).toBe('failed');
      expect(markFailed).toHaveBeenCalledWith('order-1', expect.any(String));
      // The invariant: a pay-ctx failure must not fulfil the order.
      expect(markFulfilled).not.toHaveBeenCalled();
      // And it's a failure, not a transient defer.
      expect(revertToPaid).not.toHaveBeenCalled();
      // FT-03: the user (who already paid Loop) is auto-refunded off the
      // order's own charge fields.
      expect(applyOrderAutoRefundMock).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 'order-1', userId: 'user-1', amountMinor: 1000n }),
      );
      // FT-03: ops is paged, with refunded=true and the per-kind ctxPaid.
      expect(notifyOrderFailedAfterCtxPaidMock).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 'order-1', refunded: true, ctxPaid: expectedCtxPaid }),
      );
    },
  );

  // CF2-04 (2026-06-30 cold audit): transient_horizon/transient_rebuild
  // are the retry-safe kinds `payout-submit.ts` documents — Horizon
  // couldn't confirm the tx's fate, not "this payment is genuinely bad".
  // procureOne now reverts procuring→paid for a retry instead of failing
  // the order outright, leaning on payCtxOrder's own idempotency
  // pre-check to make the retry safe against a double-pay. The
  // stranded-order invariant still holds: never fulfilled from here.
  it('payCtxOrder throwing a transient/ambiguous PayoutSubmitError → reverted for retry, NEVER fulfilled', async () => {
    payCtxOrderMock.mockRejectedValue(
      new PayoutSubmitError('transient_horizon', 'horizon 504', { transaction: 'tx_failed' }),
    );
    const outcome = await procureOne(fakeOrder());
    expect(outcome).toBe('skipped');
    expect(revertToPaid).toHaveBeenCalledWith('order-1');
    expect(markFailed).not.toHaveBeenCalled();
    expect(markFulfilled).not.toHaveBeenCalled();
    expect(applyOrderAutoRefundMock).not.toHaveBeenCalled();
  });

  // CF2-05 (2026-06-30 cold audit): the user already paid Loop before
  // procureOne ran, so an unexpected throw from payCtxOrder — even one
  // that isn't a classified PayoutSubmitError — must still auto-refund
  // them. `ctxPaid` is still false here (payCtxOrder never resolved),
  // so the alert reflects "no operator-side CTX debt" rather than the
  // CF-20 post-payment shape.
  it('payCtxOrder throwing a generic Error → order failed, auto-refunded, NEVER fulfilled', async () => {
    payCtxOrderMock.mockRejectedValue(new Error('unexpected pay-ctx blowup'));
    const outcome = await procureOne(fakeOrder());
    expect(outcome).toBe('failed');
    expect(markFailed).toHaveBeenCalledWith('order-1', expect.any(String));
    expect(markFulfilled).not.toHaveBeenCalled();
    expect(revertToPaid).not.toHaveBeenCalled();
    expect(applyOrderAutoRefundMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1' }),
    );
    expect(notifyOrderFailedAfterCtxPaidMock).toHaveBeenCalledWith(
      expect.objectContaining({ ctxPaid: false }),
    );
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
    // CF-20: a successfully-fulfilled order is never refunded.
    expect(applyOrderAutoRefundMock).not.toHaveBeenCalled();
    expect(notifyOrderFailedAfterCtxPaidMock).not.toHaveBeenCalled();
  });
});

/**
 * CF-20 (x-flows F1-1, v-orders P2-02) — auto-refund + operator-debt
 * alert when an order fails AFTER pay-ctx has already paid CTX.
 *
 * Setup for every case: the operator create-call returns a valid SEP-7
 * URI and `payCtxOrder` SUCCEEDS (so `ctxPaid` is set), then a
 * post-payment step (`waitForRedemption`, an unexpected throw) fails.
 * The user must be auto-refunded and ops paged. Contrast the CF-28
 * block above where pay-ctx itself fails (CTX never paid → NO refund).
 */
describe('procureOne — CF-20 refund after CTX paid', () => {
  beforeEach(() => {
    operatorFetchMock.mockResolvedValue(okCtxResponse());
    payCtxOrderMock.mockResolvedValue({ txHash: 'ctx-pay-tx', submitted: true });
  });

  it('waitForRedemption throws after pay-ctx → order failed, user auto-refunded, ops paged', async () => {
    waitForRedemptionMock.mockRejectedValue(new Error('CTX terminal status: rejected'));
    const outcome = await procureOne(fakeOrder());
    expect(outcome).toBe('failed');
    expect(markFailed).toHaveBeenCalledWith('order-1', expect.stringContaining('rejected'));
    expect(markFulfilled).not.toHaveBeenCalled();
    // The refund is derived from the order's own charge fields.
    expect(applyOrderAutoRefundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        currency: 'USD',
        amountMinor: 1000n,
        orderId: 'order-1',
      }),
    );
    expect(notifyOrderFailedAfterCtxPaidMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-1',
        ctxOrderId: 'ctx-order-1',
        userId: 'user-1',
        refunded: true,
      }),
    );
  });

  it('a generic throw after pay-ctx → user auto-refunded, ops paged', async () => {
    // markOrderFulfilled throwing is a post-pay-ctx failure.
    markFulfilled.mockRejectedValue(new Error('db blew up after pay-ctx'));
    const outcome = await procureOne(fakeOrder());
    expect(outcome).toBe('failed');
    expect(applyOrderAutoRefundMock).toHaveBeenCalledTimes(1);
    expect(notifyOrderFailedAfterCtxPaidMock).toHaveBeenCalledWith(
      expect.objectContaining({ refunded: true }),
    );
  });

  it('refund already issued → still treated as refunded, ops still paged', async () => {
    waitForRedemptionMock.mockRejectedValue(new Error('CTX terminal status: failed'));
    applyOrderAutoRefundMock.mockRejectedValue(new RefundAlreadyIssuedError('order-1'));
    const outcome = await procureOne(fakeOrder());
    expect(outcome).toBe('failed');
    expect(notifyOrderFailedAfterCtxPaidMock).toHaveBeenCalledWith(
      expect.objectContaining({ refunded: true }),
    );
  });

  it('auto-refund itself failing → ops paged with refunded=false (worst case)', async () => {
    waitForRedemptionMock.mockRejectedValue(new Error('CTX terminal status: failed'));
    applyOrderAutoRefundMock.mockRejectedValue(new Error('compensation cap hit'));
    const outcome = await procureOne(fakeOrder());
    // The order is still terminally failed; the refund blip must not
    // re-throw out of procureOne.
    expect(outcome).toBe('failed');
    expect(notifyOrderFailedAfterCtxPaidMock).toHaveBeenCalledWith(
      expect.objectContaining({ refunded: false }),
    );
  });

  it('RefundOrderInvalidError → ops paged with refunded=false', async () => {
    waitForRedemptionMock.mockRejectedValue(new Error('CTX terminal status: error'));
    applyOrderAutoRefundMock.mockRejectedValue(
      new RefundOrderInvalidError('order_not_found', 'gone'),
    );
    const outcome = await procureOne(fakeOrder());
    expect(outcome).toBe('failed');
    expect(notifyOrderFailedAfterCtxPaidMock).toHaveBeenCalledWith(
      expect.objectContaining({ refunded: false }),
    );
  });
});
