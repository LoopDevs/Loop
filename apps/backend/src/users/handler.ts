/**
 * User profile handlers.
 *
 * `GET /api/users/me` — returns the caller's Loop user profile. The
 * primary surface for the client to read `home_currency` (ADR 015)
 * + admin flag + email. Works for both Loop-native bearers (userId
 * comes straight off the JWT) and legacy CTX bearers (user row is
 * resolved via the existing CTX-anchored upsert path).
 *
 * No write-side endpoint in this slice — changing `home_currency`
 * post-signup is support-mediated for MVP (ADR 015). A later PATCH
 * surface can land when self-serve is in scope.
 */
import type { Context } from 'hono';
import { decodeJwtPayload } from '../auth/jwt.js';
import { upsertUserFromCtx, getUserById, type User } from '../db/users.js';
import type { LoopAuthContext } from '../auth/handler.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'users' });

export interface UserMeView {
  id: string;
  email: string;
  isAdmin: boolean;
  /** ADR 015 — USD / GBP / EUR. Drives order denomination + cashback asset. */
  homeCurrency: string;
}

function toView(row: User): UserMeView {
  return {
    id: row.id,
    email: row.email,
    isAdmin: row.isAdmin,
    homeCurrency: row.homeCurrency,
  };
}

/**
 * Resolves the authenticated caller to a Loop user row. Loop-native
 * bearers already carry a resolved `userId` on `c.get('auth')`; CTX
 * bearers fall through to the upsert path so the row is created on
 * first touch (mirrors `requireAdmin`'s resolution semantics).
 */
async function resolveCallingUser(c: Context): Promise<User | null> {
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined) return null;
  if (auth.kind === 'loop') {
    return await getUserById(auth.userId);
  }
  const claims = decodeJwtPayload(auth.bearerToken);
  if (claims === null) return null;
  return await upsertUserFromCtx({
    ctxUserId: claims.sub,
    email: typeof claims['email'] === 'string' ? claims['email'] : undefined,
  });
}

export async function getMeHandler(c: Context): Promise<Response> {
  let user: User | null;
  try {
    user = await resolveCallingUser(c);
  } catch (err) {
    log.error({ err }, 'Failed to resolve calling user');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to resolve user' }, 500);
  }
  if (user === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }
  return c.json<UserMeView>(toView(user));
}
