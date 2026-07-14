import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { usdcStroopsPerCent, convertMinorUnits, __resetFxFeedForTests } from '../price-feed-fx.js';
// The corroboration hysteresis lives in the shared rate-sanity module, keyed
// per (feed, currency). Clear it around each test so an `fx:GBP` breach streak
// from one case can't leak into the next. (`__resetFxFeedForTests` wipes only
// the FX rate cache, not the streak map.)
import { __resetRateSanityForTests } from '../rate-sanity.js';

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

/** Stub the Frankfurter FX feed with a fixed `{ base, rates }` body. */
function stubFeed(body: unknown): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(global, 'fetch').mockImplementation(async () => {
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

/**
 * Reads the cached USD→GBP rate through the real settlement-charge path.
 * `convertMinorUnits(1e6, 'USD', 'GBP') = ceil(1_000_000 × cachedRate)`, so
 * the result is monotonic in the cached float rate: a larger cached rate
 * yields a larger probe. This is the exact path that pins a GBP-home user's
 * charge (the money the finding is about), and calling it also triggers the
 * feed refresh when the cache is stale — so one call both advances a
 * corroboration cycle and reads back what got cached.
 */
async function gbpRateProbe(): Promise<bigint> {
  return convertMinorUnits(1_000_000n, 'USD', 'GBP');
}

beforeEach(() => {
  __resetFxFeedForTests();
  __resetRateSanityForTests();
  delete process.env['LOOP_FX_FEED_URL'];
});
afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  __resetFxFeedForTests();
  __resetRateSanityForTests();
  delete process.env['LOOP_FX_FEED_URL'];
});

