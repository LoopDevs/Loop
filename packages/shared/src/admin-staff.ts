/**
 * Staff-role wire shapes (ADR 037).
 *
 * The `staff_roles` table replaces the binary `users.is_admin`
 * trust model: 'admin' keeps everything (money writes still
 * step-up-gated per ADR 028); 'support' gets the read views plus
 * the three delivery-unsticking actions and a 404 on everything
 * else. Lives in `@loop/shared` per ADR 019 — the role is on the
 * wire (`GET /api/admin/staff`, grant/revoke envelopes) so web +
 * backend + openapi compile against one definition.
 */

/** Runtime enum — pinned to the `staff_roles_role_known` DB CHECK. */
export const STAFF_ROLES = ['admin', 'support'] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * One staff member in `GET /api/admin/staff`.
 *
 * `source` distinguishes a real `staff_roles` row from the
 * deprecated `users.is_admin` shim (a CTX-allowlist admin who has
 * no row yet — ADR 037 §1). Legacy entries have no grant metadata.
 */
export interface AdminStaffEntry {
  userId: string;
  email: string;
  role: StaffRole;
  source: 'staff_roles' | 'legacy_is_admin';
  /** ISO-8601; null for `legacy_is_admin` entries. */
  grantedAt: string | null;
  /** Null for the migration-0039 seed rows and legacy entries. */
  grantedByUserId: string | null;
  /** Grantor's email when resolvable; null otherwise. */
  grantedByEmail: string | null;
  reason: string | null;
}

/** `GET /api/admin/staff` */
export interface AdminStaffListResponse {
  staff: AdminStaffEntry[];
}

/** `result` half of the PUT /api/admin/staff/:userId/role envelope. */
export interface AdminStaffGrantResult {
  userId: string;
  role: StaffRole;
  /** Role before this write; null when the user was not staff. */
  priorRole: StaffRole | null;
  grantedAt: string;
}

/** `result` half of the DELETE /api/admin/staff/:userId/role envelope. */
export interface AdminStaffRevokeResult {
  userId: string;
  /** Role the revoke removed. */
  priorRole: StaffRole;
}
