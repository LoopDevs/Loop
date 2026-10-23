// per-request auth middleware — ADR 013, NS-09, A-036
import type { Context } from 'hono';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { verifyLoopToken } from './tokens.js';
import { getUserTokenVersion } from '../db/users.js';

const log = logger.child({ handler: 'auth-middleware' });

// A-036: restrict to server-side allowlist to prevent arbitrary entity context injection
function allowedClientIds(): ReadonlySet<string> {
  return new Set([
    config.ctx.clientIds.web,
    config.ctx.clientIds.ios,
    config.ctx.clientIds.android,
  ]);
}

export interface LoopAuthContext {
  userId: string;
  email: string;
}

export async function requireAuth(c: Context, next: () => Promise<void>): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  const clientId = c.req.header('X-Client-Id');
  if (clientId !== undefined && allowedClientIds().has(clientId)) {
    c.set('clientId', clientId);
  } else if (clientId !== undefined) {
    log.warn({ clientId }, 'Rejected untrusted X-Client-Id value on authenticated request');
  }

  const verified = verifyLoopToken(token, 'access');
  if (!verified.ok) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' }, 401);
  }

  // NS-09: signature/expiry valid does not prove token is LIVE; must check current token_version
  let currentVersion: number | null;
  try {
    currentVersion = await getUserTokenVersion(verified.claims.sub);
  } catch (err) {
    // Fail closed: cannot prove token is live, and DB outage breaks wider request anyway
    log.error(
      { err, userId: verified.claims.sub },
      'NS-09: token_version read failed — rejecting request',
    );
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to verify session' }, 500);
  }
  if (currentVersion === null || verified.claims.tv !== currentVersion) {
    // Reject stale/missing tv; client's refresh token will re-mint with current tv
    return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' }, 401);
  }

  const authCtx: LoopAuthContext = { userId: verified.claims.sub, email: verified.claims.email };
  c.set('auth', authCtx);
  await next();
}
