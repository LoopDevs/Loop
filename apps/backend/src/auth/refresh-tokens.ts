/**
 * Refresh-token repository (ADR 013). Backs the `refresh_tokens`
 * collection: persists each minted refresh, rotates on use, supports
 * revoke-by-user for bulk sign-out.
 *
 * The plaintext refresh JWT is never stored — we persist SHA-256 of
 * the token as a defence-in-depth check. A valid `jti` lookup plus
 * a matching hash is required to treat the token as live; a token
 * whose row is missing or hash-mismatched is rejected even if the
 * signature verifies.
 */
import { createHash } from 'node:crypto';
import { db } from '../db/client.js';
import { bumpUserTokenVersion } from '../db/users.js';
import type { RefreshTokenDoc } from '../db/types.js';

export type RefreshTokenRow = RefreshTokenDoc;

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
  await db.collection('refresh_tokens').insertOne({
    jti: args.jti,
    userId: args.userId,
    tokenHash: hashRefreshToken(args.token),
    expiresAt: args.expiresAt,
    revokedAt: null,
    replacedByJti: null,
    lastUsedAt: null,
    createdAt: new Date(),
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
  const row = await db
    .collection('refresh_tokens')
    .findOne({ jti: args.jti, revokedAt: null, expiresAt: { $gt: now } });
  if (row === null) return null;
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
  return db.collection('refresh_tokens').findOne({ jti });
}

/**
 * Revokes a single refresh token by jti. Sole production caller is the
 * logout handler — rotation goes through `tryRevokeIfLive` (A4-098),
 * not this. `revokedAt` is the terminal marker.
 *
 * COR-11: the rotation link `replacedByJti` is (re)written ONLY when
 * the caller passes an explicit successor; when omitted it is left
 * untouched, so an already-rotated row keeps the link to the token
 * that superseded it (the rotation-chain audit lineage).
 */
export async function revokeRefreshToken(args: {
  jti: string;
  replacedByJti?: string;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  await db.collection('refresh_tokens').updateOne(
    { jti: args.jti },
    {
      $set: {
        revokedAt: now,
        lastUsedAt: now,
        ...(args.replacedByJti !== undefined ? { replacedByJti: args.replacedByJti } : {}),
      },
    },
  );
}

/**
 * A4-098: concurrency-safe single-shot revoke. Returns `true` only
 * if the row went from `revokedAt: null` → revoked in this call;
 * `false` if some other request already revoked it (the rotation lost
 * the race).
 *
 * Refresh-token rotation must look like:
 *   1. findLiveRefreshToken (read)
 *   2. mintTokenPair (sign only — no row written yet)
 *   3. tryRevokeIfLive (compare-and-set; gate on this)
 *   4. persistMintedRefreshToken (insert successor — winners only)
 */
export async function tryRevokeIfLive(args: {
  jti: string;
  replacedByJti?: string;
  now?: Date;
}): Promise<boolean> {
  const now = args.now ?? new Date();
  const updated = await db.collection('refresh_tokens').updateOne(
    { jti: args.jti, revokedAt: null },
    {
      $set: {
        revokedAt: now,
        replacedByJti: args.replacedByJti ?? null,
        lastUsedAt: now,
      },
    },
  );
  return updated !== null;
}

/**
 * Bulk revoke — every live refresh token for a user, AND (NS-09) a bump
 * of the user's `tokenVersion` so their live ACCESS tokens die at the
 * same instant. Used by `DELETE /api/auth/session/all` (self sign-out)
 * and the refresh-token-reuse family-revoke (A2-1608, a token-theft
 * signal). Both are "kill this user's sessions" events, so both must
 * invalidate the access tokens too — not just the refresh tokens.
 */
export async function revokeAllRefreshTokensForUser(userId: string): Promise<void> {
  const now = new Date();
  await db
    .collection('refresh_tokens')
    .updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now } });
  // NS-09: bump the access-token revocation counter. Access tokens
  // have no per-token row (unlike the refresh rows revoked above),
  // so this per-user counter is their revocation — requireAuth rejects
  // any access token whose `tv` claim no longer matches.
  await bumpUserTokenVersion(userId);
}

/**
 * CF-26 / X-PRIV-08: retention sweep. Deletes rows that are dead AND
 * past the retention grace:
 *
 *   - `expiresAt < now - retentionMs` — the token is past its refresh
 *     horizon; it can never authenticate again.
 *   - OR `revokedAt < now - retentionMs` — the token was rotated or
 *     security-revoked long enough ago that the token-theft reuse
 *     signal is no longer actionable.
 *
 * A row that is neither expired nor revoked is live and never touched.
 * The `retentionMs` grace keeps a just-rotated row around briefly so a
 * racing reuse attempt still trips the family-wide revoke (A2-1608)
 * rather than looking like a forged jti.
 */
export async function purgeDeadRefreshTokens(args: {
  retentionMs: number;
  now?: Date;
}): Promise<number> {
  const cutoff = new Date((args.now ?? new Date()).getTime() - args.retentionMs);
  const tokens = db.collection('refresh_tokens');
  const expired = await tokens.deleteMany({ expiresAt: { $lt: cutoff } });
  const revoked = await tokens.deleteMany({ revokedAt: { $lt: cutoff } });
  return expired + revoked;
}
