// refresh-token repository — ADR 013, A2-1608, A4-098, NS-09, CF-26, X-PRIV-08
import { createHash } from 'node:crypto';
import { db } from '../db/client.js';
import { bumpUserTokenVersion } from '../db/users.js';
import type { RefreshTokenDoc } from '../db/types.js';

export type RefreshTokenRow = RefreshTokenDoc;

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

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

// jti lookup requires a live opaque id, so non-constant-time hash comparison is safe
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

// A2-1608: raw lookup to distinguish forged jti from rotated-token reuse (theft signal)
export async function findRefreshTokenRecord(jti: string): Promise<RefreshTokenRow | null> {
  return db.collection('refresh_tokens').findOne({ jti });
}

// COR-11: replacedByJti rewritten only when explicit, preserving rotation-chain lineage
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

// A4-098: compare-and-set; true only if this call transitioned revokedAt null → set
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

// NS-09: bump tokenVersion so live access tokens die alongside refresh tokens
export async function revokeAllRefreshTokensForUser(userId: string): Promise<void> {
  const now = new Date();
  await db
    .collection('refresh_tokens')
    .updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now } });
  await bumpUserTokenVersion(userId);
}

// CF-26 / X-PRIV-08: grace period keeps just-rotated rows so racing reuse trips A2-1608
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
