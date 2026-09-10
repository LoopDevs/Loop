// per-request auth middleware — ADR 013, NS-09, A-036
import type { Context } from 'hono';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { verifyLoopToken, isLoopAuthConfigured } from './tokens.js';
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

export type LoopAuthContext =
  | {
      kind: 'loop';
      userId: string;
      email: string;
      /** Loop-signed access JWT. Not forwardable to CTX. */
      bearerToken: string;
    }
  | {
      kind: 'ctx';
      /** Legacy CTX-signed bearer — forwarded upstream verbatim. */
      bearerToken: string;
    };

export async function requireAuth(c: Context, next: () => Promise<void>): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  // Runs before auth fork: both Loop and CTX paths need clientId for downstream attribution
  const clientId = c.req.header('X-Client-Id');
  if (clientId !== undefined && allowedClientIds().has(clientId)) {
    c.set('clientId', clientId);
  } else if (clientId !== undefined) {
    log.warn({ clientId }, 'Rejected untrusted X-Client-Id value on authenticated request');
  }

  if (isLoopAuthConfigured()) {
    const verified = verifyLoopToken(token, 'access');
    if (verified.ok) {
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
      const authCtx: LoopAuthContext = {
        kind: 'loop',
        userId: verified.claims.sub,
        email: verified.claims.email,
        bearerToken: token,
      };
      c.set('auth', authCtx);
      c.set('bearerToken', token);
      await next();
      return;
    }
    // Reject expired/wrong-type Loop tokens now; malformed/bad_signature fall through to CTX
    if (verified.reason === 'expired' || verified.reason === 'wrong_type') {
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' }, 401);
    }
  }

  // CTX pass-through: CTX validates on each proxied call; removed in ADR 013 Phase C
  const ctxAuth: LoopAuthContext = { kind: 'ctx', bearerToken: token };
  c.set('auth', ctxAuth);
  c.set('bearerToken', token);

  await next();
}
