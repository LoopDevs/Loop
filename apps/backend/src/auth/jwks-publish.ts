/**
 * `GET /.well-known/jwks.json` handler (ADR 030 Phase A).
 *
 * Publishes the public halves of Loop's RS256 JWT signing keys as a
 * standard JWKS document (RFC 7517) so an external wallet provider
 * (Privy Custom Auth — or any JWKS-consuming verifier) can verify
 * Loop-minted tokens without Loop sharing a secret. Provider-
 * agnostic by construction: nothing here is Privy-specific.
 *
 * Not to be confused with `./jwks.ts`, which is the CONSUMER side —
 * fetching Google/Apple JWKS for social-login id_token verification
 * (ADR 014). This module is the PUBLISHER side for Loop's own keys.
 *
 * Behaviour notes:
 *
 * - Public, unauthenticated, no PII — the response is exactly the
 *   `LoopRsaPublicJwk` shape from `./signer.ts` (kty/n/e/alg/use/kid;
 *   never `d`/`p`/`q` or other private members).
 * - `{"keys":[]}` (still a valid JWKS) when no RSA key is configured,
 *   rather than a 404 — consumers distinguish "deployment hasn't cut
 *   over to RS256 yet" from "endpoint missing".
 * - `Cache-Control: public, max-age=3600` — 1h, mirroring the TTL our
 *   own consumer side uses for provider JWKS (`./jwks.ts`). Rotation
 *   procedure (docs/runbooks/jwt-key-rotation.md) keeps `_PREVIOUS`
 *   set well beyond this window so cached key sets never miss a kid
 *   for a live token.
 */
import type { Context } from 'hono';
import { getLoopRsaPublicJwks } from './signer.js';

/** Serves the Loop RSA public keys as a JWKS document. */
export function jwksPublishHandler(c: Context): Response {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json({ keys: getLoopRsaPublicJwks() });
}
