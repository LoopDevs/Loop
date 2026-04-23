/**
 * Admin per-operator activity time-series (ADR 013 / 022).
 *
 * `GET /api/admin/operators/:operatorId/activity?days=7` —
 * per-day counts of orders **created / fulfilled / failed** for
 * one CTX operator over the last N calendar days (UTC-bucketed).
 *
 * Completes the per-operator drill quartet:
 *   - /operator-stats            — fleet snapshot (which operators are busy)
 *   - /operators/latency         — fleet p50/p95/p99 (which are slow)
 *   - /operators/:id/supplier-spend — per-operator per-currency cost
 *   - /operators/:id/activity    — per-operator time-series (this file)
 *
 * Answers "is this operator degrading over time?" — a cleanly
 * rising `failed` count, or a dropping `fulfilled / created` ratio,
 * is a scheduler-tuning / CTX-escalation signal well before the
 * circuit breaker trips.
 *
 * Single query with `generate_series` on the left to guarantee
 * every day in the window appears even with zero orders — no
 * client-side gap filling.
 *
 * Zero-volume operators return 200 with a zero-filled series —
 * "operator warmed up but not yet scheduled" is a valid state,
 * not a 404. 400 only for malformed operatorId or out-of-range
 * `?days`.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-operator-activity' });

const OPERATOR_ID_RE = /^[A-Za-z0-9._-]+$/;
const OPERATOR_ID_MAX = 128;
const MIN_DAYS = 1;
const MAX_DAYS = 90;
const DEFAULT_DAYS = 7;

export interface OperatorActivityDay {
  /** YYYY-MM-DD in UTC. */
  day: string;
  created: number;
  fulfilled: number;
  failed: number;
}

export interface OperatorActivityResponse {
  operatorId: string;
  /** Oldest-first so a bar chart renders left-to-right. */
  days: OperatorActivityDay[];
  /** Echoed so clients can show a "Last N days" label. */
  windowDays: number;
}

interface Row extends Record<string, unknown> {
  day: string | Date;
  created: string | number;
  fulfilled: string | number;
  failed: string | number;
}

export async function adminOperatorActivityHandler(c: Context): Promise<Response> {
  const operatorId = c.req.param('operatorId');
  if (operatorId === undefined || operatorId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'operatorId is required' }, 400);
  }
  if (operatorId.length > OPERATOR_ID_MAX || !OPERATOR_ID_RE.test(operatorId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'operatorId is malformed' }, 400);
  }

  const daysRaw = c.req.query('days');
  const parsedDays = Number.parseInt(daysRaw ?? String(DEFAULT_DAYS), 10);
  const windowDays = Math.min(
    Math.max(Number.isNaN(parsedDays) ? DEFAULT_DAYS : parsedDays, MIN_DAYS),
    MAX_DAYS,
  );

  try {
    const result = await db.execute<Row>(sql`
      WITH days AS (
        SELECT generate_series(
          DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '1 day' * (${windowDays} - 1),
          DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC'),
          INTERVAL '1 day'
        ) AS day
      )
      SELECT
        TO_CHAR(days.day, 'YYYY-MM-DD') AS day,
        COALESCE(COUNT(${orders.id}), 0)::bigint AS created,
        COALESCE(
          COUNT(${orders.id}) FILTER (WHERE ${orders.state} = 'fulfilled'),
          0
        )::bigint AS fulfilled,
        COALESCE(
          COUNT(${orders.id}) FILTER (WHERE ${orders.state} = 'failed'),
          0
        )::bigint AS failed
      FROM days
      LEFT JOIN ${orders}
        ON DATE_TRUNC('day', ${orders.createdAt} AT TIME ZONE 'UTC') = days.day
       AND ${orders.ctxOperatorId} = ${operatorId}
      GROUP BY days.day
      ORDER BY days.day ASC
    `);
    const rows: Row[] = Array.isArray(result)
      ? (result as Row[])
      : ((result as { rows?: Row[] }).rows ?? []);

    const daysOut: OperatorActivityDay[] = rows.map((r) => ({
      day: typeof r.day === 'string' ? r.day : r.day.toISOString().slice(0, 10),
      created: Number(r.created),
      fulfilled: Number(r.fulfilled),
      failed: Number(r.failed),
    }));

    return c.json<OperatorActivityResponse>({
      operatorId,
      days: daysOut,
      windowDays,
    });
  } catch (err) {
    log.error({ err }, 'Operator-activity query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load operator activity' }, 500);
  }
}
