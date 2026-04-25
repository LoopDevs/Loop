import { describe, it, expect } from 'vitest';
import { normalizeEmail, NonAsciiEmailError } from '../normalize-email.js';

describe('normalizeEmail (A2-2002)', () => {
  it('lowercases ASCII input', () => {
    expect(normalizeEmail('Alice@Example.com')).toBe('alice@example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  alice@example.com  ')).toBe('alice@example.com');
  });

  it('NFKC-collapses fullwidth characters to ASCII', () => {
    // ＡＤＭＩＮ@example.com → ADMIN@example.com → admin@example.com
    expect(normalizeEmail('ＡＤＭＩＮ@example.com')).toBe('admin@example.com');
  });

  it('NFKC-collapses ligatures (ﬃ → ffi)', () => {
    // U+FB03 LATIN SMALL LIGATURE FFI
    expect(normalizeEmail('o\uFB03ce@example.com')).toBe('office@example.com');
  });

  it('rejects Cyrillic-confusable email (homograph attack)', () => {
    // U+0430 CYRILLIC SMALL LETTER A — looks like ASCII a but isn't
    expect(() => normalizeEmail('\u0430dmin@example.com')).toThrow(NonAsciiEmailError);
  });

  it('rejects an email with a non-ASCII suffix', () => {
    // German ß — not an ASCII letter, NFKC keeps it as ß
    expect(() => normalizeEmail('user@exämple.com')).toThrow(NonAsciiEmailError);
  });

  it('rejects emojis', () => {
    expect(() => normalizeEmail('hi😀@example.com')).toThrow(NonAsciiEmailError);
  });

  it('NonAsciiEmailError carries the raw input for logging', () => {
    try {
      normalizeEmail('\u0430dmin@example.com');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NonAsciiEmailError);
      expect((err as NonAsciiEmailError).raw).toBe('\u0430dmin@example.com');
    }
  });
});
