import { describe, it, expect } from 'vitest';
import { formatMinorCurrency, pctBigint } from './money-format.js';

describe('formatMinorCurrency — basic rendering', () => {
  it('formats a small bigint minor amount with two decimals', () => {
    expect(formatMinorCurrency(4200n, 'GBP')).toBe('£42.00');
  });

  it('accepts a string minor amount (backend JSON shape)', () => {
    expect(formatMinorCurrency('1500', 'USD')).toBe('$15.00');
  });

  it('accepts a number minor amount (legacy call sites)', () => {
    expect(formatMinorCurrency(2550, 'EUR')).toBe('€25.50');
  });

  it('renders zero', () => {
    expect(formatMinorCurrency(0n, 'USD')).toBe('$0.00');
  });

  it('groups thousands', () => {
    expect(formatMinorCurrency(123456789n, 'USD')).toBe('$1,234,567.89');
  });

  it('handles negatives', () => {
    expect(formatMinorCurrency(-2550n, 'EUR')).toBe('-€25.50');
    expect(formatMinorCurrency('-1500', 'USD')).toBe('-$15.00');
  });

  it('truncates a non-integer number toward zero to minor-unit precision (COR-04)', () => {
    // Positive: trunc and floor agree — the sub-cent fraction is dropped.
    expect(formatMinorCurrency(1500.9, 'USD')).toBe('$15.00');
    // Negative: truncation toward zero keeps the magnitude at 1500 → -$15.00.
    // A floor would push it AWAY from zero to -1501 → -$15.01, so pinning
    // -$15.00 here locks the rounding DIRECTION and catches a silent flip
    // of `Math.trunc` to `Math.floor`/round. (Minor units are integers in
    // practice, so this path is defensive — but the direction still matters.)
    expect(formatMinorCurrency(-1500.9, 'USD')).toBe('-$15.00');
  });

  it('returns em-dash for non-finite numbers', () => {
    expect(formatMinorCurrency(Number.NaN, 'USD')).toBe('—');
    expect(formatMinorCurrency(Number.POSITIVE_INFINITY, 'USD')).toBe('—');
  });

  it('returns em-dash for an unparseable string', () => {
    expect(formatMinorCurrency('garbage', 'USD')).toBe('—');
  });
});

describe('formatMinorCurrency — fractionDigits option', () => {
  it('omits decimals when fractionDigits is 0 (chart/summary variant)', () => {
    expect(formatMinorCurrency(12500n, 'GBP', { fractionDigits: 0 })).toBe('£125');
    // Truncates (not rounds) to whole units — we render the floored major bigint.
    expect(formatMinorCurrency(123456789n, 'USD', { fractionDigits: 0 })).toBe('$1,234,567');
  });

  it('0-decimal truncates (does not round) the minor fraction', () => {
    // 99 cents must not bump the dollar figure — we render the major bigint as-is.
    expect(formatMinorCurrency(19999n, 'USD', { fractionDigits: 0 })).toBe('$199');
    expect(formatMinorCurrency(150n, 'USD', { fractionDigits: 0 })).toBe('$1');
  });

  it('0-decimal handles negatives', () => {
    expect(formatMinorCurrency(-12500n, 'GBP', { fractionDigits: 0 })).toBe('-£125');
  });
});

describe('formatMinorCurrency — bigint precision past 2^53 (CF-23 / P2-SHARED-01)', () => {
  // The whole point of the helper: fleet/solvency aggregates above
  // ~9e15 minor units (≈ $90T in cents) must stay exact. The old
  // `Number(abs/100n)` implementation lost precision here.
  const TWO_POW_53 = 2n ** 53n; // 9_007_199_254_740_992

  it('is exact one minor-unit past the 2^53 boundary', () => {
    // 900719925474099300 cents = $9,007,199,254,740,993.00 exactly.
    // The legacy Number()/100 path returned $9,007,199,254,740,992.00.
    expect(formatMinorCurrency('900719925474099300', 'USD')).toBe('$9,007,199,254,740,993.00');
  });

  it('is exact at a very large 19-digit minor amount', () => {
    // The legacy path returned $100,000,000,000,000,000.00 (grossly wrong).
    expect(formatMinorCurrency('9999999999999999999', 'USD')).toBe('$99,999,999,999,999,999.99');
  });

  it('preserves the exact major + fractional digits for a 2^53-cent value', () => {
    // 2^53 cents = 9007199254740992 cents = $90,071,992,547,409.92.
    const result = formatMinorCurrency(TWO_POW_53, 'USD');
    expect(result).toBe('$90,071,992,547,409.92');
  });

  it('is exact for large negatives', () => {
    expect(formatMinorCurrency(-900719925474099300n, 'USD')).toBe('-$9,007,199,254,740,993.00');
  });

  it('keeps the trailing cents distinct across consecutive large values', () => {
    // Off-by-one in the minor digits must survive past 2^53 — proves no
    // Number rounding collapsed neighbouring totals.
    expect(formatMinorCurrency('900719925474099301', 'USD')).toBe('$9,007,199,254,740,993.01');
    expect(formatMinorCurrency('900719925474099302', 'USD')).toBe('$9,007,199,254,740,993.02');
  });

  it('is exact past 2^53 with the 0-decimal chart variant', () => {
    expect(formatMinorCurrency('900719925474099399', 'USD', { fractionDigits: 0 })).toBe(
      '$9,007,199,254,740,993',
    );
  });
});