// MNY-22-FX-RATCHET: the FX feed must cache the value `validateRateJump`
// RETURNS (the bounded/ratcheted value), not the raw observed rate. The FX
// unit is a float (~0.78 GBP/USD), so — unlike the XLM feed's integer
// micro-cents — the returned value is consumed AS-IS with no rounding.
describe('MNY-22-FX-RATCHET: corroborated recovery caches the ratcheted value, not the raw observation', () => {
  it('a spoofed feed serving a huge target does NOT walk the FX anchor there in one corroborated cycle (anti-manipulation)', async () => {
    vi.useFakeTimers();
    try {
      // Cold start pins the FX anchor at 0.78 GBP/USD.
      // ceil(1e6 × 0.78) = 780_000.
      fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.78 } });
      expect(await gbpRateProbe()).toBe(780_000n);

      // A sustained-compromise / spoofed feed now serves 2.0 GBP/USD (a huge,
      // out-of-bound target: 2.0/0.78 = 2.56×, far past the 0.1 FX bound) on
      // EVERY refresh — the counterexample the finding names. On the pre-fix
      // code the 3rd corroborating observation cached the RAW 2.0: a
      // single-cycle jump straight to the attacker-chosen value (the
      // vulnerability). With the return consumed, one corroborated cycle
      // advances the anchor by AT MOST one 0.1 step — to 0.858 (= 0.78 × 1.1),
      // NOT 2.0.
      fetchSpy.mockRestore();
      fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 2.0 } });

      // Two rejects (each pages), then a capped advance on the 3rd corroboration.
      vi.advanceTimersByTime(60_001);
      await expect(gbpRateProbe()).rejects.toThrow(/exceeds sanity bound/);
      vi.advanceTimersByTime(60_001);
      await expect(gbpRateProbe()).rejects.toThrow(/exceeds sanity bound/);
      vi.advanceTimersByTime(60_001);

      // Cached rate after one corroborated cycle is the RATCHETED 0.858,
      // not the raw 2.0. ceil(1e6 × 0.858) = 858_000.
      const afterOneCycle = await gbpRateProbe();
      expect(afterOneCycle).toBe(858_000n);
      // Explicitly NOT the raw-2.0 value the pre-fix code cached:
      // ceil(1e6 × 2.0) = 2_000_000.
      expect(afterOneCycle).not.toBe(2_000_000n);

      // And through the OTHER consumer (USDC payment sizing): with the
      // ratcheted 0.858 anchor a GBP order is sized at
      // ceil(100_000 / 0.858) = 116_551 stroops per pence — close to the real
      // requirement. The pre-fix raw-2.0 cache would size it at
      // ceil(100_000 / 2.0) = 50_000, under-collateralising every GBP order by
      // ~60% (the direct fund-loss the finding describes). Cache is still
      // fresh from the probe above, so this reads the same cycle (no refetch).
      const stroopsPerPence = await usdcStroopsPerCent('GBP');
      expect(stroopsPerPence).toBe(116_551n);
      expect(stroopsPerPence).not.toBe(50_000n);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a legitimate small in-bound move is cached verbatim (no false clamp)', async () => {
    vi.useFakeTimers();
    try {
      fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.78 } });
      expect(await gbpRateProbe()).toBe(780_000n);

      // A ~5% move (0.78 → 0.819, ratio 1.05) is within the 0.1 FX bound, so
      // validateRateJump returns the observation verbatim — the fix must NOT
      // clamp an in-bound move to a ratchet step. ceil(1e6 × 0.819) = 819_000,
      // the exact observation. (Passes both pre- and post-fix — guards the fix
      // against over-clamping legitimate movement.)
      fetchSpy.mockRestore();
      fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.819 } });
      vi.advanceTimersByTime(60_001);
      expect(await gbpRateProbe()).toBe(819_000n);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a genuine large FX gap still recovers over MULTIPLE capped cycles, landing exactly on the real rate', async () => {
    vi.useFakeTimers();
    try {
      // Cold start pins the anchor at 0.78 GBP/USD.
      fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.78 } });
      expect(await gbpRateProbe()).toBe(780_000n);

      // The market genuinely gaps to 1.0 GBP/USD (1.28×, past the 0.1 bound)
      // and STAYS there. The anchor must NOT leap straight to 1.0 — it
      // ratchets one capped 0.1 step per corroborated cycle: 0.78 → 0.858 →
      // 0.9438 → 1.0, converging over multiple cycles and landing EXACTLY on
      // the real rate (it neither overshoots nor re-wedges just short of it).
      fetchSpy.mockRestore();
      fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 1.0 } });

      // Cycle 1: two rejects, then a capped advance to 0.858 (NOT 1.0).
      // ceil(1e6 × 0.858) = 858_000.
      vi.advanceTimersByTime(60_001);
      await expect(gbpRateProbe()).rejects.toThrow(/exceeds sanity bound/);
      vi.advanceTimersByTime(60_001);
      await expect(gbpRateProbe()).rejects.toThrow(/exceeds sanity bound/);
      vi.advanceTimersByTime(60_001);
      expect(await gbpRateProbe()).toBe(858_000n);

      // Cycle 2: from 0.858, 1.0 is still > one step (1.166×) — two rejects,
      // then a capped advance to 0.9438. ceil(1e6 × 0.9438) = 943_800.
      vi.advanceTimersByTime(60_001);
      await expect(gbpRateProbe()).rejects.toThrow(/exceeds sanity bound/);
      vi.advanceTimersByTime(60_001);
      await expect(gbpRateProbe()).rejects.toThrow(/exceeds sanity bound/);
      vi.advanceTimersByTime(60_001);
      expect(await gbpRateProbe()).toBe(943_800n);

      // Cycle 3: from 0.9438, 1.0 is within one step (1.0595×) — the very next
      // observation is accepted directly. Recovery lands exactly on 1.0.
      // ceil(1e6 × 1.0) = 1_000_000.
      vi.advanceTimersByTime(60_001);
      expect(await gbpRateProbe()).toBe(1_000_000n);

      // Stays healthy at the recovered level (cache serves it, no refetch).
      expect(await gbpRateProbe()).toBe(1_000_000n);
    } finally {
      vi.useRealTimers();
    }
  });
});
