import { describe, it, expect } from 'vitest';
import { isUniqueViolation, UniqueViolationError } from '../errors.js';

// AUDIT-2 D: typed error prevents message-sniffing false positives
describe('isUniqueViolation', () => {
  it('recognizes a UniqueViolationError thrown by a driver', () => {
    const err = new UniqueViolationError('orders', ['userId', 'idempotencyKey']);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('exposes the violated collection and unique-tuple fields for diagnostics', () => {
    const err = new UniqueViolationError('user_identities', ['provider', 'providerSub']);
    expect(err.collection).toBe('user_identities');
    expect(err.fields).toEqual(['provider', 'providerSub']);
    expect(err.message).toContain('user_identities');
    expect(err.message).toContain('provider, providerSub');
    expect(err.name).toBe('UniqueViolationError');
  });

  it('does NOT match a plain Error, even one whose message mimics the unique-violation text', () => {
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
