/**
 * `/api/auth/*` route mounts. Pulled out of `app.ts` as the
 * fourth per-domain route module after `routes/public.ts`,
 * `routes/misc.ts`, and `routes/merchants.ts`.
 *
 * The auth surface bundles the cache-control middleware mount
 * with the route handlers because the constraint they enforce is
 * inseparable: every response under `/api/auth/*` carries fresh
 * tokens (access/refresh/session-cookie equivalents on the OTP
 * + social-login + refresh paths) and an attacker controlling a
 * misconfigured proxy could otherwise hand one user's tokens to
 * the next caller of the same URL. POST/DELETE aren't cached by
 * standards-compliant caches but the defense-in-depth signal
 * stays — `noStoreResponse` runs even on the 4xx error envelope.
 *
 * Mount-order constraints encoded by this factory:
 * - `noStoreResponse` first, before any handler: ensures the
 *   header lands on every response including 4xx error envelopes
 *   from rate-limit / kill-switch / handler validation.
 * - `killSwitch('auth')` before `rateLimit` on the credential-
 *   minting paths (request-otp, verify-otp, social): the kill
 *   switch is the operator's last-resort mute when CTX upstream
 *   auth is degraded; firing 503 there avoids burning rate-
 *   limit budget on a request the operator wants to drop anyway.
 *
 * Per-route rate-limit rationale (audit-pinned) preserved
 * verbatim in the comments next to each mount: 5/min for
 * request-otp (cheap server-side, expensive upstream), 10/min
 * for verify-otp + social (OTP brute-force defense; ~14,400
 * guesses/day cap on a 6-digit code beats upstream lockout
 * anyway), 30/min for refresh (legit clients refresh once per
 * access-token lifetime), 20/min for logout (the handler fans
 * out to upstream revoke — without a limit an attacker could
 * cheaply spam arbitrary refresh tokens at CTX through us).
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { killSwitch } from '../middleware/kill-switch.js';
import { noStoreResponse } from '../middleware/cache-control.js';
import {
  requestOtpHandler,
  verifyOtpHandler,
  refreshHandler,
  logoutHandler,
} from '../auth/handler.js';
import { googleSocialLoginHandler, appleSocialLoginHandler } from '../auth/social.js';

/** Mounts all `/api/auth/*` routes on the supplied Hono app. */
export function mountAuthRoutes(app: Hono): void {
  // Cache-Control: no-store on every auth response (including
  // 4xx envelopes) before any handler registers — see the @file
  // jsdoc above for rationale.
  app.use('/api/auth/*', noStoreResponse);

  app.post(
    '/api/auth/request-otp',
    killSwitch('auth'),
    rateLimit('POST /api/auth/request-otp', 5, 60_000),
    requestOtpHandler,
  );
  // OTP brute-force defense: 10 attempts per minute per IP. With
  // a 6-digit code that caps guesses at ~14,400/day — upstream
  // lockout/expiry happens first.
  app.post(
    '/api/auth/verify-otp',
    killSwitch('auth'),
    rateLimit('POST /api/auth/verify-otp', 10, 60_000),
    verifyOtpHandler,
  );
  // Refresh abuse defense: legit clients refresh once per
  // access-token lifetime, so 30/min per IP leaves plenty of
  // headroom without enabling spray attacks.
  app.post('/api/auth/refresh', rateLimit('POST /api/auth/refresh', 30, 60_000), refreshHandler);

  // Social login (ADR 014). Same 10/min cap as verify-otp — both
  // are unauthenticated entry points and both resolve to a minted
  // Loop JWT pair on success.
  app.post(
    '/api/auth/social/google',
    killSwitch('auth'),
    rateLimit('POST /api/auth/social/google', 10, 60_000),
    googleSocialLoginHandler,
  );
  app.post(
    '/api/auth/social/apple',
    killSwitch('auth'),
    rateLimit('POST /api/auth/social/apple', 10, 60_000),
    appleSocialLoginHandler,
  );

  // Logout: 20/min per IP. The handler fans out to an upstream
  // revoke, so without a limit an attacker could cheaply spam
  // arbitrary refresh tokens at CTX through us.
  app.delete('/api/auth/session', rateLimit('DELETE /api/auth/session', 20, 60_000), logoutHandler);
}
