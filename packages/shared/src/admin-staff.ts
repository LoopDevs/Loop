/**
 * Staff-role wire shapes (ADR 037).
 *
 * The `staff_roles` collection replaces the binary `users.isAdmin`
 * trust model: 'admin' keeps everything (money writes still
 * step-up-gated per ADR 028); 'support' gets the read views plus
 * the three delivery-unsticking actions and a 404 on everything
 * else. Lives in `@loop/shared` per ADR 019 — the role is on the
 * wire (`GET /api/admin/staff`, grant/revoke envelopes) so web +
 * backend + openapi compile against one definition.
 */

/** Runtime enum — the accepted values of a `staff_roles` row's role. */
export const STAFF_ROLES = ['admin', 'support'] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * One staff member in `GET /api/admin/staff`.
 *
 * `source` distinguishes a real `staff_roles` row from the
 * `users.isAdmin` mirror of the CTX operator-admin role (an admin who
 * has no row — ADR 037 §1). Mirror entries have no grant metadata.
 */
export interface AdminStaffEntry {
  userId: string;
  email: string;
  role: StaffRole;
  source: 'staff_roles' | 'ctx_operator_admin';
  /** ISO-8601; null for `ctx_operator_admin` entries. */
  grantedAt: string | null;
  /** Null for mirror entries, which nobody granted in Loop. */
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
