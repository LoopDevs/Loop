import { describe, it, expect } from 'vitest';
import { fmtStroops } from '../format-stellar';

describe('fmtStroops', () => {
  it('formats stroops with trailing-zero trim', () => {
    expect(fmtStroops('12500000', 'GBPLOOP')).toBe('1.25 GBPLOOP');
  });

  it('drops the fraction entirely for whole amounts', () => {
    expect(fmtStroops('10000000', 'USDLOOP')).toBe('1 USDLOOP');
  });

  it('handles sub-unit amounts (leading-zero pad)', () => {
    expect(fmtStroops('1', 'XLM')).toBe('0.0000001 XLM');
  });

  it('formats negative amounts with a sign', () => {
    expect(fmtStroops('-12500000', 'EURLOOP')).toBe('-1.25 EURLOOP');
  });

  it('groups thousands with the pinned admin locale', () => {
    expect(fmtStroops('12345678900000000', 'XLM')).toBe('1,234,567,890 XLM');
  });

  it('renders an em-dash for null (missing snapshot field)', () => {
    expect(fmtStroops(null, 'USDC')).toBe('—');
  });

  it('renders an em-dash for non-numeric input', () => {
    expect(fmtStroops('garbage', 'GBPLOOP')).toBe('—');
  });
});
