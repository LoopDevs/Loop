import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, __resetDbForTests } from '../../db/client.js';
import type { UserDoc, UserIdentityDoc } from '../../db/types.js';

const signInByEmailMock = vi.fn();
const signInByIdMock = vi.fn();
vi.mock('../ctx-login.js', () => ({
  signInCtxUserByEmail: (email: string, country?: string) => signInByEmailMock(email, country),
  signInCtxUserById: (id: string) => signInByIdMock(id),
}));

import { signInUserForIdentity, listLinkedIdentities } from '../identities.js';

beforeEach(() => {
  __resetDbForTests();
  signInByEmailMock.mockReset();
  signInByIdMock.mockReset();
});

function ctxUser(overrides: Partial<UserDoc> = {}): UserDoc {
  const now = new Date();
  return {
    id: 'u-seed',
    email: 'seed@b.com',
    status: 'enabled',
    tokenVersion: 0,
    stableCurrency: 'XLM.USDC',
    isAdmin: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function seedIdentity(overrides: Partial<UserIdentityDoc> = {}): Promise<UserIdentityDoc> {
  const doc: UserIdentityDoc = {
    id: overrides.id ?? 'ident-seed',
    userId: 'u-seed',
    provider: 'google',
    providerSub: 'sub-seed',
    emailAtLink: 'seed@b.com',
    createdAt: new Date(),
    ...overrides,
  };
  await db.collection('user_identities').insertOne(doc);
  return doc;
}

describe('signInUserForIdentity', () => {
  it('signs a known (provider, sub) in by its linked CTX user id', async () => {
    await seedIdentity({ userId: 'u-1', provider: 'google', providerSub: 'sub-1' });
    signInByIdMock.mockResolvedValue(ctxUser({ id: 'u-1', email: 'a@b.com' }));
    const out = await signInUserForIdentity({
      provider: 'google',
      providerSub: 'sub-1',
      email: 'a@b.com',
    });
    expect(out.created).toBe(false);
    expect(out.user.id).toBe('u-1');
    expect(signInByIdMock).toHaveBeenCalledWith('u-1');
    expect(signInByEmailMock).not.toHaveBeenCalled();
    expect(await db.collection('user_identities').count()).toBe(1);
  });

  it('signs an unknown identity in by its normalised email and links it to the CTX user', async () => {
    signInByEmailMock.mockResolvedValue({
      user: ctxUser({ id: 'ctx-2', email: 'fresh@b.com' }),
      created: true,
    });
    const out = await signInUserForIdentity({
      provider: 'apple',
      providerSub: 'apple-sub',
      email: 'Fresh@B.com',
      country: 'GB',
    });
    expect(out.created).toBe(true);
    expect(out.user.id).toBe('ctx-2');
    expect(signInByEmailMock).toHaveBeenCalledWith('fresh@b.com', 'GB');
    const link = await db
      .collection('user_identities')
      .findOne({ provider: 'apple', providerSub: 'apple-sub' });
    expect(link?.userId).toBe('ctx-2');
    expect(link?.emailAtLink).toBe('fresh@b.com');
  });

  it('propagates a CTX refusal without linking the identity', async () => {
    signInByEmailMock.mockRejectedValue(new Error('refused'));
    await expect(
      signInUserForIdentity({ provider: 'google', providerSub: 'sub-x', email: 'x@b.com' }),
    ).rejects.toThrow('refused');
    expect(await db.collection('user_identities').count()).toBe(0);
  });

  it('parallel-login race — the duplicate identity insert no-ops instead of failing the login', async () => {
    signInByEmailMock.mockImplementation(async () => {
      await seedIdentity({ id: 'ident-winner', userId: 'u-race', providerSub: 'sub-race' });
      return { user: ctxUser({ id: 'u-race', email: 'race@b.com' }), created: false };
    });
    const out = await signInUserForIdentity({
      provider: 'google',
      providerSub: 'sub-race',
      email: 'race@b.com',
    });
    expect(out.user.id).toBe('u-race');
    expect(await db.collection('user_identities').count({ providerSub: 'sub-race' })).toBe(1);
  });

  it('A2-2002: rejects a non-ASCII (homograph-capable) provider email', async () => {
    await expect(
      signInUserForIdentity({
        provider: 'google',
        providerSub: 'sub-h',
        // Cyrillic 'а' in place of Latin 'a'.
        email: 'паypal@b.com',
      }),
    ).rejects.toThrow();
    expect(signInByEmailMock).not.toHaveBeenCalled();
    expect(await db.collection('user_identities').count()).toBe(0);
  });
});

describe('listLinkedIdentities', () => {
  it('returns the linked providers for a user', async () => {
    await seedIdentity({
      id: 'ident-1',
      userId: 'u-1',
      provider: 'google',
      providerSub: 'sub-1',
      emailAtLink: 'a@b.com',
      createdAt: new Date('2026-04-21T00:00:00Z'),
    });
    await seedIdentity({ id: 'ident-2', userId: 'u-other', providerSub: 'sub-other' });
    const rows = await listLinkedIdentities('u-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('google');
    expect(rows[0]!.providerSub).toBe('sub-1');
    expect(rows[0]!.emailAtLink).toBe('a@b.com');
    expect(rows[0]!.createdAt).toEqual(new Date('2026-04-21T00:00:00Z'));
  });

  it('returns an empty array when the user has no linked identities', async () => {
    const rows = await listLinkedIdentities('u-empty');
    expect(rows).toEqual([]);
  });
});
