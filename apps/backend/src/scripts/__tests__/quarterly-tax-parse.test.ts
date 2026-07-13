import { describe, it, expect, vi } from 'vitest';

// AGT-07: exercise the REAL `parseQuarter` / `csvField` from the script,
// not a hand-duplicated copy. The copy this file used to carry had
// drifted from the source (it re-implemented an RFC-4180-only escaper
// and so never covered the X-PRIV-11 formula-injection guard the real
// `csvField` gained), which meant the suite proved nothing about the
// code that actually ships.
//
// The script imports `../db/client.js` at load, which builds a Postgres
// pool from `env` at module scope (requiring DATABASE_URL and opening a
// socket). Stub it so importing the pure parse/format helpers stays
// side-effect free. The script's own top-level `main()` is guarded
// behind an entry-point check, so importing it here does not run the CLI.
vi.mock('../../db/client.js', () => ({
  db: { execute: vi.fn() },
  closeDb: vi.fn(),
}));

import { parseQuarter, csvField } from '../quarterly-tax.js';

describe('quarterly-tax parseQuarter (A4-062)', () => {
  it('Q1 = Jan 1 → Apr 1 (UTC, exclusive end)', () => {
    expect(parseQuarter('2026-Q1')).toEqual({
      startsAt: '2026-01-01T00:00:00.000Z',
      endsBefore: '2026-04-01T00:00:00.000Z',
      label: '2026-Q1',
    });
  });

  it('Q4 wraps the year correctly', () => {
    expect(parseQuarter('2026-Q4')).toEqual({
      startsAt: '2026-10-01T00:00:00.000Z',
      endsBefore: '2027-01-01T00:00:00.000Z',
      label: '2026-Q4',
    });
  });

  it('carries the original token as `label` for filenames / report ids', () => {
    expect(parseQuarter('2030-Q3')?.label).toBe('2030-Q3');
  });

  it('rejects malformed inputs', () => {
    expect(parseQuarter('2026-Q5')).toBeNull();
    expect(parseQuarter('2026Q1')).toBeNull();
    expect(parseQuarter('Q1-2026')).toBeNull();
    expect(parseQuarter('')).toBeNull();
  });
});

describe('quarterly-tax csvField (A4-062)', () => {
  it('passes plain values through verbatim', () => {
    expect(csvField('amazon')).toBe('amazon');
    expect(csvField(42)).toBe('42');
    expect(csvField(123n)).toBe('123');
  });

  it('quotes commas / quotes / newlines per RFC 4180', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('a"b')).toBe('"a""b"');
    expect(csvField('a\nb')).toBe('"a\nb"');
  });

  it('emits empty string for null / undefined', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  // X-PRIV-11: the real `csvField` delegates to the shared `csvEscape`,
  // which prefixes a spreadsheet-formula leading char with `'` so an
  // accountant opening the export in Excel can't have a `merchant_id`-
  // shaped cell evaluated as a formula. The stale hand-copy never had
  // this guard, so these assertions are exactly what "test the real
  // function" buys us.
  it('neutralises spreadsheet formula-injection leading chars', () => {
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
    // Formula char AND an RFC-4180 special (quote/comma): guard first,
    // then wrap-and-double.
    expect(csvField('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
  });

  it('leaves signed numeric literals intact so finance SUM/sort still works', () => {
    // A bare negative/positive number is not an injection vector — prefixing
    // it with `'` would corrupt the amount into text.
    expect(csvField('-50')).toBe('-50');
    expect(csvField('+1')).toBe('+1');
    expect(csvField(-50)).toBe('-50');
  });

  it('still guards a leading - / + when the rest of the cell is non-numeric', () => {
    expect(csvField('-1+cmd|calc')).toBe("'-1+cmd|calc");
  });
});
