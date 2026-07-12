import { describe, it, expect } from 'vitest';
import { formatCashbackPct } from '../format-cashback';

describe('formatCashbackPct', () => {
  it('drops a trailing .0 for whole-integer rates', () => {
    expect(formatCashbackPct('5.00')).toBe('5');
  });

  it('keeps precision for partial rates', () => {
    expect(formatCashbackPct('2.50')).toBe('2.5');
  });

  it('rounds to one decimal place (1.25 → "1.3")', () => {
    expect(formatCashbackPct('1.25')).toBe('1.3');
  });

  it('returns null for null / undefined (no rate)', () => {
    expect(formatCashbackPct(null)).toBeNull();
    expect(formatCashbackPct(undefined)).toBeNull();
  });

  it('returns null for zero / negative rates', () => {
    expect(formatCashbackPct('0')).toBeNull();
    expect(formatCashbackPct('0.00')).toBeNull();
    expect(formatCashbackPct('-1.5')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(formatCashbackPct('garbage')).toBeNull();
  });
});
