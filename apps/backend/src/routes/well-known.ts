// `/.well-known/*` route mounts — ADR 030, M-3
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { jwksPublishHandler } from '../auth/jwks-publish.js';
import {
  appleAppSiteAssociationHandler,
  assetlinksHandler,
} from '../well-known/deep-link-verification.js';

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
