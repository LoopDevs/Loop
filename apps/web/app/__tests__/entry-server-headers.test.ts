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

  it('every header (incl. CSP) survives a Headers round-trip — the entry.server.tsx contract', () => {
    // Simulates what handleRequest does: set every header on the
    // responseHeaders Headers collection. A2-1104 changed this from
    // "skip CSP" to "emit CSP at HTTP layer" so frame-ancestors,
    // report-uri, and sandbox can be enforced (header-only per spec).
    const responseHeaders = new Headers();
    const source = buildSecurityHeaders();
    for (const [name, value] of Object.entries(source)) {
      responseHeaders.set(name, value);
    }
    expect(responseHeaders.get('X-Frame-Options')).toBe('DENY');
    expect(responseHeaders.get('Strict-Transport-Security')).toContain('max-age=');
    // A2-1104: HTTP CSP now emitted (in addition to <meta http-equiv>
    // in root.tsx) so frame-ancestors actually applies. The two
    // policies are enforced as their intersection by browsers.
    const httpCsp = responseHeaders.get('Content-Security-Policy');
    expect(httpCsp).toContain("frame-ancestors 'none'");
    expect(httpCsp).toContain("default-src 'self'");
  });
});
