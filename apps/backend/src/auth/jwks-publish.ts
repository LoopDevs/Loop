// JWKS publisher for Loop RS256 keys — ADR 030
import type { Context } from 'hono';
import { getLoopRsaPublicJwks } from './signer.js';

export function jwksPublishHandler(c: Context): Response {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json({ keys: getLoopRsaPublicJwks() });
}
