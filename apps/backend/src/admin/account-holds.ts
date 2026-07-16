/**
 * NS-08 — admin / AML account-freeze endpoints (design doc §4).
 *
 *   POST /api/admin/users/:userId/holds   — place a hold (freeze)
 *   POST /api/admin/holds/:holdId/release — release a hold (unfreeze)
 *   GET  /api/admin/users/:userId/holds   — per-user hold history (read)
 *   GET  /api/admin/holds                 — live-holds dashboard (read)
 *
 * The two writes carry the ADR-017 audited-admin-write contract exactly
 * like the credit-adjustment / rail-kill-switch handlers: actor from
 * `requireStaff('admin')` context (NEVER the body), `Idempotency-Key`
 * header, mandatory `reason`, `withIdempotencyGuard` around the write,
 * `buildAuditEnvelope` response, and a `notifyAdminAudit` Discord fanout
 * AFTER commit. The step-up gate (`account-freeze` / `account-unfreeze`)
 * is applied at the route, not here.
 *
 * The reads are unenvelope'd snapshots the admin UI renders; the
 * `/api/admin/*` blanket already audit-logs the GET.
 */
import type { Context } from 'hono';
import { UUID_RE } from '../uuid.js';
import type { User } from '../db/users.js';
import { getUserById } from '../db/users.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';
import {
  type AccountHold,
  isAccountHoldReasonCode,
  isAccountHoldScope,
} from '../fraud/account-freeze.js';
import {
  accountFreezeService,
  AccountHoldAlreadyReleasedError,
  AccountHoldNotFoundError,
} from '../fraud/account-freeze-service.js';

const log = logger.child({ handler: 'admin-account-holds' });

/** Wire shape — Dates serialised to ISO strings for JSON. */
interface AccountHoldWire {
  id: string;
  userId: string;
  scope: string;
  reasonCode: string;
  reason: string;
  placedByUserId: string;
  placedAt: string;
  releasedAt: string | null;
  releasedByUserId: string | null;
  releaseReason: string | null;
}

function toWire(hold: AccountHold): AccountHoldWire {
  return {
    id: hold.id,
    userId: hold.userId,
    scope: hold.scope,
    reasonCode: hold.reasonCode,
    reason: hold.reason,
    placedByUserId: hold.placedByUserId,
    placedAt: hold.placedAt.toISOString(),
    releasedAt: hold.releasedAt === null ? null : hold.releasedAt.toISOString(),
    releasedByUserId: hold.releasedByUserId,
    releaseReason: hold.releaseReason,
  };
}

/** POST /api/admin/users/:userId/holds — place (freeze) an account hold. */
export async function adminPlaceAccountHoldHandler(c: Context): Promise<Response> {
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
    // requireStaff('admin') should have populated this. Fail closed.
    return c.json({ code: 'UNAUTHORIZED', message: 'Admin context missing' }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' }, 400);
  }
  const b = (body ?? {}) as { scope?: unknown; reasonCode?: unknown; reason?: unknown };
  if (!isAccountHoldScope(b.scope)) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: "scope is required — 'full' or 'debits_only'" },
      400,
    );
  }
  if (!isAccountHoldReasonCode(b.reasonCode)) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'reasonCode is required and must be a known AML code' },
      400,
    );
  }
  const reason = b.reason;
  if (typeof reason !== 'string' || reason.trim().length < 2 || reason.length > 500) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'reason is required (2-500 chars)' }, 400);
  }
  const scope = b.scope;
  const reasonCode = b.reasonCode;

  // Target user must exist before we place a hold referencing them —
  // fail fast with 404 rather than letting the FK insert throw a 500.
  const targetUser = await getUserById(userId);
  if (targetUser === null) {
    return c.json({ code: 'NOT_FOUND', message: 'Target user not found' }, 404);
  }

  const path = `/api/admin/users/${userId}/holds`;
  let guardResult;
  try {
    guardResult = await withIdempotencyGuard(
      { adminUserId: actor.id, key: idempotencyKey, method: 'POST', path },
      async () => {
        const hold = await accountFreezeService.placeHold({
          userId,
          scope,
          reasonCode,
          reason,
          placedByUserId: actor.id,
        });
        const envelope: AdminAuditEnvelope<AccountHoldWire> = buildAuditEnvelope({
          result: toWire(hold),
          actor,
          idempotencyKey,
          appliedAt: hold.placedAt,
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    log.error({ err, userId, adminUserId: actor.id }, 'account hold place failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to place account hold' }, 500);
  }

  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: `POST ${path}`,
    targetUserId: userId,
    reason,
    idempotencyKey,
    replayed: guardResult.replayed,
  });

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 500);
}

/** POST /api/admin/holds/:holdId/release — release (unfreeze) a hold. */
export async function adminReleaseAccountHoldHandler(c: Context): Promise<Response> {
  const holdId = c.req.param('holdId');
  if (holdId === undefined || !UUID_RE.test(holdId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'holdId must be a uuid' }, 400);
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

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' }, 400);
  }
  const reason = (body as { reason?: unknown } | null)?.reason;
  if (typeof reason !== 'string' || reason.trim().length < 2 || reason.length > 500) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'reason is required (2-500 chars)' }, 400);
  }

  const path = `/api/admin/holds/${holdId}/release`;
  let guardResult;
  try {
    guardResult = await withIdempotencyGuard(
      { adminUserId: actor.id, key: idempotencyKey, method: 'POST', path },
      async () => {
        const hold = await accountFreezeService.releaseHold({
          holdId,
          releaseReason: reason,
          releasedByUserId: actor.id,
        });
        const envelope: AdminAuditEnvelope<AccountHoldWire> = buildAuditEnvelope({
          result: toWire(hold),
          actor,
          idempotencyKey,
          appliedAt: hold.releasedAt ?? hold.placedAt,
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    if (err instanceof AccountHoldNotFoundError) {
      return c.json({ code: 'NOT_FOUND', message: 'Hold not found' }, 404);
    }
    if (err instanceof AccountHoldAlreadyReleasedError) {
      return c.json({ code: 'HOLD_ALREADY_RELEASED', message: 'Hold is already released' }, 409);
    }
    log.error({ err, holdId, adminUserId: actor.id }, 'account hold release failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to release account hold' }, 500);
  }

  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: `POST ${path}`,
    reason,
    idempotencyKey,
    replayed: guardResult.replayed,
  });

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 404 | 409 | 500);
}

/** GET /api/admin/users/:userId/holds — per-user hold history (read). */
export async function adminListUserAccountHoldsHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || !UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }
  const holds = await accountFreezeService.listHolds(userId);
  return c.json({ holds: holds.map(toWire) }, 200);
}

/** GET /api/admin/holds — live-holds dashboard (read). */
export async function adminListActiveAccountHoldsHandler(c: Context): Promise<Response> {
  const holds = await accountFreezeService.listActiveHolds({ limit: 500 });
  return c.json({ holds: holds.map(toWire) }, 200);
}
