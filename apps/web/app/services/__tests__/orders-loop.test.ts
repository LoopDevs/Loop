import { describe, it, expect } from 'vitest';
import { loopOrderStateLabel, isLoopOrderTerminal, type LoopOrderState } from '../orders-loop';

describe('loopOrderStateLabel', () => {
  const cases: Array<[LoopOrderState, RegExp]> = [
    ['pending_payment', /payment/i],
    ['paid', /received/i],
    ['procuring', /gift card/i],
    ['fulfilled', /ready/i],
    ['failed', /failed/i],
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
    expect(isLoopOrderTerminal('failed')).toBe(true);
    expect(isLoopOrderTerminal('expired')).toBe(true);
  });

  it('is false for in-flight states (the UI keeps polling)', () => {
    expect(isLoopOrderTerminal('pending_payment')).toBe(false);
    expect(isLoopOrderTerminal('paid')).toBe(false);
    expect(isLoopOrderTerminal('procuring')).toBe(false);
  });
});
