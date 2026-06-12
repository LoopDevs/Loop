/**
 * Staff role-management OpenAPI registrations (ADR 037 §1).
 *
 * Three paths — `GET /api/admin/staff`, `PUT` + `DELETE`
 * `/api/admin/staff/{userId}/role`. The writes carry the ADR 017
 * envelope + the ADR 028 step-up header, mirroring
 * `./admin-user-writes.ts` (the closest sibling write surface).
 * Wire shapes live in `@loop/shared/admin-staff`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

export function registerAdminStaffOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminWriteAudit: ReturnType<OpenAPIRegistry['register']>,
): void {
  const StaffRole = z.enum(['admin', 'support']);

  const AdminStaffEntry = registry.register(
    'AdminStaffEntry',
    z.object({
      userId: z.string().uuid(),
      email: z.string(),
      role: StaffRole,
      source: z.enum(['staff_roles', 'legacy_is_admin']).openapi({
        description:
          'Where the role came from: a real staff_roles row, or the deprecated users.is_admin shim (CTX-allowlist admin with no row yet — ADR 037 §1). Legacy entries carry no grant metadata.',
      }),
      grantedAt: z.string().datetime().nullable(),
      grantedByUserId: z.string().uuid().nullable().openapi({
        description: 'Null for migration-0039 seed rows and legacy entries.',
      }),
      grantedByEmail: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  );

  const AdminStaffListResponse = registry.register(
    'AdminStaffListResponse',
    z.object({ staff: z.array(AdminStaffEntry) }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/staff',
    summary: 'List staff members with grant metadata (ADR 037).',
    description:
      'Every staff_roles row plus legacy users.is_admin admins that predate a row (`source: legacy_is_admin`). Admin-tier — who holds power is itself sensitive; support gets the uniform 404.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Staff list, newest grant first',
        content: { 'application/json': { schema: AdminStaffListResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not an admin (staff-tier concealment)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const StaffGrantBody = registry.register(
    'AdminStaffGrantBody',
    z.object({
      role: StaffRole,
      reason: z.string().min(2).max(500),
    }),
  );
  const StaffGrantResult = registry.register(
    'AdminStaffGrantResult',
    z.object({
      userId: z.string().uuid(),
      role: StaffRole,
      priorRole: StaffRole.nullable(),
      grantedAt: z.string().datetime(),
    }),
  );
  const StaffGrantEnvelope = registry.register(
    'AdminStaffGrantEnvelope',
    z.object({ result: StaffGrantResult, audit: adminWriteAudit }),
  );

  const writeHeaders = z.object({
    'idempotency-key': z.string().min(16).max(128).openapi({
      description: 'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
    }),
    'x-admin-step-up': z.string().openapi({
      description: 'ADR-028 step-up JWT minted by `POST /api/admin/step-up`. 5-minute TTL.',
    }),
  });

  registry.registerPath({
    method: 'put',
    path: '/api/admin/staff/{userId}/role',
    summary: 'Grant or change a staff role (ADR 037).',
    description:
      "Upserts the user's staff_roles row and mirrors the deprecated users.is_admin shim. Refuses to demote the final effective admin (`STAFF_LAST_ADMIN`) and to demote your own admin role (`STAFF_SELF_REVOKE`). ADR-017 admin-write contract + ADR-028 step-up gate. Role changes take effect within the 15-min access-token TTL.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      headers: writeHeaders,
      body: { content: { 'application/json': { schema: StaffGrantBody } } },
    },
    responses: {
      200: {
        description: 'Role granted (or replayed from idempotency snapshot)',
        content: { 'application/json': { schema: StaffGrantEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid body, or non-uuid userId',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer / missing or invalid step-up token',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description:
          'Caller is not an admin (concealment), or target user does not exist (`USER_NOT_FOUND`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description:
          'Self-demotion (`STAFF_SELF_REVOKE`) or the target is the final effective admin (`STAFF_LAST_ADMIN`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error (`INTERNAL_ERROR`), or unreadable replay snapshot (`IDEMPOTENCY_SNAPSHOT_CORRUPT`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Step-up auth unavailable on this deployment (`STEP_UP_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const StaffRevokeBody = registry.register(
    'AdminStaffRevokeBody',
    z.object({ reason: z.string().min(2).max(500) }),
  );
  const StaffRevokeResult = registry.register(
    'AdminStaffRevokeResult',
    z.object({
      userId: z.string().uuid(),
      priorRole: StaffRole,
    }),
  );
  const StaffRevokeEnvelope = registry.register(
    'AdminStaffRevokeEnvelope',
    z.object({ result: StaffRevokeResult, audit: adminWriteAudit }),
  );

  registry.registerPath({
    method: 'delete',
    path: '/api/admin/staff/{userId}/role',
    summary: 'Revoke a staff role (ADR 037).',
    description:
      'Deletes the staff_roles row and clears the users.is_admin mirror. Refuses to remove the final effective admin (`STAFF_LAST_ADMIN`) and to revoke your own role (`STAFF_SELF_REVOKE`). CTX-allowlist admins must ALSO be removed from `ADMIN_CTX_USER_IDS` or the upsert path re-flags them (see docs/runbooks/staff-role-revocation.md). ADR-017 contract + ADR-028 step-up gate.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      headers: writeHeaders,
      body: { content: { 'application/json': { schema: StaffRevokeBody } } },
    },
    responses: {
      200: {
        description: 'Role revoked (or replayed from idempotency snapshot)',
        content: { 'application/json': { schema: StaffRevokeEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid body, or non-uuid userId',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer / missing or invalid step-up token',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description:
          'Caller is not an admin (concealment), or the target holds no staff role (`NOT_FOUND`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description:
          'Self-revocation (`STAFF_SELF_REVOKE`) or the target is the final effective admin (`STAFF_LAST_ADMIN`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error (`INTERNAL_ERROR`), or unreadable replay snapshot (`IDEMPOTENCY_SNAPSHOT_CORRUPT`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Step-up auth unavailable on this deployment (`STEP_UP_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
