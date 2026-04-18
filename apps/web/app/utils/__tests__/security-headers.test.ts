import { describe, it, expect } from 'vitest';
import { buildSecurityHeaders } from '../security-headers';

/**
 * Guards the SSR security header set from regressing. The utility is the
 * source of truth; wiring at the deploy layer applies whatever it returns.
 * If anyone deletes a hardening header without thinking, these tests catch
 * it before the change ships (finding A-027).
 */
describe('buildSecurityHeaders', () => {
  const h = buildSecurityHeaders();

  it('sets a Content-Security-Policy with frame-ancestors none', () => {
    expect(h['Content-Security-Policy']).toMatch(/default-src 'self'/);
    expect(h['Content-Security-Policy']).toMatch(/frame-ancestors 'none'/);
    expect(h['Content-Security-Policy']).toMatch(/object-src 'none'/);
  });

  it('allows only the intended third-party origins in CSP', () => {
    const csp = h['Content-Security-Policy'] ?? '';
    expect(csp).toContain('fonts.googleapis.com');
    expect(csp).toContain('fonts.gstatic.com');
    expect(csp).toContain('basemaps.cartocdn.com');
    expect(csp).toContain('ingest.sentry.io');
  });

  it('sets anti-clickjacking + MIME-sniff + referrer + HSTS headers', () => {
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Strict-Transport-Security']).toMatch(/max-age=\d+/);
    expect(h['Strict-Transport-Security']).toMatch(/includeSubDomains/);
  });

  it('sets a restrictive Permissions-Policy', () => {
    expect(h['Permissions-Policy']).toMatch(/camera=\(\)/);
    expect(h['Permissions-Policy']).toMatch(/microphone=\(\)/);
    expect(h['Permissions-Policy']).toMatch(/geolocation=\(\)/);
  });

  it('sets cross-origin isolation headers', () => {
    expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(h['Cross-Origin-Resource-Policy']).toBe('same-origin');
  });

  it('allows a custom API origin in CSP connect-src', () => {
    const custom = buildSecurityHeaders({ apiOrigin: 'https://api.example.test' });
    expect(custom['Content-Security-Policy']).toContain('https://api.example.test');
  });
});
