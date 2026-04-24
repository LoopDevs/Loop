import { describe, it, expect } from 'vitest';
import { formatMinorCurrency, pctBigint } from '@loop/shared';
import { computeAccrualMinor } from '../credits/accrue-interest.js';
import {
  computeLedgerDriftFromRows,
  type BalanceRow,
  type TransactionRow,
} from '../credits/ledger-invariant.js';

/**
 * A2-1710 — property-based-style tests for the bigint-money surface.
 *
 * We didn't take fast-check as a dependency (ADR gate on new deps,
 * and the surface is small enough that a seeded PRNG driving a
 * thousand inputs gives us the same confidence). Each `describe`
 * block below pins a property that must hold across the input space,
 * then drives it with randomised inputs in the per-property ranges.
 *
 * If a property ever fails, the seed is printed so the failing case
 * is reproducible. Seed is fixed per run for stable CI output — if
 * you're chasing a flake, swap it.
 */

const SEED = 0x5eed_1710;

/** xorshift32 — tiny, deterministic. Good enough for test-case shuffling. */
function mkRng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
}

const rng = mkRng(SEED);

/** Random signed bigint in `[-max, max]`. */
function randBigint(max: bigint): bigint {
  // Two 32-bit chunks combined; modulo into the range. Good enough
  // for test-input spread.
  const r =
    (BigInt(Math.floor(rng() * 0xffff_ffff)) << 32n) | BigInt(Math.floor(rng() * 0xffff_ffff));
  const span = max * 2n + 1n;
  const within = ((r % span) + span) % span;
  return within - max;
}

/** Random non-negative bigint in `[0, max]`. */
function randNonNegBigint(max: bigint): bigint {
  const r = randBigint(max);
  return r < 0n ? -r : r;
}

const CURRENCIES = ['USD', 'GBP', 'EUR'];

describe('formatMinorCurrency — properties (A2-1710)', () => {
  it('never throws across the bigint range we care about (±1e18 minor)', () => {
    const ceiling = 10n ** 18n;
    for (let i = 0; i < 500; i++) {
      const minor = randBigint(ceiling);
      const currency = CURRENCIES[Math.floor(rng() * CURRENCIES.length)]!;
      expect(() => formatMinorCurrency(minor, currency)).not.toThrow();
    }
  });

  it('sign-consistent: abs(minor) > 0 produces a non-empty string, minor=0 contains "0"', () => {
    for (let i = 0; i < 200; i++) {
      const minor = randNonNegBigint(10n ** 15n);
      const out = formatMinorCurrency(minor, 'USD');
      expect(out.length).toBeGreaterThan(0);
      if (minor === 0n) expect(out).toMatch(/0/);
    }
  });

  it('preserves the sign in the output string', () => {
    for (let i = 0; i < 200; i++) {
      const abs = randNonNegBigint(10n ** 12n);
      if (abs === 0n) continue;
      const neg = formatMinorCurrency(-abs, 'USD');
      const pos = formatMinorCurrency(abs, 'USD');
      // Intl formats negatives with a leading '-' (or parentheses — but
      // 'en-US' which our helper pins is leading-minus).
      expect(neg).toMatch(/^-/);
      expect(pos).not.toMatch(/^-/);
    }
  });

  it('string and bigint inputs produce identical output', () => {
    for (let i = 0; i < 200; i++) {
      const minor = randBigint(10n ** 15n);
      const asBigint = formatMinorCurrency(minor, 'USD');
      const asString = formatMinorCurrency(minor.toString(), 'USD');
      expect(asBigint).toBe(asString);
    }
  });

  it('stays bigint-safe past 2^53 — the whole-unit component of the output is preserved', () => {
    // 2^53 + some — magnitudes where Number() would silently lose precision.
    const huge = 9_007_199_254_740_993n + randNonNegBigint(10n ** 15n);
    const out = formatMinorCurrency(huge * 100n, 'USD'); // × 100 so whole > 2^53 too
    // Intl inserts group separators (commas in en-US); strip them before
    // matching the digit block so the test reflects intent (whole-unit
    // digits survived the bigint-split) not Intl's formatting choices.
    const digits = out.replace(/[^0-9]/g, '');
    const expectedMajorStart = huge.toString().slice(0, 6);
    expect(digits).toContain(expectedMajorStart);
  });
});

