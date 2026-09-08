/**
 * Staff-role repo (ADR 037), run against the real in-memory document
 * store — no mocks.
 *
 * The cases that matter are the invariants the SQL version enforced
 * with a transaction and an advisory lock, and which now rest on
 * `db/keyed-lock.ts`:
 *
 *   - the last effective admin cannot be demoted or revoked, and
 *     "effective" spans BOTH sources (a `staff_roles` row and the
 *     `users.isAdmin` allowlist shim) — miscounting either way either
 *     locks everyone out or lets the final admin go;
 *   - every write mirrors the shim, so `requireStaff`'s fallback can
 *     never contradict the row;
 *   - two concurrent demotions cannot both pass the count.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db, __resetDbForTests } from '../client.js';
import type { UserDoc } from '../types.js';
import {
  getStaffRole,
  grantStaffRole,
  listStaffEntries,
  revokeStaffRole,
  LastAdminError,
  StaffRoleNotFoundError,
} from '../staff-roles.js';

beforeEach(() => {
  __resetDbForTests();
});

async function seedUser(id: string, isAdmin = false): Promise<UserDoc> {
  const now = new Date();
  const doc: UserDoc = {
    id,
    ctxUserId: null,
    email: `${id}@loop.test`,
    tokenVersion: 0,
    homeCurrency: 'USD',
    isAdmin,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection('users').insertOne(doc);
  return doc;
}

async function isAdminFlag(id: string): Promise<boolean | undefined> {
  return (await db.collection('users').findOne({ id }))?.isAdmin;
}

describe('grantStaffRole', () => {
  it('creates a row, mirrors the shim, and reports no prior role', async () => {
    await seedUser('actor', true);
    await seedUser('target');

    const applied = await grantStaffRole({
      userId: 'target',
      role: 'admin',
      grantedByUserId: 'actor',
      reason: 'ops onboarding',
    });

    expect(applied.priorRole).toBeNull();
    expect(await getStaffRole('target')).toMatchObject({
      userId: 'target',
      role: 'admin',
      grantedByUserId: 'actor',
      reason: 'ops onboarding',
    });
    expect(await isAdminFlag('target')).toBe(true);
  });

  it('re-granting replaces the row so the metadata describes the CURRENT grant', async () => {
    await seedUser('actor', true);
    await seedUser('target');
    await grantStaffRole({
      userId: 'target',
      role: 'admin',
      grantedByUserId: 'actor',
      reason: 'first',
    });
    const applied = await grantStaffRole({
      userId: 'target',
      role: 'support',
      grantedByUserId: 'actor',
      reason: 'second',
    });

    expect(applied.priorRole).toBe('admin');
    expect(await getStaffRole('target')).toMatchObject({ role: 'support', reason: 'second' });
    // Support is not admin — the shim has to follow the row down, or
    // requireStaff's fallback would keep letting them through.
    expect(await isAdminFlag('target')).toBe(false);
  });

  it('refuses to demote the final admin', async () => {
    await seedUser('only-admin', true);
    await grantStaffRole({
      userId: 'only-admin',
      role: 'admin',
      grantedByUserId: 'only-admin',
      reason: 'seed',
    });

    await expect(
      grantStaffRole({
        userId: 'only-admin',
        role: 'support',
        grantedByUserId: 'only-admin',
        reason: 'oops',
      }),
    ).rejects.toBeInstanceOf(LastAdminError);
    expect(await getStaffRole('only-admin')).toMatchObject({ role: 'admin' });
  });

  it('counts an allowlist-shim admin as an effective admin, so demoting a row-admin beside one is allowed', async () => {
    // The shim admin has no row at all — a count that only looked at
    // `staff_roles` would see one admin here and wrongly refuse.
    await seedUser('shim-admin', true);
    await seedUser('row-admin');
    await grantStaffRole({
      userId: 'row-admin',
      role: 'admin',
      grantedByUserId: 'shim-admin',
      reason: 'seed',
    });

    const applied = await grantStaffRole({
      userId: 'row-admin',
      role: 'support',
      grantedByUserId: 'shim-admin',
      reason: 'step down',
    });
    expect(applied.priorRole).toBe('admin');
  });
});

describe('revokeStaffRole', () => {
  it('deletes the row, clears the shim, and reports the prior role', async () => {
    await seedUser('actor', true);
    await seedUser('target');
    await grantStaffRole({
      userId: 'target',
      role: 'support',
      grantedByUserId: 'actor',
      reason: 'seed',
    });

    const applied = await revokeStaffRole({ userId: 'target' });

    expect(applied.priorRole).toBe('support');
    expect(await getStaffRole('target')).toBeNull();
    expect(await isAdminFlag('target')).toBe(false);
  });

  it('throws when the user holds no role at all', async () => {
    await seedUser('nobody');
    await expect(revokeStaffRole({ userId: 'nobody' })).rejects.toBeInstanceOf(
      StaffRoleNotFoundError,
    );
  });

  it('refuses to revoke the final admin', async () => {
    await seedUser('only-admin', true);
    await expect(revokeStaffRole({ userId: 'only-admin' })).rejects.toBeInstanceOf(LastAdminError);
    expect(await isAdminFlag('only-admin')).toBe(true);
  });

  it('serialises concurrent revokes so two admins cannot both pass the count', async () => {
    // Both callers see two admins if they read before either writes.
    // The lock is what makes the second one observe the first's
    // deletion and refuse.
    await seedUser('a', true);
    await seedUser('b', true);

    const results = await Promise.allSettled([
      revokeStaffRole({ userId: 'a' }),
      revokeStaffRole({ userId: 'b' }),
    ]);

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LastAdminError);
    // Exactly one admin survives — the invariant this all exists for.
    const remaining = await db.collection('users').findMany({ isAdmin: true });
    expect(remaining).toHaveLength(1);
  });
});

describe('listStaffEntries', () => {
  it('merges row holders with allowlist-shim admins and labels the source', async () => {
    await seedUser('grantor', true);
    await seedUser('rowed');
    await grantStaffRole({
      userId: 'rowed',
      role: 'support',
      grantedByUserId: 'grantor',
      reason: 'seed',
    });

    const entries = await listStaffEntries();

    expect(entries).toHaveLength(2);
    const rowed = entries.find((e) => e.userId === 'rowed');
    expect(rowed).toMatchObject({
      role: 'support',
      source: 'staff_roles',
      email: 'rowed@loop.test',
      grantedByUserId: 'grantor',
      // Resolved through the grantor's user row, not stored on the grant.
      grantedByEmail: 'grantor@loop.test',
    });
    expect(entries.find((e) => e.userId === 'grantor')).toMatchObject({
      role: 'admin',
      source: 'legacy_is_admin',
      grantedAt: null,
    });
  });

  it('does not double-count a shim admin who also holds a row', async () => {
    await seedUser('both', true);
    await grantStaffRole({
      userId: 'both',
      role: 'admin',
      grantedByUserId: 'both',
      reason: 'seed',
    });

    const entries = await listStaffEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ userId: 'both', source: 'staff_roles' });
  });
});
