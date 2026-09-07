/**
 * Idempotency helpers for the order repository (A2-2003).
 *
 *   - `IdempotentOrderConflictError` — thrown by `createOrder`
 *     when the (userId, idempotencyKey) pair already exists.
 *     Carries the prior order so the caller can build a replay
 *     response without a second lookup round-trip.
 *   - `findOrderByIdempotencyKey(userId, key)` — pre-write
 *     lookup the handler does to short-circuit a repeat request.
 *   - `maybeFetchIdempotentConflict(args, err)` — post-insert
 *     conflict resolver. Recognises the unique-spec violation,
 *     fetches the prior doc, returns null on any other shape of
 *     failure so the original exception bubbles.
 *
 * Re-exported from `repo.ts` so the existing import paths used
 * by `loop-handler.ts` and the test suite keep resolving.
 */
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import type { Order } from './repo.js';

/**
 * A2-2003: thrown by `createOrder` when the (userId, idempotencyKey)
 * pair already exists. Carries the prior order so the caller can
 * build a replay response without a second lookup.
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
 * so a repeat request short-circuits; the unique-spec race is caught
 * by `IdempotentOrderConflictError` from the insert path.
 */
export async function findOrderByIdempotencyKey(
  userId: string,
  idempotencyKey: string,
): Promise<Order | null> {
  return db.collection('orders').findOne({ userId, idempotencyKey });
}

/**
 * Inspects an insert failure for the (userId, idempotencyKey)
 * unique-spec violation that the A2-2003 race produces. Re-fetches
 * the prior order so the caller can build the replay response.
 * Returns null when the failure was something else — the original
 * exception bubbles unchanged.
 */
export async function maybeFetchIdempotentConflict(
  args: { userId: string; idempotencyKey?: string },
  err: unknown,
): Promise<Order | null> {
  if (args.idempotencyKey === undefined) return null;
  if (!isUniqueViolation(err)) return null;
  return findOrderByIdempotencyKey(args.userId, args.idempotencyKey);
}
