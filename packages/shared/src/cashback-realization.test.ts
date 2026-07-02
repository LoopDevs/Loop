import { describe, expect, it } from 'vitest';

import { recycledBps } from './cashback-realization.js';

describe('recycledBps', () => {
  it('computes integer basis points, flooring', () => {
    expect(recycledBps(10_000n, 5_000n)).toBe(5_000); // 50.00%
    expect(recycledBps(3n, 1n)).toBe(3_333); // floors 3333.33…
    expect(recycledBps(10_000n, 10_000n)).toBe(10_000);
    expect(recycledBps(10_000n, 1n)).toBe(1);
  });

  it('returns 0 when nothing has been earned (never throws on div-by-zero)', () => {
    expect(recycledBps(0n, 5_000n)).toBe(0);
    expect(recycledBps(-1n, 5_000n)).toBe(0);
  });

  it('clamps corrupt spent > earned to exactly 100%', () => {
    expect(recycledBps(1_000n, 2_000n)).toBe(10_000);
    expect(recycledBps(1n, 1_000_000_000n)).toBe(10_000);
  });

  it('clamps negative spent to 0 (conservative read of ledger corruption)', () => {
    expect(recycledBps(1_000n, -1n)).toBe(0);
    expect(recycledBps(1_000n, -1_000_000n)).toBe(0);
  });

  it('stays finite and in-range for astronomically large bigints', () => {
    const huge = 10n ** 30n;
    expect(recycledBps(huge, huge / 2n)).toBe(5_000);
    expect(recycledBps(huge, huge * 2n)).toBe(10_000);
  });
});
