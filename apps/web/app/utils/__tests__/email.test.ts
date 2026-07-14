import { describe, it, expect } from 'vitest';
import { isValidEmail } from '../email';

describe('isValidEmail', () => {
  it('accepts a plausible address', () => {
    expect(isValidEmail('alice@example.com')).toBe(true);
  });

  // FE-57: these are the cases where the old inline `/.+@.+\..+/`
  // regex was wrong — unanchored and permissive, it accepted all of
  // them even though the backend rejects them. The aligned shape
  // (mirroring the backend's EMAIL_SHAPE) must reject them.
  it('rejects a second @ that the old regex accepted', () => {
    // Old `/.+@.+\..+/` matched this (greedy `.+` swallows the first
    // `@`); the anchored EMAIL_SHAPE rejects the extra `@`.
    expect(isValidEmail('foo@bar@baz.com')).toBe(false);
  });

  it('rejects embedded whitespace that the old regex accepted', () => {
    expect(isValidEmail('a b@example.com')).toBe(false);
  });

  it('rejects leading/trailing whitespace (old regex matched a substring)', () => {
    expect(isValidEmail(' alice@example.com')).toBe(false);
    expect(isValidEmail('alice@example.com ')).toBe(false);
  });

  it('rejects trailing junk after a valid-looking address', () => {
    expect(isValidEmail('alice@example.com not-an-email')).toBe(false);
  });

  it('rejects addresses with no domain dot', () => {
    expect(isValidEmail('alice@example')).toBe(false);
  });

  it('rejects a missing local part or @', () => {
    expect(isValidEmail('@example.com')).toBe(false);
    expect(isValidEmail('alice.example.com')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});
