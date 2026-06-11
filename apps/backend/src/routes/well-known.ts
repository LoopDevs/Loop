/**
 * `/.well-known/*` route mounts — currently a single endpoint:
 *
 * - `GET /.well-known/jwks.json` — public JWKS for Loop-minted RS256
 *   JWTs (ADR 030 Phase A). 120/min per IP is generous for the real
 *   consumer pattern (an external wallet provider's verifier fetches
 *   once per ~1h cache window; the response also carries
 *   `Cache-Control: public, max-age=3600`) while still bounding a
 *   scraper. Handler + caching rationale live in
 *   `../auth/jwks-publish.ts`.
 *
 * Kept as its own module (rather than a fourth entry in
 * `routes/misc.ts`) because `/.well-known/` is a distinct,
 * RFC 8615-defined namespace that future endpoints (e.g.
 * `apple-app-site-association`, `assetlinks.json` for mobile deep
 * links) would also land in.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { jwksPublishHandler } from '../auth/jwks-publish.js';

/** Mounts `/.well-known/jwks.json` on the supplied Hono app. */
export function mountWellKnownRoutes(app: Hono): void {
  app.get(
    '/.well-known/jwks.json',
    rateLimit('GET /.well-known/jwks.json', 120, 60_000),
    jwksPublishHandler,
  );
}
