import type { Context } from 'hono';
import { decodeJwtPayload } from './jwt.js';
import { upsertUserFromCtx, type User } from '../db/users.js';
import { logger } from '../logger.js';

const log = logger.child({ middleware: 'requireAdmin' });

/**
 * Admin-only middleware. Layered on top of `requireAuth` so the
 * `bearerToken` context value is already set. Decodes the JWT
 * (signature not verified — see `jwt.ts` for rationale), upserts
 * the corresponding Loop user row, and rejects the request with
 * 403 if the user isn't flagged as admin.
 *
 * On success: `c.get('user')` returns the upserted User row.
 *
 * Intentionally not invoked from `requireAuth` itself — the upsert
 * is a DB write per request, which we only want to pay on the
 * admin path for now. Once the identity takeover (ADR 013) replaces
 * CTX-anchored auth with Loop-issued JWTs, the upsert migrates into
 * the auth path proper.
 */
export async function requireAdmin(
  c: Context,
  next: () => Promise<void>,
): Promise<Response | void> {
  const bearer = c.get('bearerToken') as string | undefined;
  if (bearer === undefined) {
    // requireAuth should have run before us. If it didn't, fail
    // closed — an admin endpoint must never be reachable without
    // auth state on the context.
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }
  const claims = decodeJwtPayload(bearer);
  if (claims === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Invalid bearer token' }, 401);
  }
  let user: User;
  try {
    user = await upsertUserFromCtx({
      ctxUserId: claims.sub,
      email: typeof claims['email'] === 'string' ? claims['email'] : undefined,
    });
  } catch (err) {
    log.error({ err, ctxUserId: claims.sub }, 'Failed to upsert admin user');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to resolve user' }, 500);
  }
  if (!user.isAdmin) {
    // 404 not 403 — don't leak the existence of the admin surface
    // to a non-admin authenticated user. An unauth'd request is
    // 401 at the earlier guard; a wrong-role request is 404.
    return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
  }
  c.set('user', user);
  await next();
}
