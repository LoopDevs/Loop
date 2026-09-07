import { describe, it, expect, beforeEach } from 'vitest';
import { db, __resetDbForTests } from '../../db/client.js';
import type { UserDoc } from '../../db/types.js';
import {
  hashRefreshToken,
  recordRefreshToken,
  findLiveRefreshToken,
  findRefreshTokenRecord,
  revokeRefreshToken,
  tryRevokeIfLive,
  revokeAllRefreshTokensForUser,
  purgeDeadRefreshTokens,
} from '../refresh-tokens.js';

/**
 * Refresh-token repository (ADR 013), against the real in-memory
 * document store — the live-row predicate, the rotation CAS, the
 * COR-11 lineage preservation, and the retention sweep all run for
 * real.
 */
beforeEach(() => {
  __resetDbForTests();
});

const FUTURE = new Date(Date.now() + 60_000);

async function seedUser(id: string): Promise<UserDoc> {
  const now = new Date();
  const doc: UserDoc = {
    id,
    ctxUserId: null,
    email: `${id}@test.local`,
    tokenVersion: 0,
    homeCurrency: 'USD',
    createdAt: now,
    updatedAt: now,
  };
  await db.collection('users').insertOne(doc);
  return doc;
}

describe('hashRefreshToken', () => {
  it('is deterministic + 64-char hex', () => {
    const a = hashRefreshToken('token-a');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(hashRefreshToken('token-a'));
    expect(a).not.toBe(hashRefreshToken('token-b'));
  });
});

describe('recordRefreshToken', () => {
  it('inserts the hash, never the plaintext token', async () => {
    await recordRefreshToken({
      jti: 'jti-1',
      userId: 'user-uuid',
      token: 'super-secret-token',
      expiresAt: FUTURE,
    });
    const row = await db.collection('refresh_tokens').findOne({ jti: 'jti-1' });
    expect(row).not.toBeNull();
    expect(row?.userId).toBe('user-uuid');
    expect(row?.tokenHash).toBe(hashRefreshToken('super-secret-token'));
    expect(row?.tokenHash).not.toBe('super-secret-token');
    expect(row?.revokedAt).toBeNull();
    expect(row?.replacedByJti).toBeNull();
  });
});

