import { describe, it, expect, beforeEach, vi } from 'vitest';

import { db, __resetDbForTests } from '../client.js';
import { UniqueViolationError } from '../errors.js';
import {
  getUserById,
  getUserTokenVersion,
  bumpUserTokenVersion,
  cacheCtxUser,
  type CtxUser,
} from '../users.js';
import type { UserDoc } from '../types.js';

beforeEach(() => {
  __resetDbForTests();
});

async function seedUser(overrides: Partial<UserDoc> = {}): Promise<UserDoc> {
  const now = new Date();
  const doc: UserDoc = {
    id: overrides.id ?? 'uuid-seed',
    email: 'seed@b.com',
    status: 'enabled',
    tokenVersion: 0,
    stableCurrency: 'XLM.USDC',
    isAdmin: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await db.collection('users').insertOne(doc);
  return doc;
}

function ctxUser(overrides: Partial<CtxUser> = {}): CtxUser {
  return {
    id: 'ctx-1',
    email: 'a@b.com',
    status: 'enabled',
    isAdmin: false,
    stableCurrency: 'XLM.USDC',
    cashbackDestination: 'account',
    country: null,
    ...overrides,
  };
}

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

describe('cacheCtxUser', () => {
  it('inserts a row keyed by the CTX user id with token version 0 and reports it as created', async () => {
    const { user, created } = await cacheCtxUser(ctxUser({ country: 'GB' }));
    expect(created).toBe(true);
    expect(user).toMatchObject({
      id: 'ctx-1',
      email: 'a@b.com',
      status: 'enabled',
      tokenVersion: 0,
      stableCurrency: 'XLM.USDC',
      country: 'GB',
    });
    expect(await getUserById('ctx-1')).toEqual(user);
  });

  it('leaves the country unset when CTX has none', async () => {
    const { user } = await cacheCtxUser(ctxUser());
    expect(user.country).toBeUndefined();
  });

  it('overwrites the CTX-owned fields on a repeat and keeps the token version', async () => {
    await seedUser({ id: 'ctx-1', tokenVersion: 4, country: 'GB' });
    const { user, created } = await cacheCtxUser(
      ctxUser({
        email: 'new@b.com',
        status: 'suspended',
        isAdmin: true,
        stableCurrency: 'XLM.EURC',
        cashbackDestination: 'savings',
        country: 'PT',
      }),
    );
    expect(created).toBe(false);
    expect(user).toMatchObject({
      id: 'ctx-1',
      email: 'new@b.com',
      status: 'suspended',
      isAdmin: true,
      stableCurrency: 'XLM.EURC',
      cashbackDestination: 'savings',
      country: 'PT',
      tokenVersion: 4,
    });
    expect(await db.collection('users').count({ id: 'ctx-1' })).toBe(1);
  });

  it('keeps the cached country when CTX has none', async () => {
    await seedUser({ id: 'ctx-1', country: 'GB' });
    const { user } = await cacheCtxUser(ctxUser({ country: null }));
    expect(user.country).toBe('GB');
  });

  it('applies the CTX fields onto the winning row when a concurrent insert races it', async () => {
    const users = db.collection('users');
    const realInsert = users.insertOne.bind(users);
    const insertSpy = vi.spyOn(users, 'insertOne').mockImplementationOnce(async () => {
      const now = new Date();
      await realInsert({
        id: 'ctx-1',
        email: 'a@b.com',
        status: 'enabled',
        tokenVersion: 2,
        stableCurrency: '',
        isAdmin: false,
        createdAt: now,
        updatedAt: now,
      });
      throw new UniqueViolationError('users', ['id']);
    });
    const { user, created } = await cacheCtxUser(ctxUser({ isAdmin: true }));
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(created).toBe(false);
    expect(user).toMatchObject({ id: 'ctx-1', isAdmin: true, tokenVersion: 2 });
    expect(await users.count({ id: 'ctx-1' })).toBe(1);
  });
});
