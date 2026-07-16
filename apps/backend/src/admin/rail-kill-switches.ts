/**
 * NS-04 — admin rail kill-switch endpoints.
 *
 *   GET  /api/admin/rails/kill-switches   — list all four rails' state
 *   POST /api/admin/rails/:rail/halt      — halt a rail (step-up + idempotent)
 *   POST /api/admin/rails/:rail/resume    — resume a rail (step-up + idempotent)
 *
 * The two writes share the ADR-017 admin-write contract exactly like
 * the credit-adjustment / refund / emission handlers: actor from
 * `requireAuth`, `Idempotency-Key` header, mandatory `reason`,
 * `withIdempotencyGuard` around the write, `buildAuditEnvelope` response,
 * and a `notifyAdminAudit` Discord fanout AFTER commit. The step-up gate
 * (`rail-halt` / `rail-resume`) is applied at the route, not here.
 *
 * The list read is unenvelope'd — it's a plain snapshot the admin UI
 * renders; the `/api/admin/*` blanket already audit-logs the GET.
 */
import type { Context } from 'hono';
import {
  RAILS,
  killSwitchService,
  type Rail,
  type RailHaltState,
} from '../rail-kill-switches/index.js';
import type { User } from '../db/users.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-rail-kill-switch' });

/** Wire shape — `updatedAt` serialised to an ISO string for JSON. */
interface RailHaltStateWire {
  rail: Rail;
  halted: boolean;
  reason: string | null;
  actorUserId: string | null;
  updatedAt: string;
}

function toWire(state: RailHaltState): RailHaltStateWire {
  return {
    rail: state.rail,
    halted: state.halted,
    reason: state.reason,
    actorUserId: state.actorUserId,
    updatedAt: state.updatedAt.toISOString(),
  };
}

function isRail(v: string | undefined): v is Rail {
  return v !== undefined && (RAILS as readonly string[]).includes(v);
}

/**
 * GET /api/admin/rails/kill-switches — all four rails' current state.
 * Fails CLOSED-agnostic: this is a read; enforcement is what fails
 * closed. If the store read throws, the global onError maps it to 500.
 */
export async function adminListRailKillSwitchesHandler(c: Context): Promise<Response> {
  const states = await killSwitchService.listStates();
  return c.json({ rails: states.map(toWire) }, 200);
}

/** Shared halt/resume handler — `halted` fixes the direction. */
function makeToggleHandler(halted: boolean) {
  const verb = halted ? 'halt' : 'resume';
  return async function toggleHandler(c: Context): Promise<Response> {
    const rail = c.req.param('rail');
    if (!isRail(rail)) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: `rail must be one of ${RAILS.join(', ')}` },
        400,
      );
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
    const reason = (body as { reason?: unknown } | null)?.reason;
    if (typeof reason !== 'string' || reason.trim().length < 2 || reason.length > 500) {
      return c.json({ code: 'VALIDATION_ERROR', message: 'reason is required (2-500 chars)' }, 400);
    }

    const path = `/api/admin/rails/${rail}/${verb}`;
    let guardResult;
    try {
      guardResult = await withIdempotencyGuard(
        { adminUserId: actor.id, key: idempotencyKey, method: 'POST', path },
        async () => {
          const state = halted
            ? await killSwitchService.halt({ rail, actorUserId: actor.id, reason, idempotencyKey })
            : await killSwitchService.resume({
                rail,
                actorUserId: actor.id,
                reason,
                idempotencyKey,
              });
          const envelope: AdminAuditEnvelope<RailHaltStateWire> = buildAuditEnvelope({
            result: toWire(state),
            actor,
            idempotencyKey,
            appliedAt: state.updatedAt,
            replayed: false,
          });
          return { status: 200, body: envelope as unknown as Record<string, unknown> };
        },
      );
    } catch (err) {
      log.error({ err, rail, adminUserId: actor.id, verb }, 'rail kill-switch toggle failed');
      return c.json({ code: 'INTERNAL_ERROR', message: `Failed to ${verb} ${rail} rail` }, 500);
    }

    // Discord audit fanout — fire-and-forget AFTER commit (ADR 017 #5).
    // Runs for fresh writes and replays so ops sees both in #admin-audit.
    notifyAdminAudit({
      actorUserId: actor.id,
      endpoint: `POST ${path}`,
      reason,
      idempotencyKey,
      replayed: guardResult.replayed,
    });

    return c.json(guardResult.body, guardResult.status as 200 | 400 | 500);
  };
}

export const adminHaltRailHandler = makeToggleHandler(true);
export const adminResumeRailHandler = makeToggleHandler(false);
