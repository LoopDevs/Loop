import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { notifyMock } = vi.hoisted(() => ({ notifyMock: vi.fn() }));
vi.mock('../../discord.js', () => ({
  notifyPriceFeedAnomaly: (args: unknown) => notifyMock(args),
}));

import { isPlausibleRateJump, validateRateJump } from '../rate-sanity.js';

beforeEach(() => {
  notifyMock.mockReset();
});

describe('isPlausibleRateJump', () => {
  it('accepts when there is no previous value (cold start)', () => {
    expect(isPlausibleRateJump(undefined, 999_999, 0.1)).toBe(true);
  });

  it('accepts a rate unchanged from the previous value', () => {
    expect(isPlausibleRateJump(100, 100, 0.5)).toBe(true);
  });

  it('accepts a rate right at the upper bound', () => {
    expect(isPlausibleRateJump(100, 150, 0.5)).toBe(true);
  });

  it('accepts a rate right at the lower bound', () => {
    expect(isPlausibleRateJump(100, 50, 0.5)).toBe(true);
  });

  it('rejects a rate just over the upper bound', () => {
    expect(isPlausibleRateJump(100, 150.01, 0.5)).toBe(false);
  });

  it('rejects a rate just under the lower bound', () => {
    expect(isPlausibleRateJump(100, 49.99, 0.5)).toBe(false);
  });

  it('rejects a rate that has fallen to zero', () => {
    expect(isPlausibleRateJump(100, 0, 0.5)).toBe(false);
  });

  it('a tighter maxRatio rejects a jump a wider one would accept', () => {
    expect(isPlausibleRateJump(100, 108, 0.1)).toBe(true);
    expect(isPlausibleRateJump(100, 112, 0.1)).toBe(false);
  });
});

describe('validateRateJump', () => {
  it('does not throw and does not alert on a plausible jump', () => {
    expect(() =>
      validateRateJump({
        currency: 'USD',
        feed: 'xlm',
        previousValue: 100,
        newValue: 120,
        maxRatio: 0.5,
      }),
    ).not.toThrow();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('does not throw on cold start regardless of the value', () => {
    expect(() =>
      validateRateJump({
        currency: 'USD',
        feed: 'xlm',
        previousValue: undefined,
        newValue: 999_999_999,
        maxRatio: 0.5,
      }),
    ).not.toThrow();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('throws and alerts on an implausible jump', () => {
    expect(() =>
      validateRateJump({
        currency: 'GBP',
        feed: 'fx',
        previousValue: 0.78,
        newValue: 1.5,
        maxRatio: 0.1,
      }),
    ).toThrow(/exceeds sanity bound/);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: 'GBP',
        feed: 'fx',
        previousValue: 0.78,
        newValue: 1.5,
        maxRatio: 0.1,
      }),
    );
  });
});
