/**
 * Admin per-operator supplier-spend (ADR 013 / 015).
 *
 * `GET /api/admin/operators/:operatorId/supplier-spend?since=<iso>` —
 * the per-operator axis of the supplier-spend aggregate. The
 * fleet-wide `/api/admin/supplier-spend` answers "what did Loop
 * pay CTX across all operators?"; this answers "which operator
 * carried the spend?". Same per-currency row shape, scoped via
 * `WHERE ctx_operator_id = :operatorId`.
 *
 * Why operator-level matters: ADR 013 treats the CTX operator
 * pool as a set of service accounts Loop multiplexes across. If
 * one operator suddenly accounts for 80% of spend (or suddenly
 * drops to 0%), that's a load-balancing signal — either the
 * circuit-breaker is tripping unevenly, or the pool config has
 * drifted. This endpoint exposes that distribution without
 * forcing ops to mentally sum across the admin-orders list.
 *
 * Window: `?since=<iso>` (default 24h ago, cap 366 days) —
 * matches the fleet-wide supplier-spend contract so the two
 * endpoints can be compared without parameter-shape surprises.
 * bigint-as-string on every money field.
 *
 * Zero-volume operators return 200 with empty `rows[]` — an
 * operator that hasn't carried any fulfilled orders in the window
 * is a valid case (warmed up but not yet picked by the scheduler,
 * or drained for maintenance), not a 404. 400 only for malformed
 * operatorId.
 */
import type { Context } from 'hono';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-operator-supplier-spend' });

const OPERATOR_ID_RE = /^[A-Za-z0-9._-]+$/;
const OPERATOR_ID_MAX = 128;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

export interface OperatorSupplierSpendRow {
  currency: string;
  count: number;
  faceValueMinor: string;
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
}

export interface OperatorSupplierSpendResponse {
  operatorId: string;
  since: string;
  rows: OperatorSupplierSpendRow[];
}

interface AggRow extends Record<string, unknown> {
  currency: string;
  count: string | number | bigint;
  face_value_minor: string | number | bigint;
  wholesale_minor: string | number | bigint;
  user_cashback_minor: string | number | bigint;
  loop_margin_minor: string | number | bigint;
}

function toNumber(value: string | number | bigint): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number.parseInt(value, 10);
}

function toStringBigint(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

export async function adminOperatorSupplierSpendHandler(c: Context): Promise<Response> {
  const operatorId = c.req.param('operatorId');
  if (operatorId === undefined || operatorId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'operatorId is required' }, 400);
  }
  if (operatorId.length > OPERATOR_ID_MAX || !OPERATOR_ID_RE.test(operatorId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'operatorId is malformed' }, 400);
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

  if (Date.now() - since.getTime() > MAX_WINDOW_MS) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'since cannot be more than 366 days ago' },
      400,
    );
  }

  try {
    // A2-904: GROUP BY charge_currency, not catalog `currency`. The
    // summed minor-units (wholesale / user_cashback / loop_margin)
    // are stored in home-currency terms by orders/repo.ts; grouping
    // by catalog mixed GBP + USD into the same bucket. See
    // supplier-spend.ts header for the full rationale.
    const result = await db.execute<AggRow>(sql`
      SELECT
        ${orders.chargeCurrency}                            AS currency,
        COUNT(*)::bigint                                    AS count,
        COALESCE(SUM(${orders.faceValueMinor}), 0)::bigint   AS face_value_minor,
        COALESCE(SUM(${orders.wholesaleMinor}), 0)::bigint   AS wholesale_minor,
        COALESCE(SUM(${orders.userCashbackMinor}), 0)::bigint AS user_cashback_minor,
        COALESCE(SUM(${orders.loopMarginMinor}), 0)::bigint  AS loop_margin_minor
      FROM ${orders}
      WHERE ${and(
        eq(orders.ctxOperatorId, operatorId),
        eq(orders.state, 'fulfilled'),
        gte(orders.fulfilledAt, since),
      )}
      GROUP BY ${orders.chargeCurrency}
      ORDER BY ${orders.chargeCurrency} ASC
    `);

    const rawRows = (
      Array.isArray(result)
        ? (result as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const rows: OperatorSupplierSpendRow[] = rawRows.map((r) => ({
      currency: r.currency,
      count: toNumber(r.count),
      faceValueMinor: toStringBigint(r.face_value_minor),
      wholesaleMinor: toStringBigint(r.wholesale_minor),
      userCashbackMinor: toStringBigint(r.user_cashback_minor),
      loopMarginMinor: toStringBigint(r.loop_margin_minor),
    }));

    return c.json<OperatorSupplierSpendResponse>({
      operatorId,
      since: since.toISOString(),
      rows,
    });
  } catch (err) {
    log.error({ err, operatorId }, 'Admin operator supplier-spend query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to compute operator supplier spend' },
      500,
    );
  }
}
