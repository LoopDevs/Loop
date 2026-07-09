/**
 * Admin stuck-orders triage (ADR 011 / 013).
 *
 * `GET /api/admin/stuck-orders` — orders Loop has collected payment
 * on but hasn't yet fulfilled through CTX, and that have been in
 * that state longer than a threshold. The admin panel renders this
 * as the dashboard's "needs attention" card next to the treasury
 * snapshot — when anything lands here, ops investigates:
 *   - state=paid older than thresholdMinutes → CTX procurement
 *     worker isn't picking the row up (operator-pool health?)
 *   - state=procuring older than thresholdMinutes → CTX has a
 *     response in flight that never resolved (upstream incident?)
 *
 * Fulfilled / failed / expired are terminal from Loop's POV; they
 * never appear here. Default threshold is 5 minutes. Max 100 rows.
 */
import type { Context } from 'hono';
import { and, asc, inArray, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-stuck-orders' });

/**
 * A5-6: this is a deliberately EARLIER early-warning threshold than
 * `sweepStuckProcurement`'s terminal-action cutoff
 * (`PROCUREMENT_TIMEOUT_MS`, 15 min — `orders/procurement-worker.ts`)
 * — an operator should see a row here well before the sweep silently
 * fails + auto-refunds it, not learn about the incident after the
 * fact from a Discord alert. `stuck-orders.test.ts` pins
 * `DEFAULT_THRESHOLD_MINUTES * 60_000 < PROCUREMENT_TIMEOUT_MS` so a
 * future edit can't invert that ordering unnoticed.
 *
 * The WHERE-filter below also intentionally anchors on `createdAt`
 * (order creation) rather than the per-state `paidAt`/`procuredAt`
 * columns the response uses for display: `createdAt <= paidAt <=
 * procuredAt` always, so the createdAt filter is a superset of what a
 * per-state filter would return — it can over-include a row that's
 * young by `paidAt`/`procuredAt` (never hides a genuinely-stuck one)
 * and reuses the existing `orders_paid_procuring_created` partial
 * index (migration 0036 / PERF-006) built for exactly this query
 * shape. Precise per-state filtering would need a new migration;
 * deferred until stuck-order volume justifies it (see the inline note
 * on the query below).
 */
export const DEFAULT_THRESHOLD_MINUTES = 5;
const MAX_THRESHOLD_MINUTES = 60 * 24 * 7; // 1 week
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Non-terminal states a row can stick in. Matches what gets filtered. */
const STUCK_STATES = ['paid', 'procuring'] as const;

export interface StuckOrderRow {
  id: string;
  userId: string;
  merchantId: string;
  state: string;
  /** The rail the user paid with (ADR 015). Matters for triage — a
   * stuck loop_asset order is a flywheel-path incident; a stuck xlm
   * / usdc order is a Stellar-watcher incident; a stuck credit order
   * is an off-ledger state-machine bug. */
  paymentMethod: string;
  /** The ISO timestamp that keyed this row as stuck (paid_at or procured_at depending on state). */
  stuckSince: string;
  /** Minutes elapsed since stuckSince, as a number — for convenient UI rendering. */
  ageMinutes: number;
  ctxOrderId: string | null;
  ctxOperatorId: string | null;
}

export interface StuckOrdersResponse {
  thresholdMinutes: number;
  rows: StuckOrderRow[];
}

interface DbRow {
  id: string;
  userId: string;
  merchantId: string;
  state: string;
  paymentMethod: string;
  createdAt: Date;
  paidAt: Date | null;
  procuredAt: Date | null;
  ctxOrderId: string | null;
  ctxOperatorId: string | null;
}

export async function adminStuckOrdersHandler(c: Context): Promise<Response> {
  const thresholdRaw = c.req.query('thresholdMinutes');
  const parsedThreshold = Number.parseInt(thresholdRaw ?? `${DEFAULT_THRESHOLD_MINUTES}`, 10);
  const thresholdMinutes = Math.min(
    Math.max(Number.isNaN(parsedThreshold) ? DEFAULT_THRESHOLD_MINUTES : parsedThreshold, 1),
    MAX_THRESHOLD_MINUTES,
  );

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? `${DEFAULT_LIMIT}`, 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit, 1),
    MAX_LIMIT,
  );

  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);

  try {
    // Key on `createdAt` as the stuck-since proxy — state transitions
    // into paid/procuring stamp paid_at/procured_at, but createdAt is
    // always set and gives the simplest "age" floor. A future slice
    // can refine to per-state timestamps once stuck-order volume is
    // high enough that the distinction matters.
    const rows = (await db
      .select({
        id: orders.id,
        userId: orders.userId,
        merchantId: orders.merchantId,
        state: orders.state,
        paymentMethod: orders.paymentMethod,
        createdAt: orders.createdAt,
        paidAt: orders.paidAt,
        procuredAt: orders.procuredAt,
        ctxOrderId: orders.ctxOrderId,
        ctxOperatorId: orders.ctxOperatorId,
      })
      .from(orders)
      .where(
        and(
          inArray(orders.state, STUCK_STATES as unknown as string[]),
          lt(orders.createdAt, cutoff),
        ),
      )
      .orderBy(asc(orders.createdAt))
      .limit(limit)) as DbRow[];

    const nowMs = Date.now();
    const body: StuckOrdersResponse = {
      thresholdMinutes,
      rows: rows.map((r) => {
        const anchor =
          r.state === 'procuring'
            ? (r.procuredAt ?? r.paidAt ?? r.createdAt)
            : (r.paidAt ?? r.createdAt);
        const ageMinutes = Math.floor((nowMs - anchor.getTime()) / 60_000);
        return {
          id: r.id,
          userId: r.userId,
          merchantId: r.merchantId,
          state: r.state,
          paymentMethod: r.paymentMethod,
          stuckSince: anchor.toISOString(),
          ageMinutes,
          ctxOrderId: r.ctxOrderId,
          ctxOperatorId: r.ctxOperatorId,
        };
      }),
    };
    return c.json(body);
  } catch (err) {
    log.error({ err }, 'Admin stuck-orders query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute stuck orders' }, 500);
  }
}
