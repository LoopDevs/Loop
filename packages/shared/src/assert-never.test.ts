import { describe, expect, it } from 'vitest';

import { assertNever } from './assert-never.js';

describe('assertNever', () => {
  it('throws loudly with the label and offending value', () => {
    expect(() => assertNever('surprise' as never, 'orderState')).toThrow(
      'Non-exhaustive orderState: "surprise"',
    );
  });

  it('defaults the label to "value"', () => {
    expect(() => assertNever(42 as never)).toThrow('Non-exhaustive value: 42');
  });

  it('stringifies structured values for the error message', () => {
    expect(() => assertNever({ state: 'x' } as never)).toThrow('{"state":"x"}');
  });
});
