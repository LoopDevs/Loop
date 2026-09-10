// secureHeaders for the Loop API — CORP same-origin in prod, cross-origin in dev (Vite on a different port)
// CSP: this host only serves JSON/binary → default-src 'none'; frame-ancestors blocks clickjacking (second XSS line)
import { secureHeaders } from 'hono/secure-headers';
import { config } from '../config/index.js';

export const secureHeadersMiddleware = secureHeaders({
  crossOriginResourcePolicy: config.env === 'production' ? 'same-origin' : 'cross-origin',
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'none'"],
  },
});
