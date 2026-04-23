/**
 * Admin operators snapshot CSV export (ADR 013 / 018 / 022).
 *
 * `GET /api/admin/operators-snapshot.csv?since=<iso>` — flattens
 * per-operator stats + fulfilment-latency into one RFC 4180 CSV
 * row per operator. Used for CTX quarterly reviews and compliance
 * reporting: hand the relationship owner a flat file that ties
 * each operator's volume, success rate and latency into one sheet.
 *
 * Shape (one row per operator):
 *   operator_id,order_count,fulfilled_count,failed_count,
 *   success_pct,sample_count,p50_ms,p95_ms,p99_ms,mean_ms,last_order_at
 *
 * `sample_count` / `pXX_ms` / `mean_ms` come from fulfilment-latency
 * — an operator with zero fulfilled orders in the window gets 0s.
 *
 * Window: `?since=<iso-8601>` (default 24h, cap 366d). Row cap
 * 10 000 with `__TRUNCATED__` sentinel. Matches the other Tier-3
 * CSV contracts (payouts-activity, supplier-spend-activity).
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-operators-snapshot-csv' });

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const ROW_CAP = 10_000;

const HEADERS = [
  'operator_id',
  'order_count',
  'fulfilled_count',
  'failed_count',
  'success_pct',
  'sample_count',
  'p50_ms',
  'p95_ms',
  'p99_ms',
  'mean_ms',
  'last_order_at',
] as const;

function csvEscape(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function csvRow(values: Array<string | null | undefined>): string {
  return values.map((v) => csvEscape(v ?? null)).join(',');
}

interface AggRow {
  operator_id: string;
  order_count: string | number | bigint;
  fulfilled_count: string | number | bigint;
  failed_count: string | number | bigint;
  sample_count: string | number | bigint | null;
  p50_ms: string | number | null;
  p95_ms: string | number | null;
  p99_ms: string | number | null;
  mean_ms: string | number | null;
  last_order_at: string | Date | null;
}

function toStringInt(v: string | number | bigint | null | undefined): string {
  if (v === null || v === undefined) return '0';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Math.trunc(v).toString();
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n).toString() : '0';
}

function toMsRounded(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '0';
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? Math.round(n).toString() : '0';
}

function toIsoOrEmpty(v: string | Date | null): string {
  if (v === null) return '';
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** Success-rate % rounded to 1dp. Zero-order rows → empty string. */
function successPct(order: string, fulfilled: string): string {
  const o = Number(order);
  const f = Number(fulfilled);
  if (!Number.isFinite(o) || o <= 0 || !Number.isFinite(f)) return '';
  const pct = (f / o) * 100;
  const clamped = Math.max(0, Math.min(100, pct));
  return clamped.toFixed(1);
}

export async function adminOperatorsSnapshotCsvHandler(c: Context): Promise<Response> {
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
    // Join stats + latency on ctx_operator_id. The stats side is the
    // LEFT — an operator with any orders in the window is included
    // even if no fulfilled-with-timings-set sample made it into the
    // latency side. Null latency → zero-filled numeric columns.
    const result = await db.execute(sql`
      WITH stats AS (
        SELECT
          ctx_operator_id AS operator_id,
          COUNT(*)::bigint AS order_count,
          SUM(CASE WHEN state = 'fulfilled' THEN 1 ELSE 0 END)::bigint AS fulfilled_count,
          SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END)::bigint AS failed_count,
          MAX(created_at) AS last_order_at
        FROM orders
        WHERE ctx_operator_id IS NOT NULL
          AND created_at >= ${since}
        GROUP BY ctx_operator_id
      ),
      latency AS (
        SELECT
          ctx_operator_id AS operator_id,
          COUNT(*)::bigint AS sample_count,
          PERCENTILE_CONT(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (fulfilled_at - paid_at)) * 1000
          ) AS p50_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (fulfilled_at - paid_at)) * 1000
          ) AS p95_ms,
          PERCENTILE_CONT(0.99) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (fulfilled_at - paid_at)) * 1000
          ) AS p99_ms,
          AVG(EXTRACT(EPOCH FROM (fulfilled_at - paid_at)) * 1000) AS mean_ms
        FROM orders
        WHERE state = 'fulfilled'
          AND ctx_operator_id IS NOT NULL
          AND paid_at IS NOT NULL
          AND fulfilled_at IS NOT NULL
          AND fulfilled_at >= ${since}
        GROUP BY ctx_operator_id
      )
      SELECT
        s.operator_id,
        s.order_count,
        s.fulfilled_count,
        s.failed_count,
        l.sample_count,
        l.p50_ms,
        l.p95_ms,
        l.p99_ms,
        l.mean_ms,
        s.last_order_at
      FROM stats s
      LEFT JOIN latency l ON l.operator_id = s.operator_id
      ORDER BY s.order_count DESC, s.operator_id ASC
      LIMIT ${ROW_CAP + 1}
    `);

    const rows = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const lines: string[] = [HEADERS.join(',')];
    const truncated = rows.length > ROW_CAP;
    const emitted = truncated ? rows.slice(0, ROW_CAP) : rows;

    for (const r of emitted) {
      const orderCount = toStringInt(r.order_count);
      const fulfilledCount = toStringInt(r.fulfilled_count);
      lines.push(
        csvRow([
          r.operator_id,
          orderCount,
          fulfilledCount,
          toStringInt(r.failed_count),
          successPct(orderCount, fulfilledCount),
          toStringInt(r.sample_count),
          toMsRounded(r.p50_ms),
          toMsRounded(r.p95_ms),
          toMsRounded(r.p99_ms),
          toMsRounded(r.mean_ms),
          toIsoOrEmpty(r.last_order_at),
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { rowCount: rows.length },
        'Admin operators-snapshot CSV truncated — narrow the window',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const today = new Date().toISOString().slice(0, 10);
    const filename = `operators-snapshot-${today}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin operators-snapshot CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
