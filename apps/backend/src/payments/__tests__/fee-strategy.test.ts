/**
 * A2-1921 — fee-strategy curve unit tests.
 */
import { describe, it, expect } from 'vitest';
import { feeForAttempt } from '../fee-strategy.js';

const DEFAULTS = { baseFeeStroops: 100, capFeeStroops: 100_000, multiplier: 2 };

describe('feeForAttempt (A2-1921)', () => {
  it('attempt 1 returns the base fee', () => {
    expect(feeForAttempt(1, DEFAULTS)).toBe('100');
  });

  it('exponentially scales by multiplier per attempt', () => {
    expect(feeForAttempt(2, DEFAULTS)).toBe('200');
    expect(feeForAttempt(3, DEFAULTS)).toBe('400');
    expect(feeForAttempt(4, DEFAULTS)).toBe('800');
    expect(feeForAttempt(5, DEFAULTS)).toBe('1600');
  });

  it('caps at capFeeStroops once the curve passes the ceiling', () => {
    // At MULTIPLIER=2 from base=100 the curve hits the 100_000 cap on
    // attempt 11 (100 × 2^10 = 102_400). Anything above that clamps.
    expect(feeForAttempt(20, DEFAULTS)).toBe('100000');
    expect(feeForAttempt(50, DEFAULTS)).toBe('100000');
  });

  it('clamps invalid attempt numbers (≤0) to attempt 1', () => {
    expect(feeForAttempt(0, DEFAULTS)).toBe('100');
    expect(feeForAttempt(-5, DEFAULTS)).toBe('100');
  });

  it('honours custom base / cap / multiplier', () => {
    const opts = { baseFeeStroops: 500, capFeeStroops: 5_000, multiplier: 3 };
    expect(feeForAttempt(1, opts)).toBe('500');
    expect(feeForAttempt(2, opts)).toBe('1500');
    expect(feeForAttempt(3, opts)).toBe('4500');
    // attempt 4 would be 13_500; cap clamps to 5_000.
    expect(feeForAttempt(4, opts)).toBe('5000');
  });

  it('floors fractional fees from non-integer multipliers (Stellar requires int stroops)', () => {
    const opts = { baseFeeStroops: 100, capFeeStroops: 100_000, multiplier: 1.5 };
    // 100 × 1.5^2 = 225
    expect(feeForAttempt(3, opts)).toBe('225');
    // 100 × 1.5^3 = 337.5 → floors to 337
    expect(feeForAttempt(4, opts)).toBe('337');
  });
});
