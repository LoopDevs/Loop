/**
 * Watcher skip-row browser (ADR 037 §4.4) — the first read/ops
 * surface over `payment_watcher_skips` (migration 0033, audit
 * CRIT #1/#2).
 *
 * `GET  /api/admin/watcher-skips`                    — keyset list
 * `GET  /api/admin/watcher-skips/:paymentId`         — row + snapshot
 * `POST /api/admin/watcher-skips/:paymentId/reopen`  — support action
 *
 * The reopen is a delivery-unsticking re-drive (support-tier per
 * the ADR 037 matrix): abandoned → pending with the attempt budget
 * reset, so the sweep re-evaluates the deposit on its next tick.
 * It carries the full ADR 017 envelope for the uniform audit trail
 * even though it moves no money.
 */
import type { Context } from 'hono';
import { and, eq, lt, sql, type SQL } from 'drizzle-orm';
import {
  WATCHER_SKIP_REASONS,
  WATCHER_SKIP_STATUSES,
  type AdminWatcherSkipDetail,
  type AdminWatcherSkipReopenResult,
  type AdminWatcherSkipRow,
  type AdminWatcherSkipsListResponse,
  type WatcherSkipReason,
  type WatcherSkipStatus,
} from '@loop/shared';
import { db } from '../db/client.js';
import { paymentWatcherSkips } from '../db/schema.js';
import type { User } from '../db/users.js';
import { reopenAbandonedSkip } from '../payments/skipped-payments.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-watcher-skips' });

/** Control-flow escape — see the reopen race comment below. */
class SkipReopenRaceError extends Error {
  constructor() {
    super('skip row left abandoned state concurrently');
    this.name = 'SkipReopenRaceError';
  }
}

/**
 * Horizon operation ids are decimal strings (up to ~19 digits
 * today; allow headroom). Shape-validating up front keeps the PK
 * lookup from ever seeing a pathological value.
 */
const PAYMENT_ID_RE = /^[0-9]{1,32}$/;

interface SkipDbRow {
  paymentId: string;
  memo: string;
  orderId: string | null;
  reason: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function rowToView(row: SkipDbRow): AdminWatcherSkipRow {
  return {
    paymentId: row.paymentId,
    memo: row.memo,
    orderId: row.orderId,
    reason: row.reason as WatcherSkipReason,
    status: row.status as WatcherSkipStatus,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const LIST_COLUMNS = {
  paymentId: paymentWatcherSkips.paymentId,
  memo: paymentWatcherSkips.memo,
  orderId: paymentWatcherSkips.orderId,
  reason: paymentWatcherSkips.reason,
  status: paymentWatcherSkips.status,
  attempts: paymentWatcherSkips.attempts,
  lastError: paymentWatcherSkips.lastError,
  createdAt: paymentWatcherSkips.createdAt,
  updatedAt: paymentWatcherSkips.updatedAt,
};

export async function adminListWatcherSkipsHandler(c: Context): Promise<Response> {
  const statusRaw = c.req.query('status');
  if (
    statusRaw !== undefined &&
    !(WATCHER_SKIP_STATUSES as readonly string[]).includes(statusRaw)
  ) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: `status must be one of: ${WATCHER_SKIP_STATUSES.join(', ')}`,
      },
      400,
    );
  }
  const reasonRaw = c.req.query('reason');
  if (reasonRaw !== undefined && !(WATCHER_SKIP_REASONS as readonly string[]).includes(reasonRaw)) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: `reason must be one of: ${WATCHER_SKIP_REASONS.join(', ')}`,
      },
      400,
    );
  }

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? '20', 10);
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 20 : parsedLimit, 1), 100);

  // Keyset cursor — same `before` convention as /api/admin/orders.
  const beforeRaw = c.req.query('before');
  let before: Date | undefined;
  if (beforeRaw !== undefined && beforeRaw.length > 0) {
    const d = new Date(beforeRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'before must be an ISO-8601 timestamp' },
        400,
      );
    }
    before = d;
  }

  try {
    const conditions: SQL[] = [];
    if (statusRaw !== undefined)
      conditions.push(eq(paymentWatcherSkips.status, statusRaw as WatcherSkipStatus));
    if (reasonRaw !== undefined) conditions.push(eq(paymentWatcherSkips.reason, reasonRaw));
    if (before !== undefined) conditions.push(lt(paymentWatcherSkips.createdAt, before));
    const where = conditions.length === 0 ? undefined : and(...conditions);
    const q = db.select(LIST_COLUMNS).from(paymentWatcherSkips);
    const filtered = where === undefined ? q : q.where(where);
    const rows = await filtered.orderBy(sql`${paymentWatcherSkips.createdAt} DESC`).limit(limit);
    return c.json<AdminWatcherSkipsListResponse>({ rows: rows.map(rowToView) });
  } catch (err) {
    log.error({ err }, 'Watcher-skips list failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to list watcher skips' }, 500);
  }
}

