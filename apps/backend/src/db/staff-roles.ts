/**
 * Staff-role repo (ADR 037).
 *
 * Read side: `getStaffRole` (the `requireStaff` resolver) +
 * `listStaffEntries` (the role-management list, including
 * allowlist-shim admins that have no `staff_roles` row yet).
 *
 * Write side: `grantStaffRole` / `revokeStaffRole`. Both run under a
 * single named lock (`db/keyed-lock.ts`) so the last-admin invariant
 * — "there is always at least one effective admin" — cannot be raced
 * away by two concurrent demotions: the count and the mutation are
 * indivisible with respect to every other staff-role write. This is
 * what `pg_advisory_xact_lock` inside a transaction used to do; see
 * `keyed-lock.ts` for what that swap costs.
 *
 * Both writes also mirror the deprecated `users.isAdmin` shim (grant
 * admin → true, grant support / revoke → false). Without the mirror,
 * revoking a Loop-native admin would be silently undone by
 * `requireStaff`'s fallback. Config-allowlist admins are the
 * documented exception: `admin.emails` / `admin.ctxUserIds` are
 * recomputed onto `isAdmin` at the next upsert, so revoking one of
 * those also means removing them from the config file and redeploying.
 */
import type { AdminStaffEntry, StaffRole } from '@loop/shared';
import { db } from './client.js';
import { withKeyedLock } from './keyed-lock.js';
import type { StaffRoleDoc, UserDoc } from './types.js';

/**
 * Every staff-role write serialises on this one key. The set is tiny
 * and the writes are rare, so a single global lock is simpler than a
 * per-user one — and a per-user lock would not protect the invariant
 * anyway, which is about the population, not one row.
 */
const STAFF_WRITE_LOCK = 'staff-roles';

/** Thrown when a write would leave zero effective admins. */
export class LastAdminError extends Error {
  constructor() {
    super('Refusing to remove the final admin');
    this.name = 'LastAdminError';
  }
}

/** Thrown when revoking a user that holds no staff role. */
export class StaffRoleNotFoundError extends Error {
  constructor() {
    super('User holds no staff role');
    this.name = 'StaffRoleNotFoundError';
  }
}

export type StaffRoleRow = StaffRoleDoc;

/** Looks up a user's `staff_roles` row. Null = no explicit grant. */
export async function getStaffRole(userId: string): Promise<StaffRoleRow | null> {
  return db.collection('staff_roles').findOne({ userId });
}

/**
 * Effective role for one user: a `staff_roles` row wins when present,
 * otherwise the deprecated `isAdmin` shim decides (ADR 037 §1).
 */
function effectiveRole(row: StaffRoleDoc | null, user: UserDoc | null): StaffRole | null {
  if (row !== null) return row.role;
  if (user !== null && user.isAdmin) return 'admin';
  return null;
}

/**
 * Every staff member — explicit `staff_roles` rows plus shim admins
 * (`isAdmin` true, no row). Newest grant first; shim entries carry no
 * grant metadata and sort last.
 */
export async function listStaffEntries(): Promise<AdminStaffEntry[]> {
  const [rows, shimAdmins] = await Promise.all([
    db.collection('staff_roles').findMany(),
    db.collection('users').findMany({ isAdmin: true }),
  ]);

  // Resolve every user the answer mentions in one pass: the row
  // holders, the shim admins, and whoever granted each row.
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

  // Newest grant first; shim entries (no grant metadata) last, then by
  // id so the order is stable across calls.
  entries.sort((a, b) => {
    if (a.grantedAt === null && b.grantedAt === null) return a.userId < b.userId ? -1 : 1;
    if (a.grantedAt === null) return 1;
    if (b.grantedAt === null) return -1;
    if (a.grantedAt !== b.grantedAt) return a.grantedAt < b.grantedAt ? 1 : -1;
    return a.userId < b.userId ? -1 : 1;
  });
  return entries;
}

/** Effective admins remaining — a row saying 'admin', or the shim. */
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
    // A row wins over the shim, and admin rows are already counted.
    if (!byUser.has(user.id)) n += 1;
  }
  return n;
}

/** Effective role inside the lock — row wins, shim fallback. */
async function effectiveRoleFor(userId: string): Promise<StaffRole | null> {
  const [row, user] = await Promise.all([
    db.collection('staff_roles').findOne({ userId }),
    db.collection('users').findOne({ id: userId }),
  ]);
  if (user === null) return null;
  return effectiveRole(row, user);
}

/** Keeps the deprecated shim in step with the row — see the docstring. */
async function mirrorIsAdmin(userId: string, isAdmin: boolean): Promise<void> {
  await db
    .collection('users')
    .updateOne({ id: userId }, { $set: { isAdmin, updatedAt: new Date() } });
}

/**
 * Grant (or change) a staff role. Demoting the final effective admin
 * to 'support' throws `LastAdminError` — the check and the write are
 * indivisible under the staff-write lock.
 */
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
    // Upsert: re-granting an existing member replaces their row
    // wholesale, so the grant metadata always describes the CURRENT
    // grant rather than the first one.
    await db.collection('staff_roles').replaceOne({ userId: args.userId }, doc, { upsert: true });
    await mirrorIsAdmin(args.userId, args.role === 'admin');

    return { priorRole, grantedAt };
  });
}

/**
 * Revoke a user's staff role entirely. Throws
 * `StaffRoleNotFoundError` when the user holds no effective role and
 * `LastAdminError` when they are the final effective admin.
 */
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
