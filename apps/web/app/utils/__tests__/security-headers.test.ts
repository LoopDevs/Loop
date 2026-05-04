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

  it('A4-057: with a per-request nonce, script-src lists the nonce and drops unsafe-inline', () => {
    const withNonce = buildSecurityHeaders({ inlineScriptNonce: 'fixture-nonce-abcd' });
    const csp = withNonce['Content-Security-Policy'] ?? '';
    const scriptSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('script-src '));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain("'nonce-fixture-nonce-abcd'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('A4-057: without a nonce (mobile static export / dev SSR), script-src keeps unsafe-inline', () => {
    const csp = h['Content-Security-Policy'] ?? '';
    const scriptSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('script-src '));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain("'unsafe-inline'");
  });

  it('sets a Content-Security-Policy with frame-ancestors none', () => {
    expect(h['Content-Security-Policy']).toMatch(/default-src 'self'/);
    expect(h['Content-Security-Policy']).toMatch(/frame-ancestors 'none'/);
    expect(h['Content-Security-Policy']).toMatch(/object-src 'none'/);
  });

  it('allows only the intended third-party origins in CSP', () => {
    const csp = h['Content-Security-Policy'] ?? '';
    expect(csp).toContain('fonts.googleapis.com');
    expect(csp).toContain('fonts.gstatic.com');
    // Leaflet substitutes `{s}` with `a`/`b`/`c`/`d` on CARTO tile URLs,
    // so the CSP must whitelist the wildcard — the bare hostname does not
    // match subdomains under CSP host-source semantics.
    expect(csp).toContain('*.basemaps.cartocdn.com');
    expect(csp).toContain('ingest.sentry.io');
  });

  it('sets anti-clickjacking + MIME-sniff + referrer + HSTS headers', () => {
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Strict-Transport-Security']).toMatch(/max-age=\d+/);
    expect(h['Strict-Transport-Security']).toMatch(/includeSubDomains/);
  });

  it('sets a restrictive Permissions-Policy (A4-050: geolocation=(self))', () => {
    expect(h['Permissions-Policy']).toMatch(/camera=\(\)/);
    expect(h['Permissions-Policy']).toMatch(/microphone=\(\)/);
    // A4-050: ClusterMap "Locate me" reads navigator.geolocation;
    // blanket geolocation=() revoked the capability from same-
    // origin documents too. self-only allows the Loop origin
    // while still blocking iframe / cross-origin geolocation.
    expect(h['Permissions-Policy']).toMatch(/geolocation=\(self\)/);
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
