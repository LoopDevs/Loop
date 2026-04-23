import { describe, it, expect } from 'vitest';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';

describe('scrubUpstreamBody (A2-555)', () => {
  it('redacts a JWT substring', () => {
    const body = 'Invalid token eyJhbGciOi.eyJzdWIiOi.signaturehere';
    expect(scrubUpstreamBody(body)).toBe('Invalid token [REDACTED_JWT]');
  });

  it('redacts multiple JWTs in the same body', () => {
    const body = 'got aaaa.bbbb.cccc and dddd.eeee.ffff';
    const out = scrubUpstreamBody(body);
    expect(out).toBe('got [REDACTED_JWT] and [REDACTED_JWT]');
  });

  it('redacts long opaque tokens (32+ base64url chars)', () => {
    const body = 'authorization token abcdefghijklmnopqrstuvwxyz012345 expired';
    expect(scrubUpstreamBody(body)).toBe('authorization token [REDACTED_TOKEN] expired');
  });

  it('leaves short hex-shaped values alone (not a token)', () => {
    const body = 'error code 0x1234abcd — see docs';
    // "0x1234abcd" is 10 chars — below the 32-char threshold.
    expect(scrubUpstreamBody(body)).toBe(body);
  });

  it('caps output at maxLen when scrubbing leaves a long benign body', () => {
    // A 1000-char body that doesn't match any token shape — just
    // "a b c d ..." — should cap at maxLen=500.
    const body = 'x '.repeat(500); // 1000 chars of "x " alternation
    expect(scrubUpstreamBody(body)).toHaveLength(500);
  });

  it('passes short benign strings through unchanged', () => {
    const body = 'no such user';
    expect(scrubUpstreamBody(body)).toBe(body);
  });

  it('handles empty body', () => {
    expect(scrubUpstreamBody('')).toBe('');
  });
});
