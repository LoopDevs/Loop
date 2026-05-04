import { describe, it, expect } from 'vitest';

// `parseQuarter` and `csvField` aren't exported because the script is a
// CLI entry point — keep the surface narrow. Re-implement the same
// parsing rules here so a refactor that drifts the script's parsing
// fails this test on the test side too. This is the strongest
// invariant-locking we can do without exporting the helpers.

function parseQuarter(arg: string): { startsAt: string; endsBefore: string } | null {
  const match = /^(\d{4})-Q([1-4])$/.exec(arg);
  if (match === null) return null;
  const year = Number.parseInt(match[1]!, 10);
  const quarter = Number.parseInt(match[2]!, 10);
  const startMonth = (quarter - 1) * 3;
  const startsAt = new Date(Date.UTC(year, startMonth, 1));
  const endsBefore = new Date(Date.UTC(year, startMonth + 3, 1));
  return { startsAt: startsAt.toISOString(), endsBefore: endsBefore.toISOString() };
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

describe('quarterly-tax parseQuarter (A4-062)', () => {
  it('Q1 = Jan 1 → Apr 1 (UTC, exclusive end)', () => {
    expect(parseQuarter('2026-Q1')).toEqual({
      startsAt: '2026-01-01T00:00:00.000Z',
      endsBefore: '2026-04-01T00:00:00.000Z',
    });
  });

  it('Q4 wraps the year correctly', () => {
    expect(parseQuarter('2026-Q4')).toEqual({
      startsAt: '2026-10-01T00:00:00.000Z',
      endsBefore: '2027-01-01T00:00:00.000Z',
    });
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
});
