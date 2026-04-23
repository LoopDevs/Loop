/**
 * Admin per-user operator mix (ADR 013 / 022).
 *
 * `GET /api/admin/users/:userId/operator-mix?since=<iso>` — for
 * one user, aggregate their orders by `ctx_operator_id`. Completes
 * the per-axis matrix alongside:
 *
 *   - /merchants/:id/operator-mix   — which operators serve a merchant
 *   - /operators/:id/merchant-mix   — which merchants an operator carries
 *   - /users/:id/operator-mix       — which operators carry a user (this file)
 *
 * Answers the support-triage question: "user X complains their
 * cashback is slow — which CTX operator has been handling their
 * recent orders?". Lets support + ops correlate a per-user
 * complaint with a specific operator's health without paging
 * through individual orders.
 *
 * Per operator returned:
 *   - operatorId      — the CTX service account carrying the order
 *   - orderCount      — orders for this user carried by op
 *   - fulfilledCount  — subset closed successfully
 *   - failedCount     — subset ended in `failed`
 *   - lastOrderAt     — newest `createdAt` attributed to this pair
 *
 * Only rows with a non-null `ctxOperatorId` are aggregated.
 * Zero-mix users return 200 with `rows: []` — "never had an order
 * assigned to an operator" (maybe all pre-procurement) is valid,
 * not a 404.
 *
 * Window `?since=<iso-8601>` defaults to 24h, clamped 366d.
 * `userId` must be a valid UUID so the drill URL can't smuggle
 * SQL through the param.
 */
import type { Context } from 'hono';
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-operator-mix' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

export interface UserOperatorMixRow {
  operatorId: string;
  orderCount: number;
  fulfilledCount: number;
  failedCount: number;
  lastOrderAt: string;
}

export interface UserOperatorMixResponse {
  userId: string;
  since: string;
  rows: UserOperatorMixRow[];
}

interface AggRow extends Record<string, unknown> {
  operator_id: string;
  order_count: string | number | bigint;
  fulfilled_count: string | number | bigint;
  failed_count: string | number | bigint;
  last_order_at: string | Date;
}

function toNumber(v: string | number | bigint): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function adminUserOperatorMixHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || userId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId is required' }, 400);
  }
  if (!UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a UUID' }, 400);
  }

  const sinceRaw = c.req.query('since');
  let since: Date;
  if (sinceRaw !== undefined && sinceRaw.length > 0) {
    const d = new Date(sinceRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'since must be an ISO-8601 timestamp' },
        400,
      );
    }
    since = d;
  } else {
    since = new Date(Date.now() - DEFAULT_WINDOW_MS);
  }

  const windowMs = Date.now() - since.getTime();
  if (windowMs > MAX_WINDOW_MS) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'since cannot be more than 366 days ago' },
      400,
    );
  }

  try {
    const result = await db.execute<AggRow>(sql`
      SELECT
        ${orders.ctxOperatorId} AS operator_id,
        COUNT(*)::bigint AS order_count,
        SUM(CASE WHEN ${orders.state} = 'fulfilled' THEN 1 ELSE 0 END)::bigint AS fulfilled_count,
        SUM(CASE WHEN ${orders.state} = 'failed' THEN 1 ELSE 0 END)::bigint AS failed_count,
        MAX(${orders.createdAt}) AS last_order_at
      FROM ${orders}
      WHERE ${and(
        eq(orders.userId, userId),
        isNotNull(orders.ctxOperatorId),
        gte(orders.createdAt, since),
      )}
      GROUP BY ${orders.ctxOperatorId}
      ORDER BY order_count DESC, operator_id ASC
    `);

    const raw = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const rows: UserOperatorMixRow[] = raw.map((r) => ({
      operatorId: r.operator_id,
      orderCount: toNumber(r.order_count),
      fulfilledCount: toNumber(r.fulfilled_count),
      failedCount: toNumber(r.failed_count),
      lastOrderAt:
        r.last_order_at instanceof Date
          ? r.last_order_at.toISOString()
          : new Date(r.last_order_at).toISOString(),
    }));

    const body: UserOperatorMixResponse = {
      userId,
      since: since.toISOString(),
      rows,
    };
    return c.json(body);
  } catch (err) {
    log.error({ err, userId }, 'User operator-mix aggregate failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute operator mix' }, 500);
  }
}
