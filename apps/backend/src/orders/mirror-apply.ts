/**
 * Mirror application — shared by the giftcard ws maintainer (event
 * push) and the ctx mirror sweep (poll reconcile), so both paths
 * resolve + apply a CTX card identically (ADR 052).
 *
 * Resolution keys `operatorReference` (the Loop order row id) first,
 * `ctx_order_id` as fallback; unknown cards are ignored — the
 * company-wide feed can carry non-Loop-originated cards.
 */
import { logger } from '../logger.js';
import { notifyOrderFulfilled } from '../discord.js';
import { mapCtxDisplayStatus, type CtxGiftCard } from './ctx-order.js';
import { getOrderByCtxOrderId, getOrderById, recordCtxCreate, type Order } from './repo.js';
import {
  markOrderFulfilled,
  markOrderPaid,
  markOrderRefunded,
  markOrderRejected,
} from './transitions.js';
import { fetchRedemption } from './procurement-redemption.js';

const log = logger.child({ area: 'order-mirror' });

export async function resolveOrderForCard(card: CtxGiftCard): Promise<Order | null> {
  if (card.operatorReference !== undefined && card.operatorReference.length > 0) {
    const byRef = await getOrderById(card.operatorReference).catch(() => null);
    if (byRef !== null && byRef.ctxOrderId === card.id) return byRef;
    if (byRef !== null && byRef.ctxOrderId === null) {
      await recordCtxCreate(byRef.id, {
        ctxOrderId: card.id,
        ctxPaymentId: card.paymentId ?? null,
        chargeMinor: null,
        chargeCurrency: null,
      });
      return { ...byRef, ctxOrderId: card.id };
    }
  }
  return getOrderByCtxOrderId(card.id);
}

/**
 * Applies a CTX card's `displayStatus` onto its mirror row. The
 * transitions module's state guards make this idempotent + safe under
 * concurrent ws/sweep delivery. On `fulfilled`, does one
 * authoritative redemption fetch (payloads on the ws never carry
 * secrets); a fetch failure still fulfils the row — the redemption
 * backfill retries the payload.
 */
export async function applyCtxCardStatus(order: Order, card: CtxGiftCard): Promise<void> {
  const displayStatus = card.displayStatus !== undefined ? card.displayStatus : '';
  const mapped = mapCtxDisplayStatus(displayStatus);
  if (mapped === null) {
    log.warn({ orderId: order.id, displayStatus }, 'Unknown CTX displayStatus — ignoring');
    return;
  }

  switch (mapped) {
    case 'unpaid':
      return;
    case 'paid': {
      const updated = await markOrderPaid(order.id);
      if (updated !== null) log.info({ orderId: order.id }, 'Order mirror → paid');
      return;
    }
    case 'fulfilled': {
      let redemption = null;
      try {
        redemption = await fetchRedemption(card.id);
      } catch (err) {
        log.warn(
          { orderId: order.id, err },
          'Redemption fetch failed on fulfil — backfill retries',
        );
      }
      const updated = await markOrderFulfilled(order.id, {
        ...(redemption !== null ? { redemption } : {}),
      });
      if (updated !== null) {
        log.info({ orderId: order.id }, 'Order mirror → fulfilled');
        notifyOrderFulfilled({
          orderId: order.id,
          merchantId: order.merchantId,
          faceValueMinor: BigInt(order.faceValueMinor),
          currency: order.currency,
        });
      }
      return;
    }
    case 'rejected': {
      const updated = await markOrderRejected(order.id, 'rejected by supplier');
      if (updated !== null) log.info({ orderId: order.id }, 'Order mirror → rejected');
      return;
    }
    case 'refunded': {
      const updated = await markOrderRefunded(order.id);
      if (updated !== null) log.info({ orderId: order.id }, 'Order mirror → refunded');
      return;
    }
  }
}
