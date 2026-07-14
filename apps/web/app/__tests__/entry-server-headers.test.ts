/**
 * P2-12 / A2-1604: exercises the REAL header-application wiring that
 * `entry.server.tsx`'s `handleRequest` runs on every SSR response.
 *
 * Previously this file re-derived the header set by calling
 * `buildSecurityHeaders()` directly — a COPY of the handler's logic that
 * stayed green even if `entry.server` dropped or mangled the wiring. It now
 * imports the extracted `applySecurityHeaders` helper (the exact function
 * `handleRequest` calls) and asserts it sets every hardening header, with
 * the intended value, on a real `Headers` collection. So a dropped/weakened
 * header, a broken nonce thread, or a mis-resolved API origin fails HERE.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { applySecurityHeaders } from '~/utils/apply-security-headers';

/** Reads a single directive (e.g. `script-src …`) out of a CSP string. */
function directive(csp: string, name: string): string | undefined {
  return csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `));
}

describe('P2-12 / A2-1604 — entry.server security-header wiring', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('applies the full hardening header set to the response Headers', () => {
    const headers = new Headers();
    applySecurityHeaders(headers, undefined);

    // Anti-clickjacking: the belt (X-Frame-Options) …
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    // … and the braces (CSP frame-ancestors — the header-only directive
    // that the <meta> CSP in root.tsx physically cannot deliver).
    expect(headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");

    // MIME-sniff protection — a classic header a careless edit drops silently.
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');

    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');

    // HSTS present with a sane (>= 1 year) max-age + subdomain coverage.
    const hsts = headers.get('Strict-Transport-Security') ?? '';
    const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(31536000);
    expect(hsts).toContain('includeSubDomains');

    expect(headers.get('Permissions-Policy')).toContain('camera=()');

    // CF-27: allow-popups so the Sign in with Apple popup keeps window.opener.
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin-allow-popups');
    expect(headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');

    // CSP baseline directives (defence-in-depth) that must survive.
    const csp = headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it('overwrites a pre-existing weaker value — the utility is the source of truth', () => {
    const headers = new Headers();
    // Simulate a proxy/default having set a weaker policy upstream.
    headers.set('X-Frame-Options', 'SAMEORIGIN');
    applySecurityHeaders(headers, undefined);
    expect(headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('prod nonce path: threads the per-request nonce into script-src and drops unsafe-inline', () => {
    const headers = new Headers();
    applySecurityHeaders(headers, 'nonce-under-test-1234');
    const scriptSrc = directive(headers.get('Content-Security-Policy') ?? '', 'script-src');
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain("'nonce-nonce-under-test-1234'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('dev / mobile-export path (no nonce): keeps unsafe-inline in script-src', () => {
    const headers = new Headers();
    applySecurityHeaders(headers, undefined);
    const scriptSrc = directive(headers.get('Content-Security-Policy') ?? '', 'script-src');
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain("'unsafe-inline'");
  });

  it('resolves the CSP connect-src API origin from VITE_API_URL (deploy-time wiring)', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test');
    const headers = new Headers();
    applySecurityHeaders(headers, undefined);
    const connectSrc = directive(headers.get('Content-Security-Policy') ?? '', 'connect-src');
    expect(connectSrc).toContain('https://api.example.test');
  });

  it('falls back to the default API origin when VITE_API_URL is unset', () => {
    vi.stubEnv('VITE_API_URL', undefined);
    const headers = new Headers();
    applySecurityHeaders(headers, undefined);
    const connectSrc = directive(headers.get('Content-Security-Policy') ?? '', 'connect-src');
    expect(connectSrc).toContain('https://api.loopfinance.io');
  });
});
