/**
 * SSR security-header wiring for `entry.server.tsx` (A2-1604).
 *
 * Extracted from the framework-invoked `handleRequest` default export so
 * the deploy-time wiring — the `VITE_API_URL` resolution, the per-request
 * nonce threading, and the `Headers.set` loop — is unit-testable in
 * isolation (see `__tests__/entry-server-headers.test.ts`). `handleRequest`
 * imports and calls this exact function, so its runtime behaviour is
 * unchanged; keeping the logic here (rather than inline) is purely so the
 * header contract can be locked by a test without rendering a React tree.
 *
 * Applies `buildSecurityHeaders` to a response headers collection,
 * overwriting any pre-existing value — the utility is the single source of
 * truth, and the default RR flow never emits these today.
 *
 * A2-1104: emits the full `Content-Security-Policy` HTTP header,
 * including `frame-ancestors 'none'`, which the meta tag in `root.tsx`
 * cannot deliver — the CSP spec requires `frame-ancestors`, `report-uri`,
 * and `sandbox` to come from a header. The meta tag stays for the
 * static-export mobile build (Capacitor webview has no SSR to attach
 * headers to). Browsers enforce both policies as their intersection; since
 * the HTTP CSP is a superset of the meta CSP (only the three header-only
 * directives are added), the effective policy equals the HTTP CSP — no
 * functional regression vs. the previous "skip HTTP CSP" behaviour, but
 * `frame-ancestors` is now actually enforced (defence-in-depth on top of
 * `X-Frame-Options`).
 */
import { buildSecurityHeaders } from '~/utils/security-headers';

export function applySecurityHeaders(
  responseHeaders: Headers,
  inlineScriptNonce: string | undefined,
): void {
  const apiOrigin = process.env['VITE_API_URL'] ?? 'https://api.loopfinance.io';
  const headers = buildSecurityHeaders(
    inlineScriptNonce !== undefined ? { apiOrigin, inlineScriptNonce } : { apiOrigin },
  );
  for (const [name, value] of Object.entries(headers)) {
    responseHeaders.set(name, value);
  }
}
