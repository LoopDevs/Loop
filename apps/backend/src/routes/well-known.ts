/**
 * `/.well-known/*` route mounts:
 *
 * - `GET /.well-known/jwks.json` — public JWKS for Loop-minted RS256
 *   JWTs (ADR 030 Phase A). 120/min per IP is generous for the real
 *   consumer pattern (an external wallet provider's verifier fetches
 *   once per ~1h cache window; the response also carries
 *   `Cache-Control: public, max-age=3600`) while still bounding a
 *   scraper. Handler + caching rationale live in
 *   `../auth/jwks-publish.ts`.
 * - `GET /.well-known/apple-app-site-association` — iOS Universal
 *   Links domain-verification (M-3). 404 `WELL_KNOWN_NOT_CONFIGURED`
 *   until `APPLE_TEAM_ID` is set. Handler: `../well-known/deep-link-verification.ts`.
 * - `GET /.well-known/assetlinks.json` — Android App Links domain-
 *   verification (M-3). 404 `WELL_KNOWN_NOT_CONFIGURED` until
 *   `ANDROID_CERT_SHA256` is set. Same handler module.
 *
 * Kept as its own module (rather than entries in `routes/misc.ts`)
 * because `/.well-known/` is a distinct, RFC 8615-defined namespace.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { jwksPublishHandler } from '../auth/jwks-publish.js';
import {
  appleAppSiteAssociationHandler,
  assetlinksHandler,
} from '../well-known/deep-link-verification.js';

/** Mounts every `/.well-known/*` route on the supplied Hono app. */
export function mountWellKnownRoutes(app: Hono): void {
  app.get(
    '/.well-known/jwks.json',
    rateLimit('GET /.well-known/jwks.json', 120, 60_000),
    jwksPublishHandler,
  );
  app.get(
    '/.well-known/apple-app-site-association',
    rateLimit('GET /.well-known/apple-app-site-association', 120, 60_000),
    appleAppSiteAssociationHandler,
  );
  app.get(
    '/.well-known/assetlinks.json',
    rateLimit('GET /.well-known/assetlinks.json', 120, 60_000),
    assetlinksHandler,
  );
}
