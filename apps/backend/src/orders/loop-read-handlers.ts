/**
 * Loop order read handlers — `GET /api/orders/loop/:id`
 * + `GET /api/orders/loop` (ADR 052).
 *
 * Two caller-scoped reads over the local mirror:
 *
 *   - `loopGetOrderHandler` — owner-scoped single-order detail.
 *     404 on non-owner reads to avoid leaking existence. For a
 *     still-`unpaid` order, overlays live CTX payment instructions
 *     (operator-scope card + payment reads) so the pay screen is
 *     fully server-rebuildable — nothing payment-directing is ever
 *     trusted from client-persisted storage (Q6-4b lineage).
 *   - `loopListOrdersHandler` — owner-scoped paginated list,
 *     newest-first, `?limit=` clamped 1-100, `?before=<iso>`.
 *
 * Both gate on `LOOP_AUTH_NATIVE_ENABLED` (404 when off) and
 * require an `auth.kind === 'loop'` bearer (401 otherwise).
 */
import type { Context } from 'hono';
import { db } from '../db/client.js';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import type { LoopAuthContext } from '../auth/handler.js';
import type { LoopOrderView, OrderState } from '@loop/shared';
import { decryptRedeemField, RedeemDecryptError } from './redeem-crypto.js';
import {
  fetchCtxCardAsOperator,
  fetchCtxPayment,
  paymentInstructionsFromCard,
} from './ctx-order.js';
import type { Order } from './repo.js';

const log = logger.child({ area: 'loop-order-reads' });

export type { LoopOrderView };

/**
 * CF-25 / X-PRIV-03: decrypt a stored redeem secret for the owner-
 * scoped read. Legacy plaintext rows pass through untouched. A decrypt
 * failure (tampered ciphertext, or the key was rotated away / unset
 * after a row was encrypted) returns null + logs — the order still
 * renders, the field reads as "redemption unavailable", and we never
 * serve a forged/unverifiable code. The order id is safe to log; the
 * code/PIN never is.
 */
function readRedeemField(
  orderId: string,
  field: 'code' | 'pin',
  stored: string | null,
): string | null {
  try {
    return decryptRedeemField(stored);
  } catch (err) {
    if (err instanceof RedeemDecryptError) {
      log.error({ orderId, field }, 'Failed to decrypt redeem field — serving null');
      return null;
    }
    throw err;
  }
}

/**
 * Shapes a DB `orders` row into the BigInt-safe wire view. `payment`
 * starts null — the detail read overlays live CTX instructions for
 * unpaid rows.
 */
export function orderToView(row: Order): LoopOrderView {
  return {
    id: row.id,
    merchantId: row.merchantId,
    state: row.state as OrderState,
    faceValueMinor: row.faceValueMinor.toString(),
    currency: row.currency,
    chargeMinor: row.chargeMinor.toString(),
    chargeCurrency: row.chargeCurrency,
    userCashbackMinor: row.userCashbackMinor.toString(),
    ctxOrderId: row.ctxOrderId,
    paymentCryptoCurrency: row.paymentCryptoCurrency,
    payment: null,
    redeemCode: readRedeemField(row.id, 'code', row.redeemCode),
    redeemPin: readRedeemField(row.id, 'pin', row.redeemPin),
    redeemUrl: row.redeemUrl,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
  };
}

export async function loopGetOrderHandler(c: Context): Promise<Response> {
  if (!config.auth.native.enabled) {
    return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
  }
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined || auth.kind !== 'loop') {
    return c.json({ code: 'UNAUTHORIZED', message: 'Loop-native authentication required' }, 401);
  }
  const id = c.req.param('id');
  if (id === undefined || id.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id is required' }, 400);
  }

  const row = await db.collection('orders').findOne({ id, userId: auth.userId });
  if (row === null) {
    return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
  }

  const view = orderToView(row);

  if (row.state === 'unpaid' && row.ctxOrderId !== null) {
    try {
      const card = await fetchCtxCardAsOperator(row.ctxOrderId);
      const paymentId = card.paymentId ?? row.ctxPaymentId;
      const payment =
        paymentId !== null && paymentId !== undefined ? await fetchCtxPayment(paymentId) : null;
      view.payment = paymentInstructionsFromCard(card, payment, {
        cryptoCurrency: row.paymentCryptoCurrency ?? '',
        amountMinor: BigInt(row.chargeMinor),
        currency: row.chargeCurrency,
      });
    } catch (err) {
      log.warn({ orderId: row.id, err }, 'Live CTX payment read failed — view served without it');
    }
  }

  return c.json(view);
}

export async function loopListOrdersHandler(c: Context): Promise<Response> {
  if (!config.auth.native.enabled) {
    return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
  }
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined || auth.kind !== 'loop') {
    return c.json({ code: 'UNAUTHORIZED', message: 'Loop-native authentication required' }, 401);
  }

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? '50', 10);
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 50 : parsedLimit, 1), 100);
  const before = c.req.query('before');
  const beforeDate = typeof before === 'string' && before.length > 0 ? new Date(before) : null;
  if (beforeDate !== null && Number.isNaN(beforeDate.getTime())) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'before must be an ISO-8601 timestamp' },
      400,
    );
  }

  const rows = await db.collection('orders').findMany(
    {
      userId: auth.userId,
      ...(beforeDate !== null ? { createdAt: { $lt: beforeDate } } : {}),
    },
    { sort: [['createdAt', 'desc']], limit },
  );

  return c.json({ orders: rows.map(orderToView) });
}