describe('findLiveRefreshToken', () => {
  it('returns null when no row matches the jti', async () => {
    expect(await findLiveRefreshToken({ jti: 'missing', token: 'anything' })).toBeNull();
  });

  it('returns null when the row exists but the hash does not match', async () => {
    await recordRefreshToken({
      jti: 'jti-1',
      userId: 'u-1',
      token: 'real-token',
      expiresAt: FUTURE,
    });
    expect(await findLiveRefreshToken({ jti: 'jti-1', token: 'different-token' })).toBeNull();
  });

  it('returns null for a revoked or expired row (live predicate)', async () => {
    await recordRefreshToken({
      jti: 'jti-revoked',
      userId: 'u-1',
      token: 'tok-r',
      expiresAt: FUTURE,
    });
    await revokeRefreshToken({ jti: 'jti-revoked' });
    expect(await findLiveRefreshToken({ jti: 'jti-revoked', token: 'tok-r' })).toBeNull();

    await recordRefreshToken({
      jti: 'jti-expired',
      userId: 'u-1',
      token: 'tok-e',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await findLiveRefreshToken({ jti: 'jti-expired', token: 'tok-e' })).toBeNull();
  });

  it('returns the row when jti + hash match and the row is live', async () => {
    await recordRefreshToken({
      jti: 'jti-1',
      userId: 'u-1',
      token: 'real-token',
      expiresAt: FUTURE,
    });
    const r = await findLiveRefreshToken({ jti: 'jti-1', token: 'real-token' });
    expect(r?.jti).toBe('jti-1');
    expect(r?.userId).toBe('u-1');
  });
});

describe('revokeRefreshToken', () => {
  it('sets revokedAt, replacedByJti, and lastUsedAt', async () => {
    await recordRefreshToken({ jti: 'jti-1', userId: 'u-1', token: 't', expiresAt: FUTURE });
    await revokeRefreshToken({ jti: 'jti-1', replacedByJti: 'jti-2' });
    const row = await db.collection('refresh_tokens').findOne({ jti: 'jti-1' });
    expect(row?.revokedAt).toBeInstanceOf(Date);
    expect(row?.replacedByJti).toBe('jti-2');
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('COR-11: does NOT write replacedByJti when omitted — preserves rotation-chain lineage', async () => {
    // An already-rotated row carrying its successor link.
    await recordRefreshToken({ jti: 'jti-1', userId: 'u-1', token: 't', expiresAt: FUTURE });
    await revokeRefreshToken({ jti: 'jti-1', replacedByJti: 'jti-successor' });
    // Logout revokes by jti with no successor. The update must leave
    // `replacedByJti` untouched, or the audit chain dead-ends (COR-11).
    await revokeRefreshToken({ jti: 'jti-1' });
    const row = await db.collection('refresh_tokens').findOne({ jti: 'jti-1' });
    expect(row?.replacedByJti).toBe('jti-successor');
    // Still a genuine revoke: the terminal marker + last-used stamp.
    expect(row?.revokedAt).toBeInstanceOf(Date);
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });
});

describe('findRefreshTokenRecord', () => {
  it('returns the raw row even when revoked (A2-1608 reuse-signal lookup)', async () => {
    // findLiveRefreshToken filters revoked rows out; the reuse
    // detector needs the raw record to distinguish "revoked → theft
    // signal" from "never existed → forged".
    await recordRefreshToken({
      jti: 'jti-1',
      userId: 'user-uuid',
      token: 'rotated-out-token',
      expiresAt: FUTURE,
    });
    await revokeRefreshToken({ jti: 'jti-1', replacedByJti: 'jti-2' });
    const r = await findRefreshTokenRecord('jti-1');
    expect(r?.revokedAt).toBeInstanceOf(Date);
    expect(r?.replacedByJti).toBe('jti-2');
  });

  it('returns null when the jti never existed (forged / cleaned-up token)', async () => {
    expect(await findRefreshTokenRecord('never-issued')).toBeNull();
  });
});

describe('tryRevokeIfLive', () => {
  it('CAS win: returns true when the conditional update revoked the row, stamping successor metadata', async () => {
    await recordRefreshToken({ jti: 'jti-old', userId: 'u-1', token: 't', expiresAt: FUTURE });
    const won = await tryRevokeIfLive({ jti: 'jti-old', replacedByJti: 'jti-new' });
    expect(won).toBe(true);
    const row = await db.collection('refresh_tokens').findOne({ jti: 'jti-old' });
    expect(row?.revokedAt).toBeInstanceOf(Date);
    expect(row?.replacedByJti).toBe('jti-new');
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('CAS lose: returns false when a concurrent rotation already revoked the row', async () => {
    await recordRefreshToken({ jti: 'jti-old', userId: 'u-1', token: 't', expiresAt: FUTURE });
    expect(await tryRevokeIfLive({ jti: 'jti-old', replacedByJti: 'jti-a' })).toBe(true);
    // The `revokedAt: null` predicate no longer matches — the second
    // rotation lost the race and must not clobber the first's link.
    expect(await tryRevokeIfLive({ jti: 'jti-old', replacedByJti: 'jti-b' })).toBe(false);
    const row = await db.collection('refresh_tokens').findOne({ jti: 'jti-old' });
    expect(row?.replacedByJti).toBe('jti-a');
  });

  it('allows replacedByJti to be omitted (null)', async () => {
    await recordRefreshToken({ jti: 'jti-old', userId: 'u-1', token: 't', expiresAt: FUTURE });
    const won = await tryRevokeIfLive({ jti: 'jti-old' });
    expect(won).toBe(true);
    const row = await db.collection('refresh_tokens').findOne({ jti: 'jti-old' });
    expect(row?.replacedByJti).toBeNull();
  });

  it('honours an explicit `now` for the revocation timestamp', async () => {
    const now = new Date('2026-06-11T00:00:00Z');
    await recordRefreshToken({ jti: 'jti-old', userId: 'u-1', token: 't', expiresAt: FUTURE });
    await tryRevokeIfLive({ jti: 'jti-old', now });
    const row = await db.collection('refresh_tokens').findOne({ jti: 'jti-old' });
    expect(row?.revokedAt).toEqual(now);
    expect(row?.lastUsedAt).toEqual(now);
  });
});

describe('revokeAllRefreshTokensForUser', () => {
  it('revokes every live refresh row AND bumps the user tokenVersion (NS-09)', async () => {
    await seedUser('user-uuid');
    await recordRefreshToken({ jti: 'jti-1', userId: 'user-uuid', token: 'a', expiresAt: FUTURE });
    await recordRefreshToken({ jti: 'jti-2', userId: 'user-uuid', token: 'b', expiresAt: FUTURE });
    // Another user's session must survive.
    await recordRefreshToken({ jti: 'jti-x', userId: 'other-user', token: 'c', expiresAt: FUTURE });

    await revokeAllRefreshTokensForUser('user-uuid');

    const mine = await db.collection('refresh_tokens').findMany({ userId: 'user-uuid' });
    expect(mine.every((r) => r.revokedAt instanceof Date)).toBe(true);
    const other = await db.collection('refresh_tokens').findOne({ jti: 'jti-x' });
    expect(other?.revokedAt).toBeNull();
    // NS-09: the access-token revocation half — the per-user counter
    // moved, so live access tokens die alongside the refresh tokens.
    const user = await db.collection('users').findOne({ id: 'user-uuid' });
    expect(user?.tokenVersion).toBe(1);
  });
});

describe('purgeDeadRefreshTokens', () => {
  const NOW = new Date('2026-07-01T00:00:00Z');
  const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

  it('reaps long-expired and long-revoked rows, returning the count', async () => {
    // Dead row 1: expired past the grace.
    await recordRefreshToken({
      jti: 'jti-dead-1',
      userId: 'u-1',
      token: 'a',
      expiresAt: new Date(NOW.getTime() - RETENTION_MS - 1000),
    });
    // Dead row 2: revoked past the grace (expiry still ahead).
    await recordRefreshToken({
      jti: 'jti-dead-2',
      userId: 'u-1',
      token: 'b',
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    await revokeRefreshToken({
      jti: 'jti-dead-2',
      now: new Date(NOW.getTime() - RETENTION_MS - 1000),
    });
    // Live row: neither expired nor revoked — never touched.
    await recordRefreshToken({
      jti: 'jti-live',
      userId: 'u-1',
      token: 'c',
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    // Recently-revoked row inside the grace: kept so a racing reuse
    // attempt still trips the family-wide revoke (A2-1608).
    await recordRefreshToken({
      jti: 'jti-recent',
      userId: 'u-1',
      token: 'd',
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    await revokeRefreshToken({ jti: 'jti-recent', now: new Date(NOW.getTime() - 1000) });

    const n = await purgeDeadRefreshTokens({ retentionMs: RETENTION_MS, now: NOW });
    expect(n).toBe(2);
    expect(await db.collection('refresh_tokens').findOne({ jti: 'jti-dead-1' })).toBeNull();
    expect(await db.collection('refresh_tokens').findOne({ jti: 'jti-dead-2' })).toBeNull();
    expect(await db.collection('refresh_tokens').findOne({ jti: 'jti-live' })).not.toBeNull();
    expect(await db.collection('refresh_tokens').findOne({ jti: 'jti-recent' })).not.toBeNull();
  });

  it('returns 0 when no dead rows were past the retention grace', async () => {
    const n = await purgeDeadRefreshTokens({ retentionMs: 1000 });
    expect(n).toBe(0);
  });
});
