/**
 * Staff-role repo (ADR 037).
 *
 * Read side: `getStaffRole` (the `requireStaff` resolver) +
 * `listStaffEntries` (the role-management list, including
 * legacy-shim admins that have no `staff_roles` row yet).
 *
 * Write side: `grantStaffRole` / `revokeStaffRole`. Both run inside
 * one transaction under a fixed advisory lock so the last-admin
 * invariant ("there is always at least one effective admin") cannot
 * be raced away by two concurrent demotions — the count and the
 * mutation are atomic with respect to every other staff-role write.
 *
 * Both writes also mirror the deprecated `users.is_admin` shim
 * (grant admin → true, grant support / revoke → false). Without the
 * mirror, revoking a Loop-native admin would be silently undone by
 * `requireStaff`'s legacy fallback. CTX-allowlist admins
 * (`ADMIN_CTX_USER_IDS`) are the documented exception: the CTX
 * upsert recomputes `is_admin` from env on their next request, so
 * revoking one of those also requires removing them from the env
 * allowlist (see docs/runbooks/staff-role-revocation.md).
 */
import { eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AdminStaffEntry, StaffRole } from '@loop/shared';
import { db } from './client.js';
import { staffRoles, users } from './schema.js';

/**
 * Fixed advisory-lock key serialising all staff-role writes.
 * Arbitrary constant in the signed-64-bit space; collisions with
 * the per-(admin, idempotency-key) locks from
 * `admin/idempotency.ts` only cause brief serialisation, never a
 * correctness bug.
 */
const STAFF_ROLES_WRITE_LOCK_KEY = 7_300_370_000_000_037n;

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

export interface StaffRoleRow {
  userId: string;
  role: StaffRole;
  grantedAt: Date;
  grantedByUserId: string | null;
  reason: string | null;
}

/** Looks up a user's `staff_roles` row. Null = no explicit grant. */
export async function getStaffRole(userId: string): Promise<StaffRoleRow | null> {
  const row = await db.query.staffRoles.findFirst({
    where: eq(staffRoles.userId, userId),
  });
  return row ?? null;
}

/**
 * Effective-admin predicate shared by the count and the list:
 * a `staff_roles` row wins when present; otherwise the deprecated
 * `users.is_admin` shim decides (ADR 037 §1).
 */
const effectiveRoleSql = sql<string | null>`
  CASE
    WHEN ${staffRoles.userId} IS NOT NULL THEN ${staffRoles.role}
    WHEN ${users.isAdmin} THEN 'admin'
    ELSE NULL
  END`;

/**
 * Every staff member — explicit `staff_roles` rows plus
 * legacy-shim admins (`is_admin` true, no row). Newest grant first;
 * legacy entries (no grant metadata) sort last.
 */
export async function listStaffEntries(): Promise<AdminStaffEntry[]> {
  const grantor = alias(users, 'grantor');
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      role: effectiveRoleSql,
      hasRow: sql<boolean>`${staffRoles.userId} IS NOT NULL`,
      grantedAt: staffRoles.grantedAt,
      grantedByUserId: staffRoles.grantedByUserId,
      grantedByEmail: grantor.email,
      reason: staffRoles.reason,
    })
    .from(users)
    .leftJoin(staffRoles, eq(staffRoles.userId, users.id))
    .leftJoin(grantor, eq(staffRoles.grantedByUserId, grantor.id))
    .where(sql`${staffRoles.userId} IS NOT NULL OR ${users.isAdmin}`)
    .orderBy(sql`${staffRoles.grantedAt} DESC NULLS LAST`, users.id);
  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    // The WHERE guarantees one of the CASE arms matched.
    role: (r.role ?? 'admin') as StaffRole,
    source: r.hasRow ? ('staff_roles' as const) : ('legacy_is_admin' as const),
    grantedAt: r.grantedAt?.toISOString() ?? null,
    grantedByUserId: r.grantedByUserId ?? null,
    grantedByEmail: r.grantedByEmail ?? null,
    reason: r.reason ?? null,
  }));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Effective admins remaining — staff row 'admin' OR legacy shim. */
async function countEffectiveAdmins(tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .leftJoin(staffRoles, eq(staffRoles.userId, users.id))
    .where(sql`COALESCE(${staffRoles.role} = 'admin', ${users.isAdmin})`);
  return row?.n ?? 0;
}

/** Effective role inside the locked txn — row wins, shim fallback. */
async function effectiveRoleInTx(tx: Tx, userId: string): Promise<StaffRole | null> {
  const [row] = await tx
    .select({ role: effectiveRoleSql })
    .from(users)
    .leftJoin(staffRoles, eq(staffRoles.userId, users.id))
    .where(eq(users.id, userId));
  if (row === undefined) return null;
  return (row.role as StaffRole | null) ?? null;
}

/**
 * Grant (or change) a staff role. Demoting the final effective
 * admin to 'support' throws `LastAdminError` — the check and the
 * write are atomic under the staff-write advisory lock.
 */
export async function grantStaffRole(args: {
  userId: string;
  role: StaffRole;
  grantedByUserId: string;
  reason: string;
}): Promise<{ priorRole: StaffRole | null; grantedAt: Date }> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${STAFF_ROLES_WRITE_LOCK_KEY})`);

    const priorRole = await effectiveRoleInTx(tx, args.userId);
    if (args.role === 'support' && priorRole === 'admin') {
      if ((await countEffectiveAdmins(tx)) <= 1) throw new LastAdminError();
    }

    const grantedAt = new Date();
    await tx
      .insert(staffRoles)
      .values({
        userId: args.userId,
        role: args.role,
        grantedAt,
        grantedByUserId: args.grantedByUserId,
        reason: args.reason,
      })
      .onConflictDoUpdate({
        target: staffRoles.userId,
        set: {
          role: args.role,
          grantedAt,
          grantedByUserId: args.grantedByUserId,
          reason: args.reason,
        },
      });
    // Mirror the deprecated shim so the legacy fallback agrees with
    // the table (see module docstring).
    await tx
      .update(users)
      .set({ isAdmin: args.role === 'admin', updatedAt: sql`NOW()` })
      .where(eq(users.id, args.userId));

    return { priorRole, grantedAt };
  });
}

/**
 * Revoke a user's staff role entirely. Throws
 * `StaffRoleNotFoundError` when the user holds no effective role
 * and `LastAdminError` when they are the final effective admin.
 */
export async function revokeStaffRole(args: { userId: string }): Promise<{ priorRole: StaffRole }> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${STAFF_ROLES_WRITE_LOCK_KEY})`);

    const priorRole = await effectiveRoleInTx(tx, args.userId);
    if (priorRole === null) throw new StaffRoleNotFoundError();
    if (priorRole === 'admin') {
      if ((await countEffectiveAdmins(tx)) <= 1) throw new LastAdminError();
    }

    await tx.delete(staffRoles).where(eq(staffRoles.userId, args.userId));
    await tx
      .update(users)
      .set({ isAdmin: false, updatedAt: sql`NOW()` })
      .where(eq(users.id, args.userId));

    return { priorRole };
  });
}
