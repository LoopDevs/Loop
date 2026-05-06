import { describe, it, expect } from 'vitest';
import { computeAnnualisedRate, computePast30DayApy } from '../apy-snapshot.js';

describe('computeAnnualisedRate', () => {
  describe('happy path', () => {
    it('annualises a 30-day window with 0.25% growth to ~3.05% APY', () => {
      // 1.0025 over 30 days → (1.0025)^(365/30) - 1 ≈ 0.0307
      const result = computeAnnualisedRate({
        startValue: 1.0,
        endValue: 1.0025,
        windowDays: 30,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rate).toBeGreaterThan(0.03);
        expect(result.rate).toBeLessThan(0.031);
      }
    });

    it('annualises a 7-day window with 0.06% growth to ~3.18% APY', () => {
      // 1.0006 over 7 days → (1.0006)^(365/7) - 1 ≈ 0.0319
      const result = computeAnnualisedRate({
        startValue: 1.0,
        endValue: 1.0006,
        windowDays: 7,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rate).toBeGreaterThan(0.031);
        expect(result.rate).toBeLessThan(0.033);
      }
    });

    it('returns 0 for zero growth (stable share price)', () => {
      const result = computeAnnualisedRate({
        startValue: 1.5,
        endValue: 1.5,
        windowDays: 30,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.rate).toBe(0);
    });

    it('returns a negative rate when share price has fallen', () => {
      // 0.99 over 30 days → annualised loss of ~11.5%
      const result = computeAnnualisedRate({
        startValue: 1.0,
        endValue: 0.99,
        windowDays: 30,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rate).toBeLessThan(0);
        expect(result.rate).toBeGreaterThan(-0.13);
      }
    });

    it('handles long windows (90 days) without precision drift', () => {
      // 1.012 over 90 days → (1.012)^(365/90) - 1 ≈ 0.0497
      const result = computeAnnualisedRate({
        startValue: 1.0,
        endValue: 1.012,
        windowDays: 90,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rate).toBeGreaterThan(0.049);
        expect(result.rate).toBeLessThan(0.05);
      }
    });

    it('handles very short windows (1 day) — extrapolates correctly even though display would label it noisy', () => {
      // 1.0001 over 1 day → (1.0001)^365 - 1 ≈ 0.0372
      const result = computeAnnualisedRate({
        startValue: 1.0,
        endValue: 1.0001,
        windowDays: 1,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rate).toBeGreaterThan(0.036);
        expect(result.rate).toBeLessThan(0.038);
      }
    });
  });

  describe('input validation', () => {
    it('rejects zero startValue', () => {
      const result = computeAnnualisedRate({ startValue: 0, endValue: 1, windowDays: 30 });
      expect(result).toEqual({ ok: false, reason: 'invalid_start_value' });
    });

    it('rejects negative startValue', () => {
      const result = computeAnnualisedRate({ startValue: -1, endValue: 1, windowDays: 30 });
      expect(result).toEqual({ ok: false, reason: 'invalid_start_value' });
    });

    it('rejects NaN startValue', () => {
      const result = computeAnnualisedRate({ startValue: NaN, endValue: 1, windowDays: 30 });
      expect(result).toEqual({ ok: false, reason: 'invalid_start_value' });
    });

    it('rejects Infinity startValue', () => {
      const result = computeAnnualisedRate({ startValue: Infinity, endValue: 1, windowDays: 30 });
      expect(result).toEqual({ ok: false, reason: 'invalid_start_value' });
    });

    it('rejects zero endValue', () => {
      const result = computeAnnualisedRate({ startValue: 1, endValue: 0, windowDays: 30 });
      expect(result).toEqual({ ok: false, reason: 'invalid_end_value' });
    });

    it('rejects negative endValue', () => {
      const result = computeAnnualisedRate({ startValue: 1, endValue: -1, windowDays: 30 });
      expect(result).toEqual({ ok: false, reason: 'invalid_end_value' });
    });

    it('rejects NaN endValue', () => {
      const result = computeAnnualisedRate({ startValue: 1, endValue: NaN, windowDays: 30 });
      expect(result).toEqual({ ok: false, reason: 'invalid_end_value' });
    });

    it('rejects zero windowDays', () => {
      const result = computeAnnualisedRate({ startValue: 1, endValue: 1, windowDays: 0 });
      expect(result).toEqual({ ok: false, reason: 'invalid_window' });
    });

    it('rejects negative windowDays', () => {
      const result = computeAnnualisedRate({ startValue: 1, endValue: 1, windowDays: -7 });
      expect(result).toEqual({ ok: false, reason: 'invalid_window' });
    });

    it('rejects NaN windowDays', () => {
      const result = computeAnnualisedRate({ startValue: 1, endValue: 1, windowDays: NaN });
      expect(result).toEqual({ ok: false, reason: 'invalid_window' });
    });

    it('accepts fractional windowDays (e.g. computed from millisecond intervals)', () => {
      // 30.5 days, 1.0025 growth → similar to 30-day result, slightly less
      const result = computeAnnualisedRate({
        startValue: 1.0,
        endValue: 1.0025,
        windowDays: 30.5,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rate).toBeGreaterThan(0.029);
        expect(result.rate).toBeLessThan(0.031);
      }
    });
  });
});

describe('computePast30DayApy', () => {
  it('matches the explicit 30-day computeAnnualisedRate call', () => {
    const sugar = computePast30DayApy({ sharePriceNow: 1.0025, sharePriceAt30dAgo: 1.0 });
    const explicit = computeAnnualisedRate({
      startValue: 1.0,
      endValue: 1.0025,
      windowDays: 30,
    });
    expect(sugar).toEqual(explicit);
  });

  it('rejects bad input via the same discriminated union', () => {
    const result = computePast30DayApy({ sharePriceNow: 1, sharePriceAt30dAgo: 0 });
    expect(result).toEqual({ ok: false, reason: 'invalid_start_value' });
  });
});
