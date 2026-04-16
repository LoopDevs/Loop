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
});