export async function adminGetWatcherSkipHandler(c: Context): Promise<Response> {
  const paymentId = c.req.param('paymentId');
  if (paymentId === undefined || !PAYMENT_ID_RE.test(paymentId)) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'paymentId must be a Horizon operation id' },
      400,
    );
  }
  try {
    const [row] = await db
      .select({ ...LIST_COLUMNS, payment: paymentWatcherSkips.payment })
      .from(paymentWatcherSkips)
      .where(eq(paymentWatcherSkips.paymentId, paymentId));
    if (row === undefined) {
      return c.json({ code: 'NOT_FOUND', message: 'Watcher skip row not found' }, 404);
    }
    const detail: AdminWatcherSkipDetail = {
      ...rowToView(row),
      payment: (row.payment ?? {}) as Record<string, unknown>,
    };
    return c.json(detail);
  } catch (err) {
    log.error({ err, paymentId }, 'Watcher-skip detail failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load watcher skip' }, 500);
  }
}

export async function adminReopenWatcherSkipHandler(c: Context): Promise<Response> {
  const paymentId = c.req.param('paymentId');
  if (paymentId === undefined || !PAYMENT_ID_RE.test(paymentId)) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'paymentId must be a Horizon operation id' },
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
    return c.json({ code: 'UNAUTHORIZED', message: 'Staff context missing' }, 401);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' }, 400);
  }
  const reason =
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>)['reason'] : null;
  if (typeof reason !== 'string' || reason.length < 2 || reason.length > 500) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'reason must be 2-500 chars' }, 400);
  }

  // Pre-classify the row so the not-found / wrong-state paths never
  // burn an idempotency snapshot.
  let priorStatus: string;
  try {
    const [row] = await db
      .select({ status: paymentWatcherSkips.status })
      .from(paymentWatcherSkips)
      .where(eq(paymentWatcherSkips.paymentId, paymentId));
    if (row === undefined) {
      return c.json({ code: 'NOT_FOUND', message: 'Watcher skip row not found' }, 404);
    }
    priorStatus = row.status;
  } catch (err) {
    log.error({ err, paymentId }, 'Watcher-skip reopen pre-read failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to reopen watcher skip' }, 500);
  }
  if (priorStatus !== 'abandoned') {
    return c.json(
      {
        code: 'SKIP_NOT_ABANDONED',
        message: `Only abandoned rows can be reopened (row is '${priorStatus}')`,
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
        method: 'POST',
        path: `/api/admin/watcher-skips/${paymentId}/reopen`,
      },
      async () => {
        const reopened = await reopenAbandonedSkip(paymentId);
        if (reopened === null) {
          // Raced: another actor reopened (or the row resolved)
          // between the pre-read and the guarded write. Thrown so
          // no failure snapshot is stored — a retry with the same
          // key must re-evaluate the live row state.
          throw new SkipReopenRaceError();
        }
        const result: AdminWatcherSkipReopenResult = {
          paymentId,
          priorStatus: 'abandoned',
          status: 'pending',
          attempts: reopened.attempts,
        };
        const envelope: AdminAuditEnvelope<AdminWatcherSkipReopenResult> = buildAuditEnvelope({
          result,
          actor,
          idempotencyKey,
          appliedAt: new Date(),
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    if (err instanceof SkipReopenRaceError) {
      return c.json(
        {
          code: 'SKIP_NOT_ABANDONED',
          message: 'Row left the abandoned state concurrently — re-read and retry',
        },
        409,
      );
    }
    log.error({ err, paymentId, actorUserId: actor.id }, 'Watcher-skip reopen failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to reopen watcher skip' }, 500);
  }

  if (guardResult.status === 200) {
    notifyAdminAudit({
      actorUserId: actor.id,
      endpoint: `POST /api/admin/watcher-skips/${paymentId}/reopen`,
      reason,
      idempotencyKey,
      replayed: guardResult.replayed,
    });
  }

  return c.json(guardResult.body, guardResult.status as 200 | 409 | 500);
}
