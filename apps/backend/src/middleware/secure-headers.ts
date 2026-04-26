/**
 * Hono `secureHeaders` middleware preconfigured for the Loop API.
 * Pulled out of `app.ts` so the CSP + cross-origin policy lives
 * with the other middleware rather than scattered in the mount
 * sequence.
 *
 * Two production-relevant policy choices encoded here:
 *
 * - **`crossOriginResourcePolicy`** flips on `NODE_ENV` —
 *   `same-origin` in production so a browser refuses to load
 *   responses across origins by default; `cross-origin` in dev so
 *   the Vite dev server (different port) can still consume the
 *   API.
 * - **API-appropriate CSP**: this host only ever serves
 *   JSON/binary data (no HTML), so any browser that receives an
 *   injected response should refuse to execute scripts or load
 *   sub-resources from it. `default-src 'none'` is the strictest
 *   possible base; `frame-ancestors 'none'` prevents clickjacking
 *   embeds even on error pages. A second line of defense against
 *   any future XSS class of bug (like the ClusterMap innerHTML one
 *   caught in the hardening sweep).
 */
import { secureHeaders } from 'hono/secure-headers';
import { env } from '../env.js';

export const secureHeadersMiddleware = secureHeaders({
  crossOriginResourcePolicy: env.NODE_ENV === 'production' ? 'same-origin' : 'cross-origin',
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'none'"],
  },
});
