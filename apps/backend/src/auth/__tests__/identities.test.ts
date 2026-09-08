import { describe, it, expect, beforeEach } from 'vitest';
import { db, __resetDbForTests } from '../../db/client.js';
import type { UserDoc, UserIdentityDoc } from '../../db/types.js';
import { resolveOrCreateUserForIdentity, listLinkedIdentities } from '../identities.js';

/**
 * Social-provider identity linking (ADR 014), exercised against the
 * real in-memory document store — the (provider, providerSub) unique
 * spec and the three-step resolution both run for real, no mocks.
 */
beforeEach(() => {
  __resetDbForTests();
});

async function seedUser(overrides: Partial<UserDoc> = {}): Promise<UserDoc> {
  const now = new Date();
  const doc: UserDoc = {
    id: overrides.id ?? 'u-seed',
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

describe('resolveOrCreateUserForIdentity', () => {
  it('step 1 — known (provider, sub) → returns the existing user, no writes', async () => {
    await seedUser({ id: 'u-1', email: 'a@b.com' });
    await seedIdentity({ userId: 'u-1', provider: 'google', providerSub: 'sub-1' });
    const out = await resolveOrCreateUserForIdentity({
      provider: 'google',
      providerSub: 'sub-1',
      email: 'a@b.com',
    });
    expect(out.created).toBe(false);
    expect(out.user.id).toBe('u-1');
    // No extra rows created.
    expect(await db.collection('users').count()).toBe(1);
    expect(await db.collection('user_identities').count()).toBe(1);
  });

  it('step 2 — unknown identity, known email → links provider to the existing user', async () => {
    await seedUser({ id: 'u-2', email: 'same@b.com' });
    const out = await resolveOrCreateUserForIdentity({
      provider: 'google',
      providerSub: 'sub-new',
      email: 'SAME@B.COM',
    });
    expect(out.created).toBe(false);
    expect(out.user.id).toBe('u-2');
    // The link row was written — with the normalised (lower-cased) email.
    const link = await db
      .collection('user_identities')
      .findOne({ provider: 'google', providerSub: 'sub-new' });
    expect(link).not.toBeNull();
    expect(link?.userId).toBe('u-2');
    expect(link?.emailAtLink).toBe('same@b.com');
    // No shadow-duplicate user.
    expect(await db.collection('users').count()).toBe(1);
  });

  it('step 3 — unknown both → creates a fresh user + link (created=true)', async () => {
    const out = await resolveOrCreateUserForIdentity({
      provider: 'apple',
      providerSub: 'apple-sub',
      email: 'Fresh@B.com',
    });
    expect(out.created).toBe(true);
    // Lower-cased email on both the user row and the link row.
    expect(out.user.email).toBe('fresh@b.com');
    const storedUser = await db.collection('users').findOne({ email: 'fresh@b.com' });
    expect(storedUser?.id).toBe(out.user.id);
    const link = await db
      .collection('user_identities')
      .findOne({ provider: 'apple', providerSub: 'apple-sub' });
    expect(link?.userId).toBe(out.user.id);
    expect(link?.emailAtLink).toBe('fresh@b.com');
  });

  it('step 1 but the user row is missing — dangling identity drops through to a fresh user', async () => {
    // Identity row survives a user deletion (ops-grade edge case).
    await seedIdentity({ userId: 'u-dead', provider: 'google', providerSub: 'sub-dangling' });
    const out = await resolveOrCreateUserForIdentity({
      provider: 'google',
      providerSub: 'sub-dangling',
      email: 'z@b.com',
    });
    expect(out.created).toBe(true);
    expect(out.user.email).toBe('z@b.com');
    expect(out.user.id).not.toBe('u-dead');
  });

  it('parallel-login race — the duplicate identity insert no-ops instead of failing the login', async () => {
    // A second simultaneous login for the same (provider, sub) reaches
    // linkIdentity after the winner's row exists: the unique-spec
    // violation must be swallowed and the login succeed.
    await seedUser({ id: 'u-race', email: 'race@b.com' });
    await seedIdentity({ userId: 'u-race', provider: 'google', providerSub: 'sub-race' });
    // Delete no users: the email lookup (step 2) hits u-race but the
    // identity insert collides with the seeded row.
    const out = await resolveOrCreateUserForIdentity({
      provider: 'google',
      providerSub: 'sub-race',
      email: 'race@b.com',
    });
    expect(out.user.id).toBe('u-race');
    expect(await db.collection('user_identities').count({ providerSub: 'sub-race' })).toBe(1);
  });

  it('A2-2002: rejects a non-ASCII (homograph-capable) provider email', async () => {
    await expect(
      resolveOrCreateUserForIdentity({
        provider: 'google',
        providerSub: 'sub-h',
        // Cyrillic 'а' in place of Latin 'a'.
        email: 'паypal@b.com',
      }),
    ).rejects.toThrow();
    // Nothing was persisted.
    expect(await db.collection('users').count()).toBe(0);
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
    // Another user's link must not leak into the listing.
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
