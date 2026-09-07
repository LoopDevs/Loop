/**
 * Loop-order repository (ADR 052).
 *
 * Owns writes against the `orders` collection — a local mirror of a
 * CTX gift card plus Loop's commission log for it. The create handler
 * inserts the doc first (its uuid becomes the CTX
 * `operatorReference`), calls CTX, then records the CTX identifiers;
 * everything downstream (ws maintainer, mirror sweep) keys on either
 * the doc id or `ctxOrderId`.
 *
 * Money fields are integer minor units held as `number` in the store;
 * the create-path arguments still accept `bigint` (the zod layer
 * coerces to bigint) and are narrowed here at the boundary.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import type { OrderDoc } from '../db/types.js';

export type Order = OrderDoc;

// A2-2003 idempotency primitives (error type + pre-write lookup +
// post-insert conflict resolver) live in `./repo-idempotency.ts`.
// Re-exported here so the existing import paths used by
// loop-handler.ts and the test suite keep resolving.
import {
  IdempotentOrderConflictError,
  findOrderByIdempotencyKey,
  maybeFetchIdempotentConflict,
} from './repo-idempotency.js';
export { IdempotentOrderConflictError, findOrderByIdempotencyKey };

export interface CreateOrderArgs {
  userId: string;
  merchantId: string;
  faceValueMinor: bigint;
  currency: string;
  /** Chain-qualified CTX payment currency the customer chose. */
  paymentCryptoCurrency: string;
  /**
   * A2-2003: optional client-supplied idempotency key. When set, the
   * doc carries it and the (userId, idempotencyKey) unique spec
   * rejects a second insert with the same pair. The handler converts
   * that violation into a replay of the already-created order's
   * response.
   */
  idempotencyKey?: string;
}

/**
 * Writes a new mirror doc in `unpaid` with the charge provisionally
 * pinned to the face value — the CTX create + operator read-back
 * then overwrite `chargeMinor` / `userCashbackMinor` /
 * `expectedCommissionMinor` with CTX's actual numbers via
 * {@link recordCtxCreate} + {@link recordOrderEconomics}.
 */
export async function createOrder(args: CreateOrderArgs): Promise<Order> {
  const doc: OrderDoc = {
    id: randomUUID(),
    userId: args.userId,
    merchantId: args.merchantId,
    faceValueMinor: Number(args.faceValueMinor),
    currency: args.currency,
    chargeMinor: Number(args.faceValueMinor),
    chargeCurrency: args.currency,
    userCashbackMinor: 0,
    expectedCommissionMinor: null,
    ctxOrderId: null,
    ctxPaymentId: null,
    paymentCryptoCurrency: args.paymentCryptoCurrency,
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    redemptionBackfillAttempts: 0,
    redemptionBackfillLastAttemptAt: null,
    state: 'unpaid',
    failureReason: null,
    idempotencyKey: args.idempotencyKey ?? null,
    createdAt: new Date(),
    fulfilledAt: null,
    failedAt: null,
  };
  try {
    await db.collection('orders').insertOne(doc);
    return doc;
  } catch (err) {
    const conflict = await maybeFetchIdempotentConflict(
      {
        userId: args.userId,
        ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
      },
      err,
    );
    if (conflict !== null) throw new IdempotentOrderConflictError(conflict);
    throw err;
  }
}

/** Records the CTX identifiers returned by the gift-card create. */
export async function recordCtxCreate(
  orderId: string,
  fields: {
    ctxOrderId: string;
    ctxPaymentId: string | null;
    chargeMinor: bigint | null;
    chargeCurrency: string | null;
  },
): Promise<void> {
  await db.collection('orders').updateOne(
    { id: orderId },
    {
      $set: {
        ctxOrderId: fields.ctxOrderId,
        ...(fields.ctxPaymentId !== null ? { ctxPaymentId: fields.ctxPaymentId } : {}),
        ...(fields.chargeMinor !== null ? { chargeMinor: Number(fields.chargeMinor) } : {}),
        ...(fields.chargeCurrency !== null ? { chargeCurrency: fields.chargeCurrency } : {}),
      },
    },
  );
}

/**
 * Records the per-order economics from the operator read-back. Only
 * non-null values are written — a failed read-back leaves the doc
 * for the mirror sweep to retry, never zeroes it.
 */
export async function recordOrderEconomics(
  orderId: string,
  fields: { userCashbackMinor: bigint | null; expectedCommissionMinor: bigint | null },
): Promise<void> {
  const set: Partial<OrderDoc> = {};
  if (fields.userCashbackMinor !== null) set.userCashbackMinor = Number(fields.userCashbackMinor);
  if (fields.expectedCommissionMinor !== null) {
    set.expectedCommissionMinor = Number(fields.expectedCommissionMinor);
  }
  if (Object.keys(set).length === 0) return;
  await db.collection('orders').updateOne({ id: orderId }, { $set: set });
}

export async function getOrderById(orderId: string): Promise<Order | null> {
  return db.collection('orders').findOne({ id: orderId });
}

/** Mirror lookup for giftcard ws events — keyed on the CTX card id. */
export async function getOrderByCtxOrderId(ctxOrderId: string): Promise<Order | null> {
  return db.collection('orders').findOne({ ctxOrderId });
}

/**
 * Non-terminal docs for the mirror sweep, oldest-first. `unpaid`
 * docs are polled for payment expiry + missed paid events; `paid`
 * docs for missed fulfilment events.
 */
export async function listOpenMirrorOrders(limit: number): Promise<Order[]> {
  return db
    .collection('orders')
    .findMany({ state: { $in: ['unpaid', 'paid'] } }, { sort: [['createdAt', 'asc']], limit });
}

export async function findOwnedOrder(userId: string, orderId: string): Promise<Order | null> {
  return db.collection('orders').findOne({ id: orderId, userId });
}
