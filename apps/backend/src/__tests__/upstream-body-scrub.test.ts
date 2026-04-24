import { describe, it, expect } from 'vitest';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';

describe('scrubUpstreamBody (A2-555 + A2-1306)', () => {
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

  // A2-1306 — email + card-shape redaction
  it('redacts an email address (A2-1306)', () => {
    const body = 'no such user alice@example.com in catalog';
    expect(scrubUpstreamBody(body)).toBe('no such user [REDACTED_EMAIL] in catalog');
  });

  it('redacts multiple emails in the same body (A2-1306)', () => {
    const body = 'a@b.com and c@d.io conflict';
    expect(scrubUpstreamBody(body)).toBe('[REDACTED_EMAIL] and [REDACTED_EMAIL] conflict');
  });

  it('does not false-positive on @-mentions without a TLD (A2-1306)', () => {
    // No dotted host → not an email.
    const body = 'mention @someone at standup';
    expect(scrubUpstreamBody(body)).toBe(body);
  });

  it('redacts a 16-digit PAN-shaped substring (A2-1306)', () => {
    const body = 'card 4111111111111111 rejected';
    expect(scrubUpstreamBody(body)).toBe('card [REDACTED_CARD] rejected');
  });

  it('redacts a 13-digit gift-card-code-shaped substring (A2-1306)', () => {
    const body = 'gift card 1234567890123 not found';
    expect(scrubUpstreamBody(body)).toBe('gift card [REDACTED_CARD] not found');
  });

  it('does not redact short numeric ids (under 13 digits)', () => {
    // 12-digit run is below the card threshold.
    const body = 'order 123456789012 paid';
    expect(scrubUpstreamBody(body)).toBe(body);
  });

  it('redacts mixed JWT + email + card in one body (A2-555 + A2-1306)', () => {
    const body = 'tok aaaa.bbbb.cccc user alice@example.com card 4111111111111111';
    const out = scrubUpstreamBody(body);
    expect(out).toContain('[REDACTED_JWT]');
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).toContain('[REDACTED_CARD]');
    expect(out).not.toContain('alice@example.com');
    expect(out).not.toContain('4111111111111111');
  });
});
