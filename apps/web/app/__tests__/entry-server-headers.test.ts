/**
 * A2-1604: smoke test for the custom entry.server handler asserting
 * that `buildSecurityHeaders` is applied to every SSR response. We
 * cannot render a real React tree in vitest/node without heavy setup,
 * so this test validates the header-injection side of the handler in
 * isolation — import `applySecurityHeaders` if we ever export it, or
 * re-derive via the same utility the handler uses.
 */
import { describe, it, expect } from 'vitest';
import { buildSecurityHeaders } from '~/utils/security-headers';

describe('A2-1604 — web security headers at serve time', () => {
  it('buildSecurityHeaders emits the full non-CSP header set', () => {
    const h = buildSecurityHeaders();
    // The headers that entry.server.tsx applies to every response.
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Strict-Transport-Security']).toContain('max-age=');
    expect(h['Permissions-Policy']).toContain('camera=()');
    expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(h['Cross-Origin-Resource-Policy']).toBe('same-origin');
  });

  it('the non-CSP headers survive a Headers round-trip (the entry.server.tsx contract)', () => {
    // Simulates what handleRequest does: set every non-CSP header on
    // the responseHeaders Headers collection.
    const responseHeaders = new Headers();
    const source = buildSecurityHeaders();
    for (const [name, value] of Object.entries(source)) {
      if (name === 'Content-Security-Policy') continue;
      responseHeaders.set(name, value);
    }
    expect(responseHeaders.get('X-Frame-Options')).toBe('DENY');
    expect(responseHeaders.get('Strict-Transport-Security')).toContain('max-age=');
    // CSP is intentionally NOT duplicated into the HTTP header — root.tsx
    // already emits it via <meta http-equiv>.
    expect(responseHeaders.get('Content-Security-Policy')).toBeNull();
  });
});
