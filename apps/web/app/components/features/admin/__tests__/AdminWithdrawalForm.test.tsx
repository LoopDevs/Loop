import { describe, it, expect } from 'vitest';
import { parseUnsignedAmountMajor } from '../AdminWithdrawalForm';

describe('parseUnsignedAmountMajor', () => {
  it('parses a whole number as positive minor units', () => {
    expect(parseUnsignedAmountMajor('100')?.minorString).toBe('10000');
  });

  it('pads a single decimal to two places', () => {
    expect(parseUnsignedAmountMajor('3.1')?.minorString).toBe('310');
  });

  it('parses two decimals exactly', () => {
    expect(parseUnsignedAmountMajor('12.34')?.minorString).toBe('1234');
  });

  it('rejects signed input — withdrawals are always positive', () => {
    expect(parseUnsignedAmountMajor('+12.34')).toBeNull();
    expect(parseUnsignedAmountMajor('-50')).toBeNull();
  });

  it('rejects more than 2 decimals', () => {
    expect(parseUnsignedAmountMajor('1.234')).toBeNull();
  });

  it('rejects zero', () => {
    expect(parseUnsignedAmountMajor('0')).toBeNull();
    expect(parseUnsignedAmountMajor('0.00')).toBeNull();
  });

  it('rejects empty / whitespace-only', () => {
    expect(parseUnsignedAmountMajor('')).toBeNull();
    expect(parseUnsignedAmountMajor('   ')).toBeNull();
  });

  it('rejects letters / symbols', () => {
    expect(parseUnsignedAmountMajor('abc')).toBeNull();
    expect(parseUnsignedAmountMajor('$12')).toBeNull();
    expect(parseUnsignedAmountMajor('1,000')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(parseUnsignedAmountMajor('  12.34  ')?.minorString).toBe('1234');
  });
});
