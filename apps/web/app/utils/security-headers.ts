/**
 * Security headers for the SSR web surface. Audit finding A-027 flagged
 * that the deployed web app was shipping with only `Date`, `Connection`,
 * and `Keep-Alive` — no CSP, X-Frame-Options, Referrer-Policy, or HSTS.
 *
 * The function is exported as a plain utility rather than React Router's
 * route-module `headers` export because RR v7 SPA mode (our mobile build
 * uses `ssr: false`) rejects `headers` as an invalid route-module export
 * and the build fails hard. Keeping the logic here means:
 *
 *   - unit tests can lock the expected header set without depending on
 *     the RR runtime (see `security-headers.test.ts`);
 *   - the wiring layer is free to change without touching CSP policy —
 *     today the CSP + Referrer-Policy are emitted via `<meta>` tags in
 *     `root.tsx`'s `Layout`; the rest are expected at the deploy edge.
 *
 * CSP notes, keep in sync when editing:
 *   - `'unsafe-inline'` on script-src is required for the inline theme
 *     script in root.tsx that runs before hydration to prevent FOUC.
 *   - Tailwind inlines styles at build time, so `'unsafe-inline'` on
 *     style-src is unavoidable.
 *   - fonts.googleapis.com + fonts.gstatic.com — Google Fonts (accepted
 *     third-party dep, see audit A-032).
 *   - *.basemaps.cartocdn.com + *.tile.openstreetmap.org — Leaflet raster
 *     tiles. Wildcard on cartocdn is required because Leaflet substitutes
 *     `{s}` with `a`/`b`/`c`/`d` for load-spreading.
 *   - *.ingest.sentry.io / *.ingest.de.sentry.io — error telemetry.
 *   - `blob:` + `data:` on img-src — Leaflet internal markers and
 *     inline SVG data URIs.
 */
export interface SecurityHeadersOptions {
  /** API origin the web app talks to. Used in CSP connect-src + img-src. */
  apiOrigin?: string;
}

export function buildSecurityHeaders(options: SecurityHeadersOptions = {}): Record<string, string> {
  const apiOrigin = options.apiOrigin ?? 'https://api.loopfinance.io';
  const csp = [
    "default-src 'self'",
    // accounts.google.com/gsi/client: Google Identity Services SDK
    // loaded on demand when the sign-in route mounts and the
    // deployment has a Google client id configured (ADR 014).
    `script-src 'self' 'unsafe-inline' https://accounts.google.com`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com`,
    `font-src 'self' https://fonts.gstatic.com`,
    // `https://basemaps.cartocdn.com` only matches that exact hostname;
    // Leaflet's tile URLs substitute `{s}` with `a`/`b`/`c`/`d` and fetch
    // from `a.basemaps.cartocdn.com` etc., so the bare-domain entry would
    // block every tile load. Use the wildcard form for both CARTO and OSM.
    `img-src 'self' data: blob: ${apiOrigin} https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org https://*.googleusercontent.com`,
    `connect-src 'self' ${apiOrigin} https://*.ingest.sentry.io https://*.ingest.de.sentry.io https://accounts.google.com`,
    // Google renders its sign-in button inside an iframe it owns.
    `frame-src https://accounts.google.com`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');

  return {
    'Content-Security-Policy': csp,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    // A4-050: geolocation=(self) — the "Locate me" button on the
    // ClusterMap reads navigator.geolocation. The blanket
    // `geolocation=()` in the prior policy revoked the capability
    // from same-origin documents too, so the button silently
    // failed in browsers that honour Permissions-Policy. Allowing
    // self only (the Loop origin) keeps the feature working while
    // still blocking iframe / cross-origin geolocation. Camera /
    // microphone stay fully blocked — Loop has no UX that uses
    // them today and Phase-2 plans don't either. Payment stays
    // blocked until a card-rail UX lands (ADR-010 Phase 2);
    // re-enable as `payment=(self)` if/when the Payment Request
    // API is wired in.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}
