/**
 * Staff-role wire shapes (ADR 037 — staff roles + support dashboard).
 *
 * The `staff_roles` table replaces the binary `users.isAdmin` trust
 * model with an audited role grant ('admin' ⊇ 'support'). Backend
 * emits these from `/api/admin/staff*`; web renders the role-management
 * surface and the role-aware admin shell. Lives in `@loop/shared` per
 * ADR 019 — both sides speak this contract and the shared-type-parity
 * gate holds them to one definition.
 */

/**
 * The two Phase-1 staff roles (ADR 037 §1). The table's CHECK
 * constraint allows future roles ('finance', 'operator') without a
 * migration — extend this union when they ship.
 */
export type StaffRole = 'admin' | 'support';

/** One row of `GET /api/admin/staff` — a current role grant. */
export interface AdminStaffMember {
  userId: string;
  email: string;
  role: StaffRole;
  grantedAt: string;
  /** Null for migration-seeded grants (no granting actor). */
  grantedByUserId: string | null;
  /** Null for migration-seeded grants. */
  reason: string | null;
}

/** `GET /api/admin/staff` */
export interface AdminStaffListResponse {
  staff: AdminStaffMember[];
}

/**
 * `PUT /api/admin/staff/:userId/role` result payload (inside the
 * ADR 017 `{ result, audit }` envelope) — the grant as written.
 */
export interface AdminStaffRoleSetResult {
  userId: string;
  role: StaffRole;
  grantedAt: string;
  grantedByUserId: string | null;
  reason: string | null;
}

/**
 * `DELETE /api/admin/staff/:userId/role` result payload (inside the
 * ADR 017 `{ result, audit }` envelope).
 */
export interface AdminStaffRoleRevokeResult {
  userId: string;
  revoked: boolean;
}
