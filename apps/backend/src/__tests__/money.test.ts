import { describe, it, expect } from 'vitest';
import { formatMinorAmount } from '@loop/shared';

/**
 * The formatter is platform-agnostic and ships in `@loop/shared/money`.
 * Tested from the backend test suite (which has vitest wired up)
 * rather than building a new test harness in the shared package —
 * mirrors how `slugs.ts` and `search.ts` are tested.
 *
 * These assertions intentionally don't pin exact locale-specific
 * output ("$5.00" could be "US$5.00" under some locales); they match
 * the shape of the output. CI runs with a consistent locale so the
 * exact output is stable too, but the pattern matches are robust
 * across developer machines.
 */
describe('formatMinorAmount', () => {
  it('formats a positive minor-unit bigint-string into the currency', () => {
    expect(formatMinorAmount('250', 'USD')).toMatch(/(?:US)?\$2\.50/);
  });

  it('accepts raw bigint input', () => {
    expect(formatMinorAmount(250n, 'USD')).toMatch(/(?:US)?\$2\.50/);
  });

  it('accepts plain number input', () => {
    expect(formatMinorAmount(250, 'USD')).toMatch(/(?:US)?\$2\.50/);
  });

  it('formats zero as zero — no dash fallback for the legitimate 0 case', () => {
    expect(formatMinorAmount('0', 'USD')).toMatch(/(?:US)?\$0\.00/);
  });

  it('formats negative amounts with a leading minus', () => {
    expect(formatMinorAmount('-150', 'USD')).toMatch(/-(?:US)?\$1\.50|\((?:US)?\$1\.50\)/);
  });

  it('signed=true adds a + prefix on positive amounts', () => {
    expect(formatMinorAmount('100', 'USD', { signed: true })).toMatch(/\+(?:US)?\$1\.00/);
  });

  it('signed=true preserves the minus on negatives', () => {
    expect(formatMinorAmount('-100', 'USD', { signed: true })).toMatch(
      /-(?:US)?\$1\.00|\((?:US)?\$1\.00\)/,
    );
  });

  it('respects the currency code — GBP produces a £ symbol', () => {
    expect(formatMinorAmount('250', 'GBP')).toMatch(/£2\.50/);
  });

  it('respects the currency code — EUR produces a € symbol', () => {
    expect(formatMinorAmount('250', 'EUR')).toMatch(/€2\.50/);
  });

  it('returns the "—" fallback on an unparseable amount string', () => {
    expect(formatMinorAmount('not-a-number', 'USD')).toBe('—');
  });

  it('returns the "—" fallback on an invalid currency code', () => {
    // Intl.NumberFormat throws RangeError on unknown currency codes;
    // the helper swallows it and returns the fallback.
    expect(formatMinorAmount('100', 'NOTACURRENCY')).toBe('—');
  });

  it('handles very large amounts (beyond Number safe-integer range) without throwing', () => {
    // 1e20 cents — well beyond 2**53. We accept some precision loss
    // for display (Intl takes a Number) but must not throw.
    const out = formatMinorAmount('100000000000000000000', 'USD');
    expect(out).not.toBe('—');
  });
});
