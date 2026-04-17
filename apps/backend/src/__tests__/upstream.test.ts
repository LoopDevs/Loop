import { describe, it, expect, vi } from 'vitest';

vi.mock('../env.js', () => ({
  env: {
    GIFT_CARD_API_BASE_URL: 'https://spend.ctx.com',
  },
}));

import { upstreamUrl } from '../upstream.js';

describe('upstreamUrl', () => {
  it('builds a simple URL', () => {
    expect(upstreamUrl('/login')).toBe('https://spend.ctx.com/login');
  });

  it('interpolates path segments verbatim', () => {
    expect(upstreamUrl('/gift-cards/abc-123')).toBe('https://spend.ctx.com/gift-cards/abc-123');
  });

  it('throws when path does not start with /', () => {
    expect(() => upstreamUrl('login')).toThrow(/must start with/);
  });

  it('throws on path traversal segments', () => {
    expect(() => upstreamUrl('/gift-cards/../admin')).toThrow(/traversal/);
    expect(() => upstreamUrl('/..')).toThrow(/traversal/);
    expect(() => upstreamUrl('/a/../b')).toThrow(/traversal/);
  });

  it('allows dots that are not standalone segments', () => {
    expect(() => upstreamUrl('/v1.0/merchants')).not.toThrow();
    expect(() => upstreamUrl('/.well-known/openid')).not.toThrow();
    expect(() => upstreamUrl('/file.json')).not.toThrow();
  });

  it('throws on CRLF injection attempts', () => {
    expect(() => upstreamUrl('/login\r\nHost: evil.com')).toThrow(/control/);
    expect(() => upstreamUrl('/login\nX-Injected: 1')).toThrow(/control/);
  });

  it('throws on NUL and other control chars', () => {
    expect(() => upstreamUrl('/path\u0000injection')).toThrow(/control/);
    expect(() => upstreamUrl('/path\u0007bell')).toThrow(/control/);
  });

  it('throws on C1 control characters (0x80–0x9f)', () => {
    expect(() => upstreamUrl('/path\u0080cc1')).toThrow(/control/);
    expect(() => upstreamUrl('/path\u009fcc1')).toThrow(/control/);
  });

  it('throws on a leading // (protocol-relative shape)', () => {
    expect(() => upstreamUrl('//evil.com/admin')).toThrow(/protocol-relative/);
  });

  it('throws on percent-encoded traversal segments', () => {
    expect(() => upstreamUrl('/gift-cards/%2e%2e/admin')).toThrow(/percent-encoded traversal/);
    expect(() => upstreamUrl('/gift-cards/%2E%2E/admin')).toThrow(/percent-encoded traversal/);
    // Mixed encoding is also rejected — catches %2e%2E as well.
    expect(() => upstreamUrl('/gift-cards/%2e%2E/admin')).toThrow(/percent-encoded traversal/);
  });

  it('allows single percent-encoded dots (not a traversal)', () => {
    // `%2e` on its own is just an encoded `.` — not traversal.
    expect(() => upstreamUrl('/v1/file%2ejson')).not.toThrow();
  });

  it('normalises a trailing slash on the base URL to avoid double-slash', async () => {
    vi.resetModules();
    vi.doMock('../env.js', () => ({ env: { GIFT_CARD_API_BASE_URL: 'https://spend.ctx.com/' } }));
    const { upstreamUrl: freshUrl } = await import('../upstream.js');
    expect(freshUrl('/login')).toBe('https://spend.ctx.com/login');
    vi.doUnmock('../env.js');
  });
});