describe('formatMinorCurrency — locale + unknown-currency fallback', () => {
  it('honours an explicit locale (separators + symbol placement)', () => {
    // de-DE groups with '.' and uses ',' for the decimal; symbol trails.
    const out = formatMinorCurrency(123456789n, 'EUR', { locale: 'de-DE' });
    expect(out).toContain('1.234.567'); // grouped integer
    expect(out).toContain(',89'); // locale decimal separator, not '.'
    expect(out).toContain('€');
  });

  it('falls back to "<amount> <code>" for an unknown ISO code (still exact)', () => {
    // Force the Intl-throw path with a structurally-invalid code.
    expect(formatMinorCurrency('900719925474099300', 'US')).toBe('9007199254740993.00 US');
  });
});

describe('formatMinorCurrency — currency minor-unit exponent (AUD-13)', () => {
  // The split must derive from the currency's real exponent, not a hardcoded
  // 2. Against the old `/100n` split, KWD 1234 came out "KWD 12.34" (10x too
  // big, wrong decimal count) and JPY 1234 came out "¥12.34".
  //
  // ICU renders code-display currencies (KWD/BHD) and some locales with a
  // non-breaking space (U+00A0 / U+202F) between the code and the number, and
  // that codepoint varies across ICU/V8 versions. `norm` collapses it to an
  // ASCII space so the assertions pin the load-bearing part — the three-decimal
  // split "1.234" vs the buggy "12.34" — and not the engine's whitespace glyph.
  const norm = (s: string): string => s.replace(/[\u00A0\u202F]/g, ' ');

  it('formats a 3-decimal currency (KWD) with three fraction digits', () => {
    // 1234 minor units = 1.234 KWD, NOT 12.34.
    expect(norm(formatMinorCurrency(1234n, 'KWD'))).toBe('KWD 1.234');
  });

  it('groups a large 3-decimal (KWD) amount and keeps three fraction digits', () => {
    expect(norm(formatMinorCurrency(1234567n, 'KWD'))).toBe('KWD 1,234.567');
  });

  it('formats another 3-decimal currency (BHD) correctly', () => {
    expect(norm(formatMinorCurrency(1234n, 'BHD'))).toBe('BHD 1.234');
  });

  it('handles a negative 3-decimal amount', () => {
    expect(norm(formatMinorCurrency(-1234n, 'KWD'))).toBe('-KWD 1.234');
  });

  it('formats a 0-decimal currency (JPY) with no fraction and full magnitude', () => {
    // 1234 minor units = ¥1,234 (yen has no sub-unit), NOT ¥12.34. The yen
    // symbol carries no separator, so these stay exact.
    expect(formatMinorCurrency(1234n, 'JPY')).toBe('¥1,234');
    expect(formatMinorCurrency(-1234n, 'JPY')).toBe('-¥1,234');
  });

  it('is exact for a large 3-decimal amount past 2^53 minor units', () => {
    // Proves the bigint split uses the /1000 divisor without a Number cast.
    expect(norm(formatMinorCurrency('9007199254740993456', 'KWD'))).toBe(
      'KWD 9,007,199,254,740,993.456',
    );
  });

  it('respects an explicit fractionDigits:0 override on a 3-decimal currency', () => {
    // Chart/summary variant: drop the fraction but keep the correct major.
    expect(norm(formatMinorCurrency(1234n, 'KWD', { fractionDigits: 0 }))).toBe('KWD 1');
  });

  it('keeps the 3-decimal split under a non-en-US locale', () => {
    // de-DE: '.' groups, ',' is the decimal separator.
    expect(norm(formatMinorCurrency(1234567n, 'KWD', { locale: 'de-DE' }))).toBe('1.234,567 KWD');
  });

  it('leaves 2-decimal currencies byte-identical (USD/GBP/EUR unchanged)', () => {
    // Guards the "must stay exactly as before" contract for the common case.
    // Symbol currencies carry no separator, so these assert the exact bytes.
    expect(formatMinorCurrency(1234n, 'USD')).toBe('$12.34');
    expect(formatMinorCurrency(4200n, 'GBP')).toBe('£42.00');
    expect(formatMinorCurrency(2550n, 'EUR')).toBe('€25.50');
    expect(formatMinorCurrency(19999n, 'USD', { fractionDigits: 0 })).toBe('$199');
  });
});

describe('pctBigint', () => {
  it('formats a basic ratio', () => {
    expect(pctBigint(50n, 200n)).toBe('25.0%');
  });

  it('rounds to one decimal', () => {
    expect(pctBigint(1n, 3n)).toBe('33.3%');
  });

  it('returns null for a non-positive denominator', () => {
    expect(pctBigint(5n, 0n)).toBeNull();
    expect(pctBigint(5n, -1n)).toBeNull();
  });
});
