import { describe, it, expect } from 'vitest';
import { isUniqueViolation, UniqueViolationError } from '../errors.js';

/**
 * The document store surfaces every unique-spec collision — from either
 * driver — as a single typed `UniqueViolationError` (the Mongo driver
 * translates the server's E11000 into it; the memory driver throws it
 * directly from its insert scan). Callers that treat "already inserted"
 * as a benign race (order idempotency, the social id-token replay
 * guard) therefore check exactly one shape via `isUniqueViolation`.
 *
 * The history here matters: the Drizzle-era helper walked `.cause`
 * chains sniffing Postgres `code`/`constraint_name` fields, and AUDIT-2
 * finding D showed how easily a message-substring check gave false
 * confidence. The typed-error design removes that whole class of bug —
 * these tests pin that ONLY the typed error matches, never a lookalike
 * built from strings or duck-typed fields.
 */
describe('isUniqueViolation', () => {
  it('recognizes a UniqueViolationError thrown by a driver', () => {
    const err = new UniqueViolationError('orders', ['userId', 'idempotencyKey']);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('exposes the violated collection and unique-tuple fields for diagnostics', () => {
    const err = new UniqueViolationError('user_identities', ['provider', 'providerSub']);
    expect(err.collection).toBe('user_identities');
    expect(err.fields).toEqual(['provider', 'providerSub']);
    // The message carries both so a bare `throw` in a log is actionable.
    expect(err.message).toContain('user_identities');
    expect(err.message).toContain('provider, providerSub');
    expect(err.name).toBe('UniqueViolationError');
  });

  it('does NOT match a plain Error, even one whose message mimics the unique-violation text', () => {
    // Message-sniffing is exactly the anti-pattern the typed error
    // replaced — a lookalike string must never be treated as benign.
    const err = new Error('unique violation on orders (userId, idempotencyKey)');
    expect(isUniqueViolation(err)).toBe(false);
  });

  it('does NOT match a duck-typed object carrying the same fields without the class', () => {
    const fake = {
      name: 'UniqueViolationError',
      collection: 'orders',
      fields: ['id'],
      message: 'unique violation on orders (id)',
    };
    expect(isUniqueViolation(fake)).toBe(false);
  });

  it('handles non-Error thrown values without throwing', () => {
    expect(isUniqueViolation('a plain string error')).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(42)).toBe(false);
  });
});
