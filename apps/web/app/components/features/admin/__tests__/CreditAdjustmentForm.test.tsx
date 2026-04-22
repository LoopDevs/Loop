import { describe, it, expect } from 'vitest';
import { parseAmountMajor } from '../CreditAdjustmentForm';

describe('parseAmountMajor', () => {
  it('parses an unsigned whole number as positive minor units', () => {
    expect(parseAmountMajor('100')?.minorString).toBe('10000');
  });

  it('parses an explicit leading + as positive', () => {
    expect(parseAmountMajor('+12.34')?.minorString).toBe('1234');
  });

  it('parses a leading - as a signed debit', () => {
    expect(parseAmountMajor('-0.50')?.minorString).toBe('-50');
  });

  it('pads a single decimal to two places', () => {
    expect(parseAmountMajor('3.1')?.minorString).toBe('310');
  });

  it('accepts whole numbers with no decimal', () => {
    expect(parseAmountMajor('-50')?.minorString).toBe('-5000');
  });

  it('rejects more than 2 decimals', () => {
    expect(parseAmountMajor('1.234')).toBeNull();
  });

  it('rejects zero (positive and negative) to match backend non-zero rule', () => {
    expect(parseAmountMajor('0')).toBeNull();
    expect(parseAmountMajor('-0.00')).toBeNull();
    expect(parseAmountMajor('+0')).toBeNull();
  });

  it('rejects empty / whitespace-only', () => {
    expect(parseAmountMajor('')).toBeNull();
    expect(parseAmountMajor('   ')).toBeNull();
  });

  it('rejects letters / symbols', () => {
    expect(parseAmountMajor('abc')).toBeNull();
    expect(parseAmountMajor('$12')).toBeNull();
    expect(parseAmountMajor('1,000')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(parseAmountMajor('  12.34  ')?.minorString).toBe('1234');
  });
});
