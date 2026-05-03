/**
 * Idempotency helpers for the order repository (A2-2003).
 *
 * Lifted out of `apps/backend/src/orders/repo.ts` so the
 * idempotency primitives — error type, lookup, post-insert
 * conflict resolver — live in their own focused module separate
 * from `createOrder` and the cashback-split pinning in the
 * parent file:
 *
 *   - `IdempotentOrderConflictError` — thrown by `createOrder`
 *     when the (userId, idempotencyKey) pair already exists.
 *     Carries the prior order so the caller can build a replay
 *     response without a second SELECT round-trip.
 *   - `findOrderByIdempotencyKey(userId, key)` — pre-write
 *     lookup the handler does to short-circuit a repeat request
 *     without holding any locks.
 *   - `maybeFetchIdempotentConflict(args, err)` — post-insert
 *     conflict resolver. Recognises the partial-unique-index
 *     violation, fetches the prior row, returns null on any
 *     other shape of failure so the original exception bubbles.
 *
 * Re-exported from `repo.ts` so the existing import paths used
 * by `loop-handler.ts` and the test suite keep resolving
 * unchanged.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import type { Order, CreateOrderArgs } from './repo.js';

/**
 * A2-2003: thrown by `createOrder` when the (userId, idempotencyKey)
 * pair already exists. Carries the prior order so the caller can
 * build a replay response without a second SELECT round-trip — the
 * row was returned by the same SQL roundtrip that detected the
 * violation, courtesy of the post-insert lookup in the catch arm.
 */
export class IdempotentOrderConflictError extends Error {
  readonly existing: Order;
  constructor(existing: Order) {
    super('Idempotency-Key already maps to a different order for this user');
    this.name = 'IdempotentOrderConflictError';
    this.existing = existing;
  }
}

/**
 * A2-2003: lookup the prior order for a given (userId, idempotencyKey)
 * pair. Returns null on miss. Called by the handler before the write
 * so a repeat request short-circuits without holding any locks; the
 * unique-index race is caught by `IdempotentOrderConflictError` from
 * the insert path.
 */
export async function findOrderByIdempotencyKey(
  userId: string,
  idempotencyKey: string,
): Promise<Order | null> {
  const row = await db.query.orders.findFirst({
    where: and(eq(orders.userId, userId), eq(orders.idempotencyKey, idempotencyKey)),
  });
  return row ?? null;
}

/**
 * Inspects an INSERT failure for the (user_id, idempotency_key)
 * partial-unique-index violation that the A2-2003 race produces:
 *
 *   - the caller passed an `idempotencyKey`, and
 *   - the error walks back to a postgres-js `PostgresError` with
 *     `code='23505'` (unique_violation) and `constraint_name`
 *     equal to `orders_user_idempotency_unique`.
 *
 * **A4-026:** the prior implementation matched on
 * `err.message.includes('orders_user_idempotency_unique')`. Drizzle
 * wraps the raw `PostgresError` in a `DrizzleQueryError`, and the
 * wrapper format isn't part of either library's stable contract —
 * a Drizzle / postgres-js upgrade that changed the wrapper's
 * `.toString()` output would silently turn a duplicate-Idempotency-
 * Key conflict into a 500 + a stranded order row + (for credit
 * orders) a stranded debit. Walk the cause chain for the SQLSTATE +
 * constraint_name, matching the pattern used by
 * `credits/refunds.ts:isDuplicateRefund` and
 * `credits/withdrawals.ts:isDuplicateWithdrawal`.
 *
 * Re-fetches the prior order so the caller can build the replay
 * response. Returns null when the failure was something else
 * (CHECK violation, FK violation, connection error) — the original
 * exception bubbles unchanged.
 */
export async function maybeFetchIdempotentConflict(
  args: CreateOrderArgs,
  err: unknown,
): Promise<Order | null> {
  if (args.idempotencyKey === undefined) return null;
  if (!isOrderIdempotencyConflict(err)) return null;
  return await findOrderByIdempotencyKey(args.userId, args.idempotencyKey);
}

/**
 * A4-026: walks the cause chain (Drizzle's `DrizzleQueryError` wraps
 * postgres-js's `PostgresError`) for the
 * `orders_user_idempotency_unique` partial-unique-index violation.
 * Cap the walk depth at 4 to bound the cost on a non-matching error.
 */
function isOrderIdempotencyConflict(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur instanceof Error; depth++) {
    const e = cur as Error & { code?: string; constraint_name?: string };
    if (e.code === '23505' && e.constraint_name === 'orders_user_idempotency_unique') {
      return true;
    }
    cur = (e as { cause?: unknown }).cause;
  }
  return false;
}
