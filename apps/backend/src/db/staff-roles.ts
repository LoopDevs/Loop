// Staff-role repo — ADR 037
import type { AdminStaffEntry, StaffRole } from '@loop/shared';
import { db } from './client.js';
import { withKeyedLock } from './keyed-lock.js';
import type { StaffRoleDoc, UserDoc } from './types.js';

// Single global lock: per-user lock wouldn't protect the population-level invariant
const STAFF_WRITE_LOCK = 'staff-roles';

export class LastAdminError extends Error {
  constructor() {
    super('Refusing to remove the final admin');
    this.name = 'LastAdminError';
  }
}

export class StaffRoleNotFoundError extends Error {
  constructor() {
    super('User holds no staff role');
    this.name = 'StaffRoleNotFoundError';
  }
}

export type StaffRoleRow = StaffRoleDoc;

export async function getStaffRole(userId: string): Promise<StaffRoleRow | null> {
  return db.collection('staff_roles').findOne({ userId });
}

function effectiveRole(row: StaffRoleDoc | null, user: UserDoc | null): StaffRole | null {
  if (row !== null) return row.role;
  if (user !== null && user.isAdmin) return 'admin';
  return null;
}

export async function listStaffEntries(): Promise<AdminStaffEntry[]> {
  const [rows, shimAdmins] = await Promise.all([
    db.collection('staff_roles').findMany(),
    db.collection('users').findMany({ isAdmin: true }),
  ]);

  const wanted = new Set<string>();
  for (const row of rows) {
    wanted.add(row.userId);
    if (row.grantedByUserId !== null) wanted.add(row.grantedByUserId);
  }
  const byId = new Map<string, UserDoc>();
  for (const user of shimAdmins) {
    byId.set(user.id, user);
    wanted.delete(user.id);
  }
  const fetched = await Promise.all(
    [...wanted].map(async (id) => db.collection('users').findOne({ id })),
  );
  for (const user of fetched) {
    if (user !== null) byId.set(user.id, user);
  }

  const entries: AdminStaffEntry[] = rows.map((row) => ({
    userId: row.userId,
    email: byId.get(row.userId)?.email ?? '',
    role: row.role,
    source: 'staff_roles' as const,
    grantedAt: row.grantedAt.toISOString(),
    grantedByUserId: row.grantedByUserId,
    grantedByEmail:
      row.grantedByUserId !== null ? (byId.get(row.grantedByUserId)?.email ?? null) : null,
    reason: row.reason,
  }));

  const hasRow = new Set(rows.map((r) => r.userId));
  for (const user of shimAdmins) {
    if (hasRow.has(user.id)) continue;
    entries.push({
      userId: user.id,
      email: user.email,
      role: 'admin',
      source: 'legacy_is_admin',
      grantedAt: null,
      grantedByUserId: null,
      grantedByEmail: null,
      reason: null,
    });
  }

  entries.sort((a, b) => {
    if (a.grantedAt === null && b.grantedAt === null) return a.userId < b.userId ? -1 : 1;
    if (a.grantedAt === null) return 1;
    if (b.grantedAt === null) return -1;
    if (a.grantedAt !== b.grantedAt) return a.grantedAt < b.grantedAt ? 1 : -1;
    return a.userId < b.userId ? -1 : 1;
  });
  return entries;
}

async function countEffectiveAdmins(): Promise<number> {
  const [rows, shimAdmins] = await Promise.all([
    db.collection('staff_roles').findMany(),
    db.collection('users').findMany({ isAdmin: true }),
  ]);
  const byUser = new Map(rows.map((r) => [r.userId, r.role]));
  let n = 0;
  for (const [, role] of byUser) {
    if (role === 'admin') n += 1;
  }
  for (const user of shimAdmins) {
    if (!byUser.has(user.id)) n += 1;
  }
  return n;
}

async function effectiveRoleFor(userId: string): Promise<StaffRole | null> {
  const [row, user] = await Promise.all([
    db.collection('staff_roles').findOne({ userId }),
    db.collection('users').findOne({ id: userId }),
  ]);
  if (user === null) return null;
  return effectiveRole(row, user);
}

async function mirrorIsAdmin(userId: string, isAdmin: boolean): Promise<void> {
  await db
    .collection('users')
    .updateOne({ id: userId }, { $set: { isAdmin, updatedAt: new Date() } });
}

export async function grantStaffRole(args: {
  userId: string;
  role: StaffRole;
  grantedByUserId: string;
  reason: string;
}): Promise<{ priorRole: StaffRole | null; grantedAt: Date }> {
  return await withKeyedLock(STAFF_WRITE_LOCK, async () => {
    const priorRole = await effectiveRoleFor(args.userId);
    if (args.role === 'support' && priorRole === 'admin') {
      if ((await countEffectiveAdmins()) <= 1) throw new LastAdminError();
    }

    const grantedAt = new Date();
    const doc: StaffRoleDoc = {
      userId: args.userId,
      role: args.role,
      grantedAt,
      grantedByUserId: args.grantedByUserId,
      reason: args.reason,
    };
    await db.collection('staff_roles').replaceOne({ userId: args.userId }, doc, { upsert: true });
    await mirrorIsAdmin(args.userId, args.role === 'admin');

    return { priorRole, grantedAt };
  });
}

export async function revokeStaffRole(args: { userId: string }): Promise<{ priorRole: StaffRole }> {
  return await withKeyedLock(STAFF_WRITE_LOCK, async () => {
    const priorRole = await effectiveRoleFor(args.userId);
    if (priorRole === null) throw new StaffRoleNotFoundError();
    if (priorRole === 'admin') {
      if ((await countEffectiveAdmins()) <= 1) throw new LastAdminError();
    }

    await db.collection('staff_roles').deleteMany({ userId: args.userId });
    await mirrorIsAdmin(args.userId, false);

    return { priorRole };
  });
}
