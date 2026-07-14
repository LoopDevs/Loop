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

import {
  isPlausibleRateJump,
  ratchetedAnchor,
  validateRateJump,
  __resetRateSanityForTests,
  REQUIRED_CORROBORATIONS,
} from '../rate-sanity.js';

beforeEach(() => {
  notifyMock.mockReset();
  // MNY-22: clear the corroboration hysteresis so a breach streak from
  // one test never leaks into the next.
  __resetRateSanityForTests();
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

// MNY-22-wedge (round 2): the bounded ratchet, in isolation. This is the
// mechanism that removes the round-1 unbounded single-cycle jump.
describe('ratchetedAnchor', () => {
  it('caps an upward advance at one maxRatio step above the prior anchor', () => {
    // Target far above the anchor → clamp to anchor × (1 + maxRatio).
    expect(ratchetedAnchor(100, 100_000, 0.5)).toBe(150);
    expect(ratchetedAnchor(100, 300, 0.5)).toBe(150);
  });

  it('caps a downward advance at one maxRatio step below the prior anchor', () => {
    // Target far below the anchor → clamp to anchor × (1 − maxRatio).
    expect(ratchetedAnchor(100, 1, 0.5)).toBe(50);
    expect(ratchetedAnchor(100, 10, 0.5)).toBe(50);
  });

  it('lands exactly on the target when it is already within one step', () => {
    // Within maxRatio in either direction → no clamping, exact landing.
    expect(ratchetedAnchor(100, 140, 0.5)).toBe(140);
    expect(ratchetedAnchor(100, 60, 0.5)).toBe(60);
  });

  it('never moves the anchor by more than one maxRatio step (both directions)', () => {
    for (const target of [1, 50, 99, 101, 150, 300, 100_000]) {
      const advanced = ratchetedAnchor(100, target, 0.5);
      expect(advanced).toBeLessThanOrEqual(100 * 1.5);
      expect(advanced).toBeGreaterThanOrEqual(100 * 0.5);
      // The ratcheted anchor is always within maxRatio of the prior anchor.
      expect(isPlausibleRateJump(100, advanced, 0.5)).toBe(true);
    }
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

// MNY-22 (A): recovery-from-wedge. A LEGITIMATE move larger than
// `maxRatio` used to wedge the feed forever: the anchor is the last
// good value, a rejected refresh never updates it, so every subsequent
// (correct) rate is compared against the stale pre-move anchor and
// rejected — settlement never recovers. The corroboration streak lets a
// SUSTAINED new level advance the anchor, while a lone outlier never
// does.
describe('validateRateJump — recovery-from-wedge (MNY-22 A)', () => {
  const outOfBound = (): number =>
    validateRateJump({
      currency: 'USD',
      feed: 'xlm',
      previousValue: 100,
      newValue: 300, // 3× the anchor — well past the 0.5 bound
      maxRatio: 0.5,
    });

  it('recovers once N consecutive corroborating observations agree — capped to one maxRatio step', () => {
    // The threshold is a small constant; assert against it rather than a
    // magic number so the test tracks the constant.
    expect(REQUIRED_CORROBORATIONS).toBe(3);
    // First N-1 observations of the genuine new level are still rejected
    // (and paged) — a big move must be corroborated, not trusted blindly.
    for (let i = 0; i < REQUIRED_CORROBORATIONS - 1; i++) {
      expect(outOfBound).toThrow(/exceeds sanity bound/);
    }
    // The Nth consecutive corroborating observation ACCEPTS — the feed
    // stops wedging — but MNY-22-wedge (round 2) caps the advance at ONE
    // maxRatio step: the value the caller must cache is 100 × 1.5 = 150,
    // NOT the observed 300. (Round-1 returned void → the caller cached 300,
    // a single-cycle 3× jump; here the return is 150.)
    expect(outOfBound()).toBe(150);
  });

  it('PAGES on the corroborating observation that ratchets the anchor (loud recovery)', () => {
    for (let i = 0; i < REQUIRED_CORROBORATIONS - 1; i++) {
      expect(outOfBound).toThrow();
    }
    notifyMock.mockReset();
    // Round-2 design: unlike round-1 (which advanced SILENTLY), every
    // capped advance is a real anchor movement an operator must see, and
    // the security property (a malicious walk is loud) depends on each
    // advance paging — so the ratchet step pages exactly once.
    const advanced = outOfBound();
    expect(advanced).toBe(150); // capped, not 300
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('caps a corroborated advance at ONE maxRatio step — never jumps to an arbitrary target (anti-manipulation)', () => {
    // The verifier's counterexample: a sustained-compromise / spoofed feed
    // serving a huge target T for 3 consecutive observations must NOT set
    // the anchor to T in one cycle. previousValue=100, T=100_000 (1000×).
    const huge = (): number =>
      validateRateJump({
        currency: 'USD',
        feed: 'xlm',
        previousValue: 100,
        newValue: 100_000,
        maxRatio: 0.5,
      });
    // First N-1 rejected (paged).
    for (let i = 0; i < REQUIRED_CORROBORATIONS - 1; i++) {
      expect(huge).toThrow(/exceeds sanity bound/);
    }
    // The Nth corroborating observation accepts, but the cached value is
    // capped to ONE maxRatio step above the prior anchor (100 × 1.5 = 150),
    // NOT the observed 100_000. Reaching 100_000 from 100 in 1.5× steps
    // takes ~18 corroborated cycles, each paging — slow AND loud, no
    // single-cycle arbitrary jump.
    const accepted = huge();
    expect(accepted).toBe(150);
    expect(accepted).toBeLessThanOrEqual(100 * (1 + 0.5));
    expect(accepted).not.toBe(100_000);
  });

  it('a genuine large gap converges over multiple capped cycles, each capped and monotonic', () => {
    // Anchor 100, sustained real target 300 (3× the anchor). maxRatio 0.5.
    // Cycle 1: two rejects, then a capped advance to 150 (= 100 × 1.5).
    expect(outOfBound).toThrow(/exceeds sanity bound/);
    expect(outOfBound).toThrow(/exceeds sanity bound/);
    expect(outOfBound()).toBe(150);

    // Cycle 2: from anchor 150, target 300 is still > one step
    // (300 / 150 = 2 > 1.5), so two more rejects then a capped advance to
    // 225 (= 150 × 1.5).
    const from150 = (): number =>
      validateRateJump({
        currency: 'USD',
        feed: 'xlm',
        previousValue: 150,
        newValue: 300,
        maxRatio: 0.5,
      });
    expect(from150).toThrow(/exceeds sanity bound/);
    expect(from150).toThrow(/exceeds sanity bound/);
    expect(from150()).toBe(225);

    // From anchor 225, target 300 is within one step (300 / 225 = 1.333 <
    // 1.5), so the VERY NEXT observation is accepted directly — recovery
    // lands exactly on 300 with no further ratchet. It neither oscillates
    // nor re-wedges just short of the target.
    const landed = validateRateJump({
      currency: 'USD',
      feed: 'xlm',
      previousValue: 225,
      newValue: 300,
      maxRatio: 0.5,
    });
    expect(landed).toBe(300);
  });

  it('a single transient outlier followed by a normal reading does NOT advance the anchor', () => {
    // One outlier — rejected, opens a streak.
    expect(outOfBound).toThrow(/exceeds sanity bound/);
    // A normal reading (within bound of the anchor) clears the streak.
    expect(() =>
      validateRateJump({
        currency: 'USD',
        feed: 'xlm',
        previousValue: 100,
        newValue: 105,
        maxRatio: 0.5,
      }),
    ).not.toThrow();
    // The outlier value reappearing is a FRESH breach (streak reset to 1),
    // so it is rejected again — two non-consecutive outliers never
    // corroborate, so a lone manipulated tick can't move the anchor.
    expect(outOfBound).toThrow(/exceeds sanity bound/);
  });

  it('an unstable (walking) out-of-bound series never corroborates', () => {
    // Each observation disagrees with the streak candidate, so the streak
    // keeps resetting to 1 and never reaches the threshold — corroboration
    // requires a STABLE new level, not a value that keeps climbing.
    expect(() =>
      validateRateJump({
        currency: 'USD',
        feed: 'xlm',
        previousValue: 100,
        newValue: 300,
        maxRatio: 0.5,
      }),
    ).toThrow(/exceeds sanity bound/);
    expect(() =>
      validateRateJump({
        currency: 'USD',
        feed: 'xlm',
        previousValue: 100,
        newValue: 900,
        maxRatio: 0.5,
      }),
    ).toThrow(/exceeds sanity bound/);
    expect(() =>
      validateRateJump({
        currency: 'USD',
        feed: 'xlm',
        previousValue: 100,
        newValue: 2700,
        maxRatio: 0.5,
      }),
    ).toThrow(/exceeds sanity bound/);
  });

  it('keeps corroboration streaks independent per (feed, currency)', () => {
    // Interleave 2 observations on xlm:USD with 2 on fx:GBP. That is 4
    // total out-of-bound observations, but each KEY is only at 2 — below
    // the threshold of 3 — so all four are still rejected. If the streaks
    // shared a key the 3rd interleaved call would have prematurely
    // accepted.
    const xlm = (): number =>
      validateRateJump({
        currency: 'USD',
        feed: 'xlm',
        previousValue: 100,
        newValue: 300,
        maxRatio: 0.5,
      });
    const fx = (): number =>
      validateRateJump({
        currency: 'GBP',
        feed: 'fx',
        previousValue: 100,
        newValue: 300,
        maxRatio: 0.5,
      });
    expect(xlm).toThrow(); // xlm streak = 1
    expect(fx).toThrow(); // fx streak = 1
    expect(xlm).toThrow(); // xlm streak = 2 (still < 3)
    expect(fx).toThrow(); // fx streak = 2 (still < 3)
  });
});

// MNY-22 (B): absolute backstops that fire even on a COLD cache (where
// the relative bound cannot, having no prior value to compare).
describe('validateRateJump — absolute floor (MNY-22 B)', () => {
  it('rejects a rate below the floor even on a cold cache', () => {
    expect(() =>
      validateRateJump({
        currency: 'USD',
        feed: 'xlm',
        previousValue: undefined, // cold cache
        newValue: 50,
        maxRatio: 0.5,
        floor: 100,
      }),
    ).toThrow(/below absolute floor/);
  });

  it('accepts a rate at or above the floor', () => {
    expect(() =>
      validateRateJump({
        currency: 'USD',
        feed: 'xlm',
        previousValue: undefined,
        newValue: 100,
        maxRatio: 0.5,
        floor: 100,
      }),
    ).not.toThrow();
  });

  it("is fail-open: no floor supplied → any positive rate accepted (today's behaviour)", () => {
    expect(() =>
      validateRateJump({
        currency: 'USD',
        feed: 'xlm',
        previousValue: undefined,
        newValue: 1,
        maxRatio: 0.5,
      }),
    ).not.toThrow();
  });

  it('a below-floor rate is never corroborated away (rejected however stable)', () => {
    const belowFloor = (): number =>
      validateRateJump({
        currency: 'USD',
        feed: 'xlm',
        previousValue: 100,
        newValue: 5, // out of relative bound AND below floor
        maxRatio: 0.5,
        floor: 50,
      });
    // Even repeated identical below-floor observations stay rejected —
    // the floor short-circuits before the corroboration streak.
    for (let i = 0; i < REQUIRED_CORROBORATIONS + 1; i++) {
      expect(belowFloor).toThrow(/below absolute floor/);
    }
  });
});

describe('validateRateJump — staleness bound (MNY-22 B)', () => {
  it('rejects an observation older than the staleness bound, even on a cold cache', () => {
    expect(() =>
      validateRateJump({
        currency: 'USD',
        feed: 'xlm',
        previousValue: undefined, // cold cache
        newValue: 100,
        maxRatio: 0.5,
        staleness: { observedAtMs: 0, nowMs: 600_001, maxAgeMs: 600_000 },
      }),
    ).toThrow(/is stale/);
  });

  it('accepts an observation within the staleness bound', () => {
    expect(() =>
      validateRateJump({
        currency: 'USD',
        feed: 'xlm',
        previousValue: undefined,
        newValue: 100,
        maxRatio: 0.5,
        staleness: { observedAtMs: 600_000, nowMs: 600_500, maxAgeMs: 600_000 },
      }),
    ).not.toThrow();
  });

  it('is fail-open: no staleness supplied → age is not checked', () => {
    expect(() =>
      validateRateJump({
        currency: 'USD',
        feed: 'xlm',
        previousValue: undefined,
        newValue: 100,
        maxRatio: 0.5,
      }),
    ).not.toThrow();
  });
});
