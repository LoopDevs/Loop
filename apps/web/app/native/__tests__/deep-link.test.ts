import { describe, it, expect, vi } from 'vitest';

// Mock Capacitor core so `registerDeepLinks`'s early-return (web) path is
// exercised without needing @capacitor/app to resolve. The pure mapper
// function (`resolveDeepLinkTarget`) needs no Capacitor mocking at all —
// it has no Capacitor dependency by design (see the doc comment in
// deep-link.ts on why it's exported separately).
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
  },
}));

import { resolveDeepLinkTarget, registerDeepLinks } from '../deep-link';

describe('resolveDeepLinkTarget', () => {
  it('resolves a valid merchant link on the apex host', () => {
    expect(resolveDeepLinkTarget('https://loopfinance.io/gift-card/starbucks')).toBe(
      '/gift-card/starbucks',
    );
  });

  it('resolves a locale-prefixed link (ADR 034) on the www host', () => {
    expect(resolveDeepLinkTarget('https://www.loopfinance.io/us/en/gift-card/starbucks')).toBe(
      '/us/en/gift-card/starbucks',
    );
  });

  it('resolves a link on the beta host', () => {
    expect(resolveDeepLinkTarget('https://beta.loopfinance.io/orders/abc-123')).toBe(
      '/orders/abc-123',
    );
  });

  it('preserves query string and hash, but strips origin', () => {
    expect(
      resolveDeepLinkTarget('https://loopfinance.io/gift-card/starbucks?ref=email#section'),
    ).toBe('/gift-card/starbucks?ref=email#section');
  });

  it('resolves the bare path when the URL has no path (root deep link)', () => {
    expect(resolveDeepLinkTarget('https://loopfinance.io/')).toBe('/');
  });

  it('ignores a wrong / lookalike host', () => {
    expect(resolveDeepLinkTarget('https://evil-loopfinance.io/gift-card/starbucks')).toBeNull();
    expect(resolveDeepLinkTarget('https://loopfinance.io.evil.com/gift-card/starbucks')).toBeNull();
    expect(resolveDeepLinkTarget('https://notloopfinance.io/')).toBeNull();
  });

  it('ignores a custom scheme (not a universal link)', () => {
    expect(resolveDeepLinkTarget('loopfinance://gift-card/starbucks')).toBeNull();
    expect(resolveDeepLinkTarget('capacitor://localhost/gift-card/starbucks')).toBeNull();
  });

  it('ignores javascript: payloads', () => {
    expect(resolveDeepLinkTarget('javascript:alert(document.cookie)')).toBeNull();
  });

  it('ignores data: and file: payloads', () => {
    expect(resolveDeepLinkTarget('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(resolveDeepLinkTarget('file:///etc/passwd')).toBeNull();
  });

  it('ignores plain http (not https)', () => {
    expect(resolveDeepLinkTarget('http://loopfinance.io/gift-card/starbucks')).toBeNull();
  });

  it('ignores a malformed URL rather than throwing', () => {
    expect(resolveDeepLinkTarget('not a url')).toBeNull();
  });

  it('does not leak origin/host into the resolved path', () => {
    const result = resolveDeepLinkTarget('https://loopfinance.io/gift-card/starbucks');
    expect(result).not.toContain('loopfinance.io');
    expect(result).not.toContain('https');
    expect(result?.startsWith('/')).toBe(true);
  });
});

describe('registerDeepLinks', () => {
  it('is a no-op on web and returns a safe disposer', () => {
    const onNavigate = vi.fn();
    const dispose = registerDeepLinks(onNavigate);
    expect(typeof dispose).toBe('function');
    expect(() => dispose()).not.toThrow();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
