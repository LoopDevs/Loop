/**
 * Admin stuck-orders triage.
 *
 * `GET /api/admin/stuck-orders` — orders CTX has taken payment for but
 * that Loop has not yet seen fulfilled, older than a threshold. The
 * admin dashboard renders this as the "needs attention" card, and
 * anything landing here means the mirror is behind: the giftcard ws
 * dropped an event and the sweep hasn't caught up, or CTX itself is
 * stuck on the card.
 *
 * `unpaid` rows are excluded — those are waiting on the customer, not
 * on us — and the terminal states never appear. The support action
 * from here is the per-order re-drive, which runs the same sweep step
 * on demand.
 *
 * Support-tier: an operator cannot explain a stuck order to a customer
 * without first being able to see that it is stuck (ADR 037 §3).
 */
import type { Context } from 'hono';
import { db } from '../db/client.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-stuck-orders' });

/**
 * Deliberately earlier than any automatic action. An operator should
 * see a row here well before a background sweep gives up on it, not
 * learn about the incident afterwards from an alert.
 */
export const DEFAULT_THRESHOLD_MINUTES = 5;
const MAX_THRESHOLD_MINUTES = 60 * 24 * 7; // a week
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface StuckOrderRow {
  id: string;
  userId: string;
  merchantId: string;
  state: string;
  ctxOrderId: string | null;
  ctxPaymentId: string | null;
  chargeCurrency: string;
  chargeMinor: number;
  /** How long the row has sat where it is, at request time. */
  ageMinutes: number;
  createdAt: string;
}

export interface StuckOrdersResponse {
  thresholdMinutes: number;
  rows: StuckOrderRow[];
}

export async function adminStuckOrdersHandler(c: Context): Promise<Response> {
  const thresholdRaw = c.req.query('thresholdMinutes');
  const parsedThreshold = Number.parseInt(thresholdRaw ?? String(DEFAULT_THRESHOLD_MINUTES), 10);
  const thresholdMinutes = Math.min(
    Math.max(Number.isNaN(parsedThreshold) ? DEFAULT_THRESHOLD_MINUTES : parsedThreshold, 1),
    MAX_THRESHOLD_MINUTES,
  );

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? String(DEFAULT_LIMIT), 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit, 1),
    MAX_LIMIT,
  );

  try {
    const now = Date.now();
    const cutoff = new Date(now - thresholdMinutes * 60 * 1000);
    const rows = await db.collection('orders').findMany(
      { state: 'paid', createdAt: { $lt: cutoff } },
      // Oldest first: the row that has been stuck longest is the one
      // an operator should look at first.
      { sort: [['createdAt', 'asc']], limit },
    );

    return c.json<StuckOrdersResponse>({
      thresholdMinutes,
      rows: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        merchantId: row.merchantId,
        state: row.state,
        ctxOrderId: row.ctxOrderId,
        ctxPaymentId: row.ctxPaymentId,
        chargeCurrency: row.chargeCurrency,
        chargeMinor: row.chargeMinor,
        ageMinutes: Math.floor((now - row.createdAt.getTime()) / 60_000),
        createdAt: row.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    log.error({ err }, 'Admin stuck-orders query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load stuck orders' }, 500);
  }
}
