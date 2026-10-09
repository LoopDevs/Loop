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
  resolveOrCreateUserByEmail,
  setUserIsAdmin,
  setUserHomeCurrency,
} from '../users.js';
import type { UserDoc } from '../types.js';

beforeEach(() => {
  __resetDbForTests();
});

async function seedUser(overrides: Partial<UserDoc> = {}): Promise<UserDoc> {
  const now = new Date();
  const doc: UserDoc = {
    id: overrides.id ?? 'uuid-seed',
    ctxUserId: null,
    email: 'seed@b.com',
    tokenVersion: 0,
    homeCurrency: 'USD',
    isAdmin: false,
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
    const fixed = await upsertUserFromCtx({ ctxUserId: 'ctx-4', email: 'now@b.com' });
    expect(fixed.email).toBe('now@b.com');
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
        isAdmin: false,
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

describe('setUserIsAdmin', () => {
  it('flips the flag and reports the change', async () => {
    await seedUser({ id: 'u-1' });
    expect(await setUserIsAdmin('u-1', true)).toBe(true);
    expect((await getUserById('u-1'))?.isAdmin).toBe(true);
    expect(await setUserIsAdmin('u-1', false)).toBe(true);
    expect((await getUserById('u-1'))?.isAdmin).toBe(false);
  });

  it('reports no change when the flag already matches', async () => {
    await seedUser({ id: 'u-1', isAdmin: true });
    expect(await setUserIsAdmin('u-1', true)).toBe(false);
    expect(await setUserIsAdmin('missing', true)).toBe(false);
  });
});

describe('setUserHomeCurrency', () => {
  it('writes the currency and reports the change', async () => {
    await seedUser({ id: 'u-1' });
    expect(await setUserHomeCurrency('u-1', 'EUR')).toBe(true);
    expect((await getUserById('u-1'))?.homeCurrency).toBe('EUR');
  });

  it('reports no change when the currency already matches', async () => {
    await seedUser({ id: 'u-1', homeCurrency: 'EUR' });
    expect(await setUserHomeCurrency('u-1', 'EUR')).toBe(false);
    expect(await setUserHomeCurrency('missing', 'EUR')).toBe(false);
  });
});

describe('admin flag across logins', () => {
  it('starts false for a new Loop-native user', async () => {
    const user = await findOrCreateUserByEmail('boss@loop.test');
    expect(user.isAdmin).toBe(false);
  });

  it('keeps the mirrored flag on the next login', async () => {
    const before = await findOrCreateUserByEmail('boss@loop.test');
    await setUserIsAdmin(before.id, true);
    const after = await findOrCreateUserByEmail('boss@loop.test');
    expect(after.id).toBe(before.id);
    expect(after.isAdmin).toBe(true);
  });

  it('keeps the mirrored flag on a CTX-path re-upsert', async () => {
    const created = await upsertUserFromCtx({ ctxUserId: 'ctx-boss', email: 'b@loop.test' });
    expect(created.isAdmin).toBe(false);
    await setUserIsAdmin(created.id, true);
    const refreshed = await upsertUserFromCtx({ ctxUserId: 'ctx-boss', email: 'b@loop.test' });
    expect(refreshed.isAdmin).toBe(true);
  });
});

describe('resolveOrCreateUserByEmail', () => {
  it('creates the row with the chosen country and reports it as created', async () => {
    const first = await resolveOrCreateUserByEmail('New@Example.com', 'gb');
    expect(first.created).toBe(true);
    expect(first.user.email).toBe('new@example.com');
    expect(first.user.country).toBe('GB');
    expect(first.user.homeCurrency).toBe('GBP');
  });

  it("derives the home currency from the country's display currency, USD when it has none", async () => {
    expect((await resolveOrCreateUserByEmail('pt@example.com', 'PT')).user.homeCurrency).toBe(
      'EUR',
    );
    expect((await resolveOrCreateUserByEmail('ca@example.com', 'CA')).user.homeCurrency).toBe(
      'USD',
    );
    expect((await resolveOrCreateUserByEmail('iq@example.com', 'IQ')).user.homeCurrency).toBe(
      'USD',
    );
  });

  it('returns the existing row untouched and reports it as not created', async () => {
    const first = await resolveOrCreateUserByEmail('again@example.com', 'GB');
    const second = await resolveOrCreateUserByEmail('again@example.com', 'PT');
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.country).toBe('GB');
  });

  it('leaves the country unset when the caller has none', async () => {
    const { user } = await resolveOrCreateUserByEmail('bare@example.com');
    expect(user.country).toBeUndefined();
    expect(user.homeCurrency).toBe('USD');
  });
});