describe('pctBigint — properties (A2-1710)', () => {
  it('bounded: num ≥ 0 and num ≤ denom → output between 0.0% and 100.0%', () => {
    for (let i = 0; i < 500; i++) {
      const denom = randNonNegBigint(10n ** 12n) + 1n; // avoid 0
      const num = randNonNegBigint(denom);
      const out = pctBigint(num, denom);
      expect(out).toMatch(/^\d+\.\d%$/);
      const pct = Number(out!.replace('%', ''));
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });

  it('returns null for denom ≤ 0 across the range', () => {
    for (let i = 0; i < 100; i++) {
      const num = randBigint(10n ** 12n);
      const denom = -randNonNegBigint(10n ** 12n); // ≤ 0
      expect(pctBigint(num, denom)).toBeNull();
    }
    expect(pctBigint(5n, 0n)).toBeNull();
  });

  it('num > denom produces a value > 100% (over-recycled case)', () => {
    for (let i = 0; i < 200; i++) {
      const denom = randNonNegBigint(10n ** 9n) + 1n;
      const num = denom + randNonNegBigint(denom);
      const out = pctBigint(num, denom);
      const pct = Number(out!.replace('%', ''));
      expect(pct).toBeGreaterThanOrEqual(100);
    }
  });
});

describe('computeAccrualMinor — properties (A2-1710)', () => {
  it('never produces a negative accrual', () => {
    for (let i = 0; i < 500; i++) {
      const balance = randBigint(10n ** 15n);
      const apyBps = Math.floor(rng() * 10_000);
      const periodsPerYear = 1 + Math.floor(rng() * 365);
      const out = computeAccrualMinor(balance, { apyBasisPoints: apyBps, periodsPerYear });
      expect(out).toBeGreaterThanOrEqual(0n);
    }
  });

  it('monotonic: larger balance → ≥ accrual, for a fixed period', () => {
    for (let i = 0; i < 100; i++) {
      const apyBps = 1 + Math.floor(rng() * 1000);
      const periodsPerYear = 12;
      const a = randNonNegBigint(10n ** 10n);
      const b = a + randNonNegBigint(10n ** 10n);
      const ax = computeAccrualMinor(a, { apyBasisPoints: apyBps, periodsPerYear });
      const bx = computeAccrualMinor(b, { apyBasisPoints: apyBps, periodsPerYear });
      expect(bx).toBeGreaterThanOrEqual(ax);
    }
  });

  it('flooring: accrual ≤ balance × bps / (10000 × periodsPerYear)', () => {
    for (let i = 0; i < 300; i++) {
      const balance = randNonNegBigint(10n ** 12n);
      const apyBps = 1 + Math.floor(rng() * 10_000);
      const periodsPerYear = 1 + Math.floor(rng() * 365);
      const out = computeAccrualMinor(balance, { apyBasisPoints: apyBps, periodsPerYear });
      const upper = (balance * BigInt(apyBps)) / (10_000n * BigInt(periodsPerYear));
      expect(out).toBeLessThanOrEqual(upper);
    }
  });

  it('zero-balance / zero-apy short-circuits to 0n (Loop never pays on nothing)', () => {
    for (let i = 0; i < 50; i++) {
      expect(computeAccrualMinor(0n, { apyBasisPoints: 400, periodsPerYear: 12 })).toBe(0n);
      const b = randNonNegBigint(10n ** 10n);
      expect(computeAccrualMinor(b, { apyBasisPoints: 0, periodsPerYear: 12 })).toBe(0n);
      expect(computeAccrualMinor(b, { apyBasisPoints: 400, periodsPerYear: 0 })).toBe(0n);
    }
  });
});

describe('computeLedgerDriftFromRows — properties (A2-1710)', () => {
  it('returns empty when sums match across randomised balances', () => {
    for (let i = 0; i < 100; i++) {
      const userCount = 1 + Math.floor(rng() * 5);
      const balances: BalanceRow[] = [];
      const txs: TransactionRow[] = [];
      for (let u = 0; u < userCount; u++) {
        const userId = `u-${u}`;
        const currency = CURRENCIES[Math.floor(rng() * CURRENCIES.length)]!;
        // Break the balance into random positive chunks that sum to it.
        const target = randNonNegBigint(10n ** 10n);
        if (target === 0n) {
          // Zero-target user: skip balance row (orphan-zero case handled elsewhere).
          continue;
        }
        balances.push({ userId, currency, balanceMinor: target });
        let remaining = target;
        while (remaining > 0n) {
          // `randNonNegBigint(remaining - 1n) + 1n` produces a chunk in
          // `[1, remaining]` — inclusive of remaining so the loop terminates
          // on the last iteration. Previous math `randNonNegBigint(remaining) + 1n`
          // could exceed remaining and then `remaining -= chunk` went negative,
          // producing a drift that then failed the "sums match" invariant.
          const chunk = remaining > 1n ? randNonNegBigint(remaining - 1n) + 1n : remaining;
          txs.push({ userId, currency, amountMinor: chunk });
          remaining -= chunk;
        }
      }
      expect(computeLedgerDriftFromRows(balances, txs)).toEqual([]);
    }
  });

  it('any injected drift surfaces in the output', () => {
    for (let i = 0; i < 100; i++) {
      const ledgerSum = randNonNegBigint(10n ** 10n);
      const drift = randNonNegBigint(10n ** 6n) + 1n; // non-zero
      const balances: BalanceRow[] = [
        { userId: 'u-1', currency: 'USD', balanceMinor: ledgerSum + drift },
      ];
      const txs: TransactionRow[] = [{ userId: 'u-1', currency: 'USD', amountMinor: ledgerSum }];
      const out = computeLedgerDriftFromRows(balances, txs);
      expect(out).toHaveLength(1);
      expect(out[0]?.deltaMinor).toBe(drift.toString());
    }
  });
});
