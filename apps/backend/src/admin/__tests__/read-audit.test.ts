import { describe, expect, it } from 'vitest';
import { sanitizeAdminReadQueryString } from '../read-audit.js';

describe('sanitizeAdminReadQueryString', () => {
  it('returns undefined for an empty query string', () => {
    expect(sanitizeAdminReadQueryString('')).toBeUndefined();
  });

  it('redacts email-bearing params while preserving the filter keys', () => {
    expect(sanitizeAdminReadQueryString('email=user@example.com')).toBe('email=%5BREDACTED%5D');
    expect(sanitizeAdminReadQueryString('q=alice@example.com&limit=20')).toBe(
      'limit=20&q=%5BREDACTED%5D',
    );
  });

  it('leaves non-PII params untouched', () => {
    expect(sanitizeAdminReadQueryString('state=failed&limit=20')).toBe('state=failed&limit=20');
  });
});
