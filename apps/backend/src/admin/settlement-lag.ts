/**
 * Admin payout settlement-lag (ADR 015 / 016).
 *
 * `GET /api/admin/payouts/settlement-lag` — answers "how long is a
 * user waiting from order-fulfilled → stablecoin cashback landing
 * on-chain?" The core stablecoin-cashback UX SLA: if it's minutes,
 * we're healthy; if it's hours, the payout worker or Horizon is
 * backed up and users will feel it.
 *
 * Measures `confirmedAt - createdAt` (seconds) across `state='confirmed'`
 * rows in the window. `createdAt` is the intent-write moment (order
 * fulfils → pending_payouts insert), `confirmedAt` is the on-chain
 * ledger-close confirm. Rows with NULL timestamps are excluded by
 * the WHERE clause.
 *
 * Bucketed per LOOP asset (USDLOOP / GBPLOOP / EURLOOP) so ops can
 * see per-asset health independently — a slow EURLOOP issuer
 * shouldn't look like a fleet-wide problem when USDLOOP is flowing
 * fine. Plus a fleet-wide row (`assetCode: null`) so the at-a-glance
 * headline number is one query away.
 *
 * Window: `?since=<iso-8601>` (default 24h, cap 366d — same as the
 * operator-latency aggregation). Sample-count ships alongside so
 * the caller can down-weight low-n rows.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pendingPayouts } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-settlement-lag' });

export interface SettlementLagRow {
  /** LOOP asset code; `null` for the fleet-wide aggregate row. */
  assetCode: string | null;
  sampleCount: number;
  p50Seconds: number;
  p95Seconds: number;
  maxSeconds: number;
  meanSeconds: number;
}

export interface SettlementLagResponse {
  since: string;
  rows: SettlementLagRow[];
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

interface AggRow extends Record<string, unknown> {
  asset_code: string | null;
  sample_count: string | number | bigint;
  p50_s: string | number | null;
  p95_s: string | number | null;
  max_s: string | number | null;
  mean_s: string | number | null;
}

function toSeconds(v: string | number | null): number {
  if (v === null) return 0;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export async function adminSettlementLagHandler(c: Context): Promise<Response> {
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
    // GROUPING SETS emits (asset_code), (NULL). Postgres `NULL` in the
    // group-by column for the fleet-wide row is the sentinel — we
    // carry it straight through to the API as `assetCode: null`.
    const result = await db.execute<AggRow>(sql`
      SELECT
        ${pendingPayouts.assetCode} AS asset_code,
        COUNT(*)::bigint AS sample_count,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (${pendingPayouts.confirmedAt} - ${pendingPayouts.createdAt}))
        ) AS p50_s,
        PERCENTILE_CONT(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (${pendingPayouts.confirmedAt} - ${pendingPayouts.createdAt}))
        ) AS p95_s,
        MAX(EXTRACT(EPOCH FROM (${pendingPayouts.confirmedAt} - ${pendingPayouts.createdAt}))) AS max_s,
        AVG(EXTRACT(EPOCH FROM (${pendingPayouts.confirmedAt} - ${pendingPayouts.createdAt}))) AS mean_s
      FROM ${pendingPayouts}
      WHERE ${pendingPayouts.state} = 'confirmed'
        AND ${pendingPayouts.confirmedAt} IS NOT NULL
        AND ${pendingPayouts.createdAt} IS NOT NULL
        AND ${pendingPayouts.confirmedAt} >= ${since}
      GROUP BY GROUPING SETS ((${pendingPayouts.assetCode}), ())
      ORDER BY asset_code NULLS FIRST
    `);

    const raw = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const rows: SettlementLagRow[] = raw.map((r) => ({
      assetCode: r.asset_code,
      sampleCount: Number(r.sample_count),
      p50Seconds: toSeconds(r.p50_s),
      p95Seconds: toSeconds(r.p95_s),
      maxSeconds: toSeconds(r.max_s),
      meanSeconds: toSeconds(r.mean_s),
    }));

    const body: SettlementLagResponse = { since: since.toISOString(), rows };
    return c.json(body);
  } catch (err) {
    log.error({ err }, 'Settlement-lag aggregation failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute settlement lag' }, 500);
  }
}
