/**
 * Refresh-token repository (ADR 013). Backs the `refresh_tokens`
 * table: persists each minted refresh, rotates on use, supports
 * revoke-by-user for bulk sign-out.
 *
 * The plaintext refresh JWT is never stored — we persist SHA-256 of
 * the token as a defence-in-depth check. A valid `jti` lookup plus
 * a matching hash is required to treat the token as live; a token
 * whose row is missing or hash-mismatched is rejected even if the
 * signature verifies.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { refreshTokens } from '../db/schema.js';

export type RefreshTokenRow = typeof refreshTokens.$inferSelect;

/** SHA-256 hex of the full refresh-token string. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Records a newly-minted refresh token. `jti` must match the Loop
 * JWT's `jti` claim — enforced by callers via `signLoopToken`.
 */
export async function recordRefreshToken(args: {
  jti: string;
  userId: string;
  token: string;
  expiresAt: Date;
}): Promise<void> {
  await db.insert(refreshTokens).values({
    jti: args.jti,
    userId: args.userId,
    tokenHash: hashRefreshToken(args.token),
    expiresAt: args.expiresAt,
  });
}

/**
 * Looks up a refresh-token row by jti and verifies it is live — not
 * revoked, not expired, and hash-matches the provided token. Returns
 * `null` otherwise.
 *
 * Timing: the hash comparison is a string equality, not a constant-
 * time check. The `jti` lookup already requires a live token id
 * (opaque, 128 bits), so an attacker without the token cannot
 * distinguish rows by response time.
 */
export async function findLiveRefreshToken(args: {
  jti: string;
  token: string;
  now?: Date;
}): Promise<RefreshTokenRow | null> {
  const now = args.now ?? new Date();
  const row = await db.query.refreshTokens.findFirst({
    where: and(
      eq(refreshTokens.jti, args.jti),
      isNull(refreshTokens.revokedAt),
      gt(refreshTokens.expiresAt, now),
    ),
  });
  if (row === undefined) return null;
  if (row.tokenHash !== hashRefreshToken(args.token)) return null;
  return row;
}

/**
 * A2-1608: raw lookup by jti (no live / hash / expiry filter). Used
 * by the refresh handler to distinguish "jti never existed" (forged)
 * from "jti exists but was already revoked" (reuse of a rotated
 * token → token-theft signal). On reuse the handler triggers a
 * family-wide revoke via `revokeAllRefreshTokensForUser`.
 *
 * Never return this row to the client — it's strictly for classifying
 * the reason-for-rejection and driving the revoke decision.
 */
export async function findRefreshTokenRecord(jti: string): Promise<RefreshTokenRow | null> {
  const row = await db.query.refreshTokens.findFirst({
    where: eq(refreshTokens.jti, jti),
  });
  return row ?? null;
}

/**
 * Revokes a refresh token and optionally links it to its successor
 * (for rotation audit). Called inside the refresh handler's txn path
 * before writing the new row.
 */
export async function revokeRefreshToken(args: {
  jti: string;
  replacedByJti?: string;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  await db
    .update(refreshTokens)
    .set({
      revokedAt: now,
      replacedByJti: args.replacedByJti ?? null,
      lastUsedAt: now,
    })
    .where(eq(refreshTokens.jti, args.jti));
}

/**
 * A4-098: concurrency-safe single-shot revoke. Returns `true` only
 * if the row went from `revoked_at IS NULL` → `revoked_at = now()`
 * in this call; `false` if some other request already revoked it
 * (the rotation lost the race).
 *
 * Refresh-token rotation must look like:
 *   1. findLiveRefreshToken (read)
 *   2. tryRevokeIfLive (compare-and-set; gate on this)
 *   3. issueTokenPair (insert successor)
 *
 * Earlier code did revoke as a non-conditional UPDATE after issuing
 * the new pair, so two parallel refresh requests with the same old
 * token both made it past step 1 and both inserted successors.
 * Now the second caller's `tryRevokeIfLive` returns false and the
 * caller maps that to a refresh-rejection without minting a token
 * pair.
 */
export async function tryRevokeIfLive(args: {
  jti: string;
  replacedByJti?: string;
  now?: Date;
}): Promise<boolean> {
  const now = args.now ?? new Date();
  const rows = await db
    .update(refreshTokens)
    .set({
      revokedAt: now,
      replacedByJti: args.replacedByJti ?? null,
      lastUsedAt: now,
    })
    .where(and(eq(refreshTokens.jti, args.jti), isNull(refreshTokens.revokedAt)))
    .returning({ jti: refreshTokens.jti });
  return rows.length === 1;
}

/**
 * Bulk revoke — every live refresh token for a user. Used by
 * `DELETE /api/auth/session/all` and by the security-revoke pathway
 * when we need to invalidate all sessions for a user.
 */
export async function revokeAllRefreshTokensForUser(userId: string): Promise<void> {
  const now = new Date();
  await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}
