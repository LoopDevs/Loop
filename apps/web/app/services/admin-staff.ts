/**
 * Admin staff-roles surface (ADR 037 §1/§5 — role management).
 *
 * One read + two step-up-gated writes over `/api/admin/staff*`:
 *
 * - `GET /api/admin/staff` — current grants, newest first.
 * - `PUT /api/admin/staff/:userId/role` — grant or change a role.
 *   Admin-only + step-up gated exactly like credit adjustments
 *   (ADR 028); carries the full ADR 017 envelope (idempotency,
 *   2..500 char reason, Discord audit).
 * - `DELETE /api/admin/staff/:userId/role` — revoke. Same gating +
 *   envelope. Role changes take effect within the 15-min token TTL
 *   (ADR 037 §2).
 *
 * Wire shapes live in `@loop/shared/staff-roles.ts` (ADR 019) —
 * the backend sibling (`feat/staff-roles-backend`) emits them.
 */
import type {
  AdminStaffListResponse,
  AdminStaffRoleRevokeResult,
  AdminStaffRoleSetResult,
  StaffRole,
} from '@loop/shared';
import { generateIdempotencyKey, type AdminWriteEnvelope } from './admin-write-envelope';
import { authenticatedRequest } from './api-client';

/** `GET /api/admin/staff` — every current role grant. */
export async function listAdminStaff(): Promise<AdminStaffListResponse> {
  return authenticatedRequest<AdminStaffListResponse>('/api/admin/staff');
}

/**
 * `PUT /api/admin/staff/:userId/role` — grant (or change) a staff
 * role. Step-up gated; idempotent on the browser-generated key.
 */
export async function setStaffRole(args: {
  userId: string;
  role: StaffRole;
  reason: string;
}): Promise<AdminWriteEnvelope<AdminStaffRoleSetResult>> {
  return authenticatedRequest<AdminWriteEnvelope<AdminStaffRoleSetResult>>(
    `/api/admin/staff/${encodeURIComponent(args.userId)}/role`,
    {
      method: 'PUT',
      headers: { 'Idempotency-Key': generateIdempotencyKey() },
      body: { role: args.role, reason: args.reason },
      // ADR-028 / ADR 037: role grants gate behind step-up like the
      // money writes — a stolen admin token must not mint admins.
      withStepUp: true,
    },
  );
}

/**
 * `DELETE /api/admin/staff/:userId/role` — revoke the grant. Step-up
 * gated; the reason lands in the audit row.
 */
export async function revokeStaffRole(args: {
  userId: string;
  reason: string;
}): Promise<AdminWriteEnvelope<AdminStaffRoleRevokeResult>> {
  return authenticatedRequest<AdminWriteEnvelope<AdminStaffRoleRevokeResult>>(
    `/api/admin/staff/${encodeURIComponent(args.userId)}/role`,
    {
      method: 'DELETE',
      headers: { 'Idempotency-Key': generateIdempotencyKey() },
      body: { reason: args.reason },
      withStepUp: true,
    },
  );
}
