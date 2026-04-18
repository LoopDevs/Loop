import { describe, it, expect } from 'vitest';
import { formatMoney } from '../money';

describe('formatMoney', () => {
  it('formats USD with the ISO code, not a hardcoded dollar sign', () => {
    // Locale-dependent but for any reasonable locale includes "USD" + "25.00".
    const out = formatMoney(25, 'USD');
    expect(out).toContain('USD');
    expect(out).toContain('25.00');
  });

  it('formats non-USD currencies correctly (regression for A-029)', () => {
    // The old orders.tsx rendered "$25.00 EUR"; the new formatter must not.
    const out = formatMoney(25, 'EUR');
    expect(out).toContain('EUR');
    expect(out).not.toMatch(/^\$/);
  });

  it('formats penny-precision amounts', () => {
    const out = formatMoney(0.01, 'USD');
    expect(out).toContain('0.01');
  });

  it('falls back to a plain "amount code" rendering for unknown currencies', () => {
    // `Intl.NumberFormat` throws on non-ISO codes. We should render something
    // rather than blowing up the orders page.
    const out = formatMoney(1.5, 'NOTREAL');
    expect(out).toBe('1.50 NOTREAL');
  });
});
