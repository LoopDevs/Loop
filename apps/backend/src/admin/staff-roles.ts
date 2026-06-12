/**
 * Staff role management handlers (ADR 037 §1).
 *
 * `GET    /api/admin/staff`              — list with grant metadata
 * `PUT    /api/admin/staff/:userId/role` — grant / change a role
 * `DELETE /api/admin/staff/:userId/role` — revoke staff access
 *
 * The writes are the first self-serve alternative to the
 * direct-SQL escalation noted in the audit, so they carry the FULL
 * ADR 017 contract (actor from context, Idempotency-Key, reason,
 * Discord audit fanout after commit, `{ result, audit }` envelope)
 * AND the ADR 028 step-up gate (mounted at the route) — a captured
 * bearer alone must not be able to mint itself a colleague.
 *
 * Two safety invariants live in the repo (`db/staff-roles.ts`),
 * atomic under the staff-write advisory lock:
 *   - last-admin protection — refuse to demote/revoke the final
 *     effective admin (`STAFF_LAST_ADMIN`, 409);
 * and one lives here, where the actor is known:
 *   - self-demotion guard — an admin cannot revoke or demote their
 *     OWN admin role (`STAFF_SELF_REVOKE`, 409). Another admin has
 *     to do it, which is exactly the audit trail we want.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import {
  STAFF_ROLES,
  type AdminStaffGrantResult,
  type AdminStaffListResponse,
  type AdminStaffRevokeResult,
} from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import { getUserById, type User } from '../db/users.js';
import {
  grantStaffRole,
  LastAdminError,
  listStaffEntries,
  revokeStaffRole,
  StaffRoleNotFoundError,
} from '../db/staff-roles.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-staff-roles' });

export async function adminListStaffHandler(c: Context): Promise<Response> {
  try {
    const staff = await listStaffEntries();
    return c.json<AdminStaffListResponse>({ staff });
  } catch (err) {
    log.error({ err }, 'Staff list failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to list staff' }, 500);
  }
}

const GrantBodySchema = z.object({
  role: z.enum(STAFF_ROLES),
  reason: z.string().min(2).max(500),
});

const RevokeBodySchema = z.object({
  reason: z.string().min(2).max(500),
});

/**
 * Shared request-edge validation for the two writes. Returns the
 * error Response, or the validated pieces.
 */
function validateWriteEdge(c: Context):
  | Response
  | {
      userId: string;
      idempotencyKey: string;
      actor: User;
    } {
  const userId = c.req.param('userId');
  if (userId === undefined || !UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }
  const idempotencyKey = c.req.header('idempotency-key');
  if (!validateIdempotencyKey(idempotencyKey)) {
    return c.json(
      {
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: `Idempotency-Key header required (${IDEMPOTENCY_KEY_MIN}-${IDEMPOTENCY_KEY_MAX} chars)`,
      },
      400,
    );
  }
  const actor = c.get('user') as User | undefined;
  if (actor === undefined) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Admin context missing' }, 401);
  }
  return { userId, idempotencyKey, actor };
}

export async function adminGrantStaffRoleHandler(c: Context): Promise<Response> {
  const edge = validateWriteEdge(c);
  if (edge instanceof Response) return edge;
  const { userId, idempotencyKey, actor } = edge;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' }, 400);
  }
  const parsed = GrantBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }

  // Self-demotion guard — granting yourself 'support' is revoking
  // your own admin role with extra steps.
  if (actor.id === userId && parsed.data.role !== 'admin') {
    return c.json(
      {
        code: 'STAFF_SELF_REVOKE',
        message: 'You cannot demote your own admin role — another admin must do it',
      },
      409,
    );
  }

  try {
    const target = await getUserById(userId);
    if (target === null) {
      return c.json({ code: 'USER_NOT_FOUND', message: 'User not found' }, 404);
    }
  } catch (err) {
    log.error({ err, userId }, 'Staff grant target lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to resolve target user' }, 500);
  }

  let guardResult: Awaited<ReturnType<typeof withIdempotencyGuard>>;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'PUT',
        path: `/api/admin/staff/${userId}/role`,
      },
      async () => {
        const applied = await grantStaffRole({
          userId,
          role: parsed.data.role,
          grantedByUserId: actor.id,
          reason: parsed.data.reason,
        });
        const result: AdminStaffGrantResult = {
          userId,
          role: parsed.data.role,
          priorRole: applied.priorRole,
          grantedAt: applied.grantedAt.toISOString(),
        };
        const envelope: AdminAuditEnvelope<AdminStaffGrantResult> = buildAuditEnvelope({
          result,
          actor,
          idempotencyKey,
          appliedAt: applied.grantedAt,
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    if (err instanceof LastAdminError) {
      return c.json(
        { code: 'STAFF_LAST_ADMIN', message: 'Refusing to demote the final admin' },
        409,
      );
    }
    log.error({ err, userId, adminUserId: actor.id }, 'Staff role grant failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to grant staff role' }, 500);
  }

  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: `PUT /api/admin/staff/${userId}/role`,
    targetUserId: userId,
    reason: `role=${parsed.data.role}: ${parsed.data.reason}`,
    idempotencyKey,
    replayed: guardResult.replayed,
  });

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 404 | 409 | 500);
}

export async function adminRevokeStaffRoleHandler(c: Context): Promise<Response> {
  const edge = validateWriteEdge(c);
  if (edge instanceof Response) return edge;
  const { userId, idempotencyKey, actor } = edge;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' }, 400);
  }
  const parsed = RevokeBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }

  if (actor.id === userId) {
    return c.json(
      {
        code: 'STAFF_SELF_REVOKE',
        message: 'You cannot revoke your own admin role — another admin must do it',
      },
      409,
    );
  }

  let guardResult: Awaited<ReturnType<typeof withIdempotencyGuard>>;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'DELETE',
        path: `/api/admin/staff/${userId}/role`,
      },
      async () => {
        const applied = await revokeStaffRole({ userId });
        const appliedAt = new Date();
        const result: AdminStaffRevokeResult = {
          userId,
          priorRole: applied.priorRole,
        };
        const envelope: AdminAuditEnvelope<AdminStaffRevokeResult> = buildAuditEnvelope({
          result,
          actor,
          idempotencyKey,
          appliedAt,
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    if (err instanceof StaffRoleNotFoundError) {
      return c.json({ code: 'NOT_FOUND', message: 'User holds no staff role' }, 404);
    }
    if (err instanceof LastAdminError) {
      return c.json(
        { code: 'STAFF_LAST_ADMIN', message: 'Refusing to remove the final admin' },
        409,
      );
    }
    log.error({ err, userId, adminUserId: actor.id }, 'Staff role revoke failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to revoke staff role' }, 500);
  }

  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: `DELETE /api/admin/staff/${userId}/role`,
    targetUserId: userId,
    reason: parsed.data.reason,
    idempotencyKey,
    replayed: guardResult.replayed,
  });

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 404 | 409 | 500);
}
