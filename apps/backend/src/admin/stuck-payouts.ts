/**
 * Admin stuck-payouts triage (ADR 015 / 016).
 *
 * `GET /api/admin/stuck-payouts` — pending_payouts rows that should
 * have confirmed on Stellar by now but haven't. Mirrors the stuck-
 * orders page's shape so ops can triage both backlogs from the same
 * dashboard:
 *   - state=submitted older than thresholdMinutes → the Horizon
 *     confirmation watcher hasn't seen the tx land yet (network
 *     congestion? watcher bug? account out of funds? wrong memo?)
 *   - state=pending older than thresholdMinutes → the submit worker
 *     hasn't picked the row up at all (scheduler stalled, operator
 *     account unfunded, asset issuer misconfigured)
 *
 * Failed rows are deliberately excluded — they're not stuck, they're
 * terminal, and /admin/payouts?state=failed is already the review
 * surface for those. Confirmed is terminal from Loop's POV.
 *
 * Default threshold 5 minutes; clamped 1..10080 (1 week). Default
 * limit 20; hard cap 100.
 */
import type { Context } from 'hono';
import { and, asc, inArray, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pendingPayouts } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-stuck-payouts' });

const DEFAULT_THRESHOLD_MINUTES = 5;
const MAX_THRESHOLD_MINUTES = 60 * 24 * 7; // 1 week
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Non-terminal states a row can stick in. */
const STUCK_STATES = ['pending', 'submitted'] as const;

export interface StuckPayoutRow {
  id: string;
  userId: string;
  orderId: string;
  assetCode: string;
  /** Bigint-as-string stroops (7 decimals). */
  amountStroops: string;
  state: string;
  /**
   * The ISO timestamp that keyed this row as stuck: `submittedAt` for
   * a submitted row (that's when Horizon took the tx and the clock
   * started), `createdAt` for a pending row (the submit worker
   * should have picked it up by now).
   */
  stuckSince: string;
  /** Elapsed minutes since stuckSince. */
  ageMinutes: number;
  attempts: number;
}

export interface StuckPayoutsResponse {
  thresholdMinutes: number;
  rows: StuckPayoutRow[];
}

interface DbRow {
  id: string;
  userId: string;
  orderId: string;
  assetCode: string;
  amountStroops: bigint;
  state: string;
  attempts: number;
  createdAt: Date;
  submittedAt: Date | null;
}

export async function adminStuckPayoutsHandler(c: Context): Promise<Response> {
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
    // Key the cutoff on createdAt — the submit worker picks the
    // oldest pending row first, so a submitted row that's past the
    // threshold by createdAt is also past-SLO by submittedAt (submit
    // can't happen before create). Keeps the query single-index.
    const rows = (await db
      .select({
        id: pendingPayouts.id,
        userId: pendingPayouts.userId,
        orderId: pendingPayouts.orderId,
        assetCode: pendingPayouts.assetCode,
        amountStroops: pendingPayouts.amountStroops,
        state: pendingPayouts.state,
        attempts: pendingPayouts.attempts,
        createdAt: pendingPayouts.createdAt,
        submittedAt: pendingPayouts.submittedAt,
      })
      .from(pendingPayouts)
      .where(
        and(
          inArray(pendingPayouts.state, STUCK_STATES as unknown as string[]),
          lt(pendingPayouts.createdAt, cutoff),
        ),
      )
      .orderBy(asc(pendingPayouts.createdAt))
      .limit(limit)) as DbRow[];

    const nowMs = Date.now();
    const body: StuckPayoutsResponse = {
      thresholdMinutes,
      rows: rows.map((r) => {
        const anchor = r.state === 'submitted' ? (r.submittedAt ?? r.createdAt) : r.createdAt;
        const ageMinutes = Math.floor((nowMs - anchor.getTime()) / 60_000);
        return {
          id: r.id,
          userId: r.userId,
          orderId: r.orderId,
          assetCode: r.assetCode,
          amountStroops: r.amountStroops.toString(),
          state: r.state,
          stuckSince: anchor.toISOString(),
          ageMinutes,
          attempts: r.attempts,
        };
      }),
    };
    return c.json(body);
  } catch (err) {
    log.error({ err }, 'Admin stuck-payouts query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute stuck payouts' }, 500);
  }
}
