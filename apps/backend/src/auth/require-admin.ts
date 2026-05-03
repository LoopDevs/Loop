import type { Context } from 'hono';
import type { LoopAuthContext } from './handler.js';
import { getUserById, type User } from '../db/users.js';
import { logger } from '../logger.js';

const log = logger.child({ middleware: 'requireAdmin' });

/**
 * Admin-only middleware. Layered on top of `requireAuth` so the
 * `auth` context value is already set. Only Loop-verified auth
 * contexts are eligible for local admin authorization; legacy CTX
 * pass-through bearers are not cryptographically anchored on this
 * service and must not drive local admin decisions. Once the caller
 * is Loop-authenticated, resolve the already-materialized Loop user
 * row by internal UUID and reject the request if the row is missing
 * or not admin.
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
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined) {
    // requireAuth should have run before us. If it didn't, fail
    // closed — an admin endpoint must never be reachable without
    // auth state on the context.
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }
  if (auth.kind !== 'loop') {
    return c.json(
      { code: 'UNAUTHORIZED', message: 'Loop-authenticated admin session required' },
      401,
    );
  }
  let user: User;
  try {
    const resolved = await getUserById(auth.userId);
    if (resolved === null) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' }, 401);
    }
    user = resolved;
  } catch (err) {
    log.error({ err, userId: auth.userId }, 'Failed to resolve admin user');
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
