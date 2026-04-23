/**
 * Identity-resolution helper for `/me*` handlers.
 *
 * A2-550 / A2-551 fix: the previous pattern used `decodeJwtPayload`
 * (no signature verification) to pull `sub` off the bearer, then
 * `upsertUserFromCtx` to materialize the user row. Because
 * `decodeJwtPayload` accepts any string that base64-decodes to JSON
 * with a `sub` field, an attacker could construct a bearer with
 * another user's `sub` and be treated as that user. The fix moves
 * identity to the only place we cryptographically verify it:
 * `requireAuth::verifyLoopToken`, which writes a Loop-signed
 * `auth.userId` onto the context.
 *
 * Post-fix, identity-scoped endpoints require a Loop-signed token.
 * CTX pass-through bearers are rejected for identity resolution —
 * they remain acceptable for pure-proxy paths where CTX validates
 * the bearer on receipt, but those are not this helper's callers.
 *
 * Operational implication: `LOOP_AUTH_NATIVE_ENABLED` must be true
 * for `/me*` endpoints to function. This is the intended pre-launch
 * posture (ADR 013 full rollout).
 */
import type { Context } from 'hono';
import type { LoopAuthContext } from './handler.js';
import { getUserById, type User } from '../db/users.js';

/**
 * Resolves the authenticated caller to a Loop user row, or returns
 * `null` if the caller is not Loop-authed. Callers translate `null`
 * to a 401 response.
 */
export async function resolveLoopAuthenticatedUser(c: Context): Promise<User | null> {
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined || auth.kind !== 'loop') return null;
  return await getUserById(auth.userId);
}
