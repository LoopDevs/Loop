// /api/auth/* route mounts — no-store on every response; kill-switch before rate-limit on credential-minting paths
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { noStoreResponse } from '../middleware/cache-control.js';
import {
  requestOtpHandler,
  verifyOtpHandler,
  refreshHandler,
  logoutHandler,
} from '../auth/handler.js';
import { requireAuth } from '../auth/handler.js';
import { revokeAllOwnSessionsHandler } from '../auth/revoke-sessions-handler.js';
import { googleSocialLoginHandler, appleSocialLoginHandler } from '../auth/social.js';

export function mountAuthRoutes(app: Hono): void {
  app.use('/api/auth/*', noStoreResponse);

  app.post(
    '/api/auth/request-otp',
    rateLimit('POST /api/auth/request-otp', 5, 60_000),
    requestOtpHandler,
  );
  app.post(
    '/api/auth/verify-otp',
    rateLimit('POST /api/auth/verify-otp', 10, 60_000),
    verifyOtpHandler,
  );
  app.post('/api/auth/refresh', rateLimit('POST /api/auth/refresh', 30, 60_000), refreshHandler);

  // ADR 014
  app.post(
    '/api/auth/social/google',
    rateLimit('POST /api/auth/social/google', 10, 60_000),
    googleSocialLoginHandler,
  );
  app.post(
    '/api/auth/social/apple',
    rateLimit('POST /api/auth/social/apple', 10, 60_000),
    appleSocialLoginHandler,
  );

  app.delete('/api/auth/session', rateLimit('DELETE /api/auth/session', 20, 60_000), logoutHandler);

  app.delete(
    '/api/auth/session/all',
    rateLimit('DELETE /api/auth/session/all', 10, 60_000),
    requireAuth,
    revokeAllOwnSessionsHandler,
  );
}
