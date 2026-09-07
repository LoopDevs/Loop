import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, __resetDbForTests } from '../client.js';
import { UniqueViolationError } from '../errors.js';
import {
  upsertUserFromCtx,
  getUserById,
  getUserCtxUserId,
  setUserCtxUserId,
  getUserTokenVersion,
  bumpUserTokenVersion,
  findOrCreateUserByEmail,
} from '../users.js';
import type { UserDoc } from '../types.js';

/**
 * Users repository, run against the real in-memory document store —
 * no mocks. `__resetDbForTests()` swaps in a fresh empty store per
 * test, so each case starts from an empty `users` collection.
 */
beforeEach(() => {
  __resetDbForTests();
});

/** Seeds a user doc directly, bypassing the repo under test. */
async function seedUser(overrides: Partial<UserDoc> = {}): Promise<UserDoc> {
  const now = new Date();
  const doc: UserDoc = {
    id: overrides.id ?? 'uuid-seed',
    ctxUserId: null,
    email: 'seed@b.com',
    tokenVersion: 0,
    homeCurrency: 'USD',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await db.collection('users').insertOne(doc);
  return doc;
}

describe('upsertUserFromCtx', () => {
  it('inserts a fresh row (with defaults) for an unknown CTX user id', async () => {
    const user = await upsertUserFromCtx({ ctxUserId: 'ctx-1', email: 'a@b.com' });
    expect(user.ctxUserId).toBe('ctx-1');
    expect(user.email).toBe('a@b.com');
    expect(user.tokenVersion).toBe(0);
    expect(user.homeCurrency).toBe('USD');
    // The row is really persisted, not just returned.
    const stored = await db.collection('users').findOne({ ctxUserId: 'ctx-1' });
    expect(stored?.id).toBe(user.id);
  });

  it('stores an empty-string email when the token carried none', async () => {
    const user = await upsertUserFromCtx({ ctxUserId: 'ctx-2', email: undefined });
    expect(user.email).toBe('');
  });

  it('returns the existing row (same id) on a repeat upsert', async () => {
    const first = await upsertUserFromCtx({ ctxUserId: 'ctx-3', email: 'a@b.com' });
    const second = await upsertUserFromCtx({ ctxUserId: 'ctx-3', email: 'a@b.com' });
    expect(second.id).toBe(first.id);
    expect(await db.collection('users').count({ ctxUserId: 'ctx-3' })).toBe(1);
  });

  it('refreshes the stored email only when the token actually carried one', async () => {
    await upsertUserFromCtx({ ctxUserId: 'ctx-4', email: '' });
    // Later request has the email claim → fix-up.
    const fixed = await upsertUserFromCtx({ ctxUserId: 'ctx-4', email: 'now@b.com' });
    expect(fixed.email).toBe('now@b.com');
    // A subsequent email-less token must NOT blank it back out.
    const kept = await upsertUserFromCtx({ ctxUserId: 'ctx-4', email: undefined });
    expect(kept.email).toBe('now@b.com');
  });
});

describe('getUserById', () => {
  it('returns the row when found', async () => {
    const seeded = await seedUser({ id: 'uuid-3' });
    const row = await getUserById('uuid-3');
    expect(row).toEqual(seeded);
  });

  it('returns null when no such user exists', async () => {
    expect(await getUserById('missing')).toBeNull();
  });
});

describe('getUserCtxUserId / setUserCtxUserId', () => {
  it('reads back the CTX mapping (null when unmapped, null for a missing user)', async () => {
    await seedUser({ id: 'uuid-c1', ctxUserId: null });
    expect(await getUserCtxUserId('uuid-c1')).toBeNull();
    expect(await getUserCtxUserId('missing')).toBeNull();
  });

  it('records the provisioned CTX id exactly once — first write wins', async () => {
    await seedUser({ id: 'uuid-c2', ctxUserId: null });
    expect(await setUserCtxUserId('uuid-c2', 'ctx-prov-1')).toBe(true);
    // A concurrent provision (or a legacy mapping) must never clobber.
    expect(await setUserCtxUserId('uuid-c2', 'ctx-prov-2')).toBe(false);
    expect(await getUserCtxUserId('uuid-c2')).toBe('ctx-prov-1');
  });

  it('returns false for a missing user', async () => {
    expect(await setUserCtxUserId('missing', 'ctx-x')).toBe(false);
  });
});

describe('NS-09: token-version counter', () => {
  it('reads the current counter, failing closed (null) for a missing user', async () => {
    await seedUser({ id: 'uuid-t1', tokenVersion: 3 });
    expect(await getUserTokenVersion('uuid-t1')).toBe(3);
    expect(await getUserTokenVersion('deleted-user')).toBeNull();
  });

  it('bumpUserTokenVersion increments atomically so all prior access tokens die', async () => {
    await seedUser({ id: 'uuid-t2', tokenVersion: 0 });
    await bumpUserTokenVersion('uuid-t2');
    await bumpUserTokenVersion('uuid-t2');
    expect(await getUserTokenVersion('uuid-t2')).toBe(2);
  });
});

describe('findOrCreateUserByEmail', () => {
  it('returns the existing row when the (normalised) email is already known', async () => {
    const seeded = await seedUser({ id: 'uuid-e1', email: 'a@b.com' });
    const user = await findOrCreateUserByEmail('A@B.COM');
    expect(user.id).toBe(seeded.id);
    expect(await db.collection('users').count()).toBe(1);
  });

  it('inserts a fresh row with a lowercased/trimmed email when unknown', async () => {
    const user = await findOrCreateUserByEmail('  New@B.com ');
    expect(user.email).toBe('new@b.com');
    expect(user.ctxUserId).toBeNull();
    expect(user.tokenVersion).toBe(0);
    const stored = await db.collection('users').findOne({ email: 'new@b.com' });
    expect(stored?.id).toBe(user.id);
  });

  it('A2-706: the losing side of a signup race re-selects the winner instead of throwing', async () => {
    // Concurrent-signup scenario: the pre-insert lookup misses, but by
    // the time this caller's insert lands the winner's row exists and
    // the insert trips the unique spec. Simulated by stubbing the
    // collection's insertOne to land the winner's row and then throw
    // the driver's UniqueViolationError — the repo must recover by
    // returning the winner's row, not surface the error.
    const users = db.collection('users');
    const realInsert = users.insertOne.bind(users);
    const insertSpy = vi.spyOn(users, 'insertOne').mockImplementationOnce(async () => {
      const now = new Date();
      await realInsert({
        id: 'uuid-winner',
        ctxUserId: null,
        email: 'raced@b.com',
        tokenVersion: 0,
        homeCurrency: 'USD',
        createdAt: now,
        updatedAt: now,
      });
      throw new UniqueViolationError('users', ['email']);
    });
    const user = await findOrCreateUserByEmail('raced@b.com');
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(user.id).toBe('uuid-winner');
    expect(await db.collection('users').count({ email: 'raced@b.com' })).toBe(1);
  });
});
