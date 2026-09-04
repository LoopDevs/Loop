import { describe, it, expect } from 'vitest';
import {
  loopOrderStateLabel,
  isLoopOrderTerminal,
  isLoopOrderFailure,
  type LoopOrderState,
} from '../orders-loop';

describe('loopOrderStateLabel', () => {
  const cases: Array<[LoopOrderState, RegExp]> = [
    ['unpaid', /payment/i],
    ['paid', /received/i],
    ['fulfilled', /ready/i],
    ['rejected', /rejected/i],
    ['refunded', /refunded/i],
    ['expired', /expired/i],
  ];
  for (const [state, pattern] of cases) {
    it(`labels ${state} with a human-readable string matching ${pattern}`, () => {
      expect(loopOrderStateLabel(state)).toMatch(pattern);
    });
  }
});

describe('isLoopOrderTerminal', () => {
  it('is true for terminal states', () => {
    expect(isLoopOrderTerminal('fulfilled')).toBe(true);
    expect(isLoopOrderTerminal('rejected')).toBe(true);
    expect(isLoopOrderTerminal('refunded')).toBe(true);
    expect(isLoopOrderTerminal('expired')).toBe(true);
  });

  it('is false for in-flight states (the UI keeps polling)', () => {
    expect(isLoopOrderTerminal('unpaid')).toBe(false);
    expect(isLoopOrderTerminal('paid')).toBe(false);
  });
});

describe('isLoopOrderFailure', () => {
  it('is true only for terminal-and-unhappy states', () => {
    expect(isLoopOrderFailure('rejected')).toBe(true);
    expect(isLoopOrderFailure('refunded')).toBe(true);
    expect(isLoopOrderFailure('expired')).toBe(true);
    expect(isLoopOrderFailure('fulfilled')).toBe(false);
    expect(isLoopOrderFailure('unpaid')).toBe(false);
    expect(isLoopOrderFailure('paid')).toBe(false);
  });
});
