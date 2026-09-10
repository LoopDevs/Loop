// Idempotency helpers for the order repository — A2-2003
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import type { Order } from './repo.js';

export class IdempotentOrderConflictError extends Error {
  readonly existing: Order;
  constructor(existing: Order) {
    super('Idempotency-Key already maps to a different order for this user');
    this.name = 'IdempotentOrderConflictError';
    this.existing = existing;
  }
}

export async function findOrderByIdempotencyKey(
  userId: string,
  idempotencyKey: string,
): Promise<Order | null> {
  return db.collection('orders').findOne({ userId, idempotencyKey });
}

export async function maybeFetchIdempotentConflict(
  args: { userId: string; idempotencyKey?: string },
  err: unknown,
): Promise<Order | null> {
  if (args.idempotencyKey === undefined) return null;
  if (!isUniqueViolation(err)) return null;
  return findOrderByIdempotencyKey(args.userId, args.idempotencyKey);
}
