/**
 * Loop-order repository (ADR 052).
 *
 * Owns writes against the `orders` table — a local mirror of a CTX
 * gift card plus Loop's commission log for it. The create handler
 * inserts the row first (its uuid becomes the CTX
 * `operatorReference`), calls CTX, then records the CTX identifiers;
 * everything downstream (ws maintainer, mirror sweep) keys on either
 * the row id or `ctx_order_id`.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';

export type Order = typeof orders.$inferSelect;

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
   * row carries it and the (user_id, key) partial unique index in
   * `orders_user_idempotency_unique` rejects a second insert with the
   * same pair. The handler converts that violation into a replay of
   * the already-created order's response.
   */
  idempotencyKey?: string;
}

/**
 * Writes a new mirror row in `unpaid` with the charge provisionally
 * pinned to the face value — the CTX create + operator read-back
 * then overwrite `charge_minor` / `user_cashback_minor` /
 * `expected_commission_minor` with CTX's actual numbers via
 * {@link recordCtxCreate} + {@link recordOrderEconomics}.
 */
export async function createOrder(args: CreateOrderArgs): Promise<Order> {
  const baseValues = {
    userId: args.userId,
    merchantId: args.merchantId,
    faceValueMinor: args.faceValueMinor,
    currency: args.currency,
    chargeMinor: args.faceValueMinor,
    chargeCurrency: args.currency,
    userCashbackMinor: 0n,
    paymentCryptoCurrency: args.paymentCryptoCurrency,
    state: 'unpaid' as const,
    ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
  };
  try {
    const rows = await db.insert(orders).values(baseValues).returning();
    const row = rows[0];
    if (row === undefined) throw new Error('order insert returned no row');
    return row;
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
  await db
    .update(orders)
    .set({
      ctxOrderId: fields.ctxOrderId,
      ...(fields.ctxPaymentId !== null ? { ctxPaymentId: fields.ctxPaymentId } : {}),
      ...(fields.chargeMinor !== null ? { chargeMinor: fields.chargeMinor } : {}),
      ...(fields.chargeCurrency !== null ? { chargeCurrency: fields.chargeCurrency } : {}),
    })
    .where(eq(orders.id, orderId));
}

/**
 * Records the per-order economics from the operator read-back. Only
 * non-null values are written — a failed read-back leaves the row
 * for the mirror sweep to retry, never zeroes it.
 */
export async function recordOrderEconomics(
  orderId: string,
  fields: { userCashbackMinor: bigint | null; expectedCommissionMinor: bigint | null },
): Promise<void> {
  const set: Record<string, bigint> = {};
  if (fields.userCashbackMinor !== null) set['userCashbackMinor'] = fields.userCashbackMinor;
  if (fields.expectedCommissionMinor !== null) {
    set['expectedCommissionMinor'] = fields.expectedCommissionMinor;
  }
  if (Object.keys(set).length === 0) return;
  await db.update(orders).set(set).where(eq(orders.id, orderId));
}

export async function getOrderById(orderId: string): Promise<Order | null> {
  const row = await db.query.orders.findFirst({
    where: eq(orders.id, orderId),
  });
  return row ?? null;
}

/** Mirror lookup for giftcard ws events — keyed on the CTX card id. */
export async function getOrderByCtxOrderId(ctxOrderId: string): Promise<Order | null> {
  const row = await db.query.orders.findFirst({
    where: eq(orders.ctxOrderId, ctxOrderId),
  });
  return row ?? null;
}

/**
 * Non-terminal rows for the mirror sweep, oldest-first. `unpaid`
 * rows are polled for payment expiry + missed paid events; `paid`
 * rows for missed fulfilment events.
 */
export async function listOpenMirrorOrders(limit: number): Promise<Order[]> {
  return db.query.orders.findMany({
    where: inArray(orders.state, ['unpaid', 'paid']),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
    limit,
  });
}

export async function findOwnedOrder(userId: string, orderId: string): Promise<Order | null> {
  const row = await db.query.orders.findFirst({
    where: and(eq(orders.id, orderId), eq(orders.userId, userId)),
  });
  return row ?? null;
}
