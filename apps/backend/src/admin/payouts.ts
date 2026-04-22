/**
 * Admin payout-backlog view (ADR 015).
 *
 * `GET /api/admin/payouts` — paginated list of `pending_payouts`
 * rows for the admin UI's "payouts" page. Filter on `?state=failed`
 * to drill into stuck rows, pass `?before=<iso>` to page older.
 *
 * The treasury snapshot (#349) exposes per-state counts for the
 * at-a-glance card; this endpoint is what the operator clicks
 * through to when they want to see which orders / which users are
 * in each bucket.
 */
import type { Context } from 'hono';
import { PAYOUT_STATES } from '../db/schema.js';
import {
  getPayoutByOrderId,
  getPayoutForAdmin,
  listPayoutsForAdmin,
  resetPayoutToPending,
} from '../credits/pending-payouts.js';
import { logger } from '../logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const log = logger.child({ handler: 'admin-payouts' });

export interface AdminPayoutView {
  id: string;
  userId: string;
  orderId: string;
  assetCode: string;
  assetIssuer: string;
  toAddress: string;
  amountStroops: string;
  memoText: string;
  state: string;
  txHash: string | null;
  lastError: string | null;
  attempts: number;
  createdAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
}

interface PayoutRow {
  id: string;
  userId: string;
  orderId: string;
  assetCode: string;
  assetIssuer: string;
  toAddress: string;
  amountStroops: bigint;
  memoText: string;
  state: string;
  txHash: string | null;
  lastError: string | null;
  attempts: number;
  createdAt: Date;
  submittedAt: Date | null;
  confirmedAt: Date | null;
  failedAt: Date | null;
}

function toView(row: PayoutRow): AdminPayoutView {
  return {
    id: row.id,
    userId: row.userId,
    orderId: row.orderId,
    assetCode: row.assetCode,
    assetIssuer: row.assetIssuer,
    toAddress: row.toAddress,
    amountStroops: row.amountStroops.toString(),
    memoText: row.memoText,
    state: row.state,
    txHash: row.txHash,
    lastError: row.lastError,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
  };
}

export async function adminListPayoutsHandler(c: Context): Promise<Response> {
  const stateParam = c.req.query('state');
  if (stateParam !== undefined && !(PAYOUT_STATES as ReadonlyArray<string>).includes(stateParam)) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: `state must be one of: ${PAYOUT_STATES.join(', ')}`,
      },
      400,
    );
  }

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? '20', 10);
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 20 : parsedLimit, 1), 100);

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

  const rows = await listPayoutsForAdmin({
    ...(stateParam !== undefined ? { state: stateParam } : {}),
    ...(before !== undefined ? { before } : {}),
    limit,
  });
  return c.json({ payouts: rows.map((r) => toView(r as PayoutRow)) });
}

/**
 * GET /api/admin/payouts/:id — single-row drill-down. The list
 * endpoint at `/api/admin/payouts` truncates the admin UI at 100 rows
 * and has no per-row permalink; this endpoint is what the admin table
 * links each row to so ops can deep-link a specific stuck payout into
 * a ticket / incident note without hunting for the row in the list.
 *
 * 400 on missing / malformed id (must be a uuid — the column is a uuid
 * pk, so anything else is guaranteed to miss). 404 when the row
 * doesn't exist. 500 on repo throw.
 */
export async function adminGetPayoutHandler(c: Context): Promise<Response> {
  const id = c.req.param('id');
  if (id === undefined || id.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id is required' }, 400);
  }
  if (!UUID_RE.test(id)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id must be a uuid' }, 400);
  }
  try {
    const row = await getPayoutForAdmin(id);
    if (row === null) {
      return c.json({ code: 'NOT_FOUND', message: 'Payout not found' }, 404);
    }
    return c.json<AdminPayoutView>(toView(row as PayoutRow));
  } catch (err) {
    log.error({ err, payoutId: id }, 'Admin payout detail failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch payout' }, 500);
  }
}

/**
 * GET /api/admin/orders/:orderId/payout — given an order id, return
 * the single pending_payouts row associated with it (UNIQUE on
 * order_id). Ops hits this when a user raises a support ticket
 * quoting an order id — saves them fishing through the payout list
 * for the matching row.
 *
 * 400 on missing / non-uuid order id, 404 when the order has no
 * payout row yet (common — the payout builder only runs once
 * cashback is due). 500 on repo throw.
 */
export async function adminPayoutByOrderHandler(c: Context): Promise<Response> {
  const orderId = c.req.param('orderId');
  if (orderId === undefined || orderId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'orderId is required' }, 400);
  }
  if (!UUID_RE.test(orderId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'orderId must be a uuid' }, 400);
  }
  try {
    const row = await getPayoutByOrderId(orderId);
    if (row === null) {
      return c.json({ code: 'NOT_FOUND', message: 'No payout for this order' }, 404);
    }
    return c.json<AdminPayoutView>(toView(row as PayoutRow));
  } catch (err) {
    log.error({ err, orderId }, 'Admin payout-by-order lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch payout' }, 500);
  }
}

/**
 * POST /api/admin/payouts/:id/retry — flip a `failed` row back to
 * `pending` so the submit worker picks it up on the next tick. Admin
 * use only: unbounded-retry from the worker itself would mask real
 * issues, so retry is a manual ops action with an audit trail via
 * the admin user context (set by `requireAdmin`).
 *
 * Returns the updated row on success, 404 when the id doesn't match
 * a `failed` row (either it doesn't exist or it's in a non-failed
 * state — admin UI should refresh the list).
 */
export async function adminRetryPayoutHandler(c: Context): Promise<Response> {
  const id = c.req.param('id');
  if (id === undefined || id.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id is required' }, 400);
  }
  try {
    const row = await resetPayoutToPending(id);
    if (row === null) {
      return c.json({ code: 'NOT_FOUND', message: 'Payout not found or not in failed state' }, 404);
    }
    log.info({ payoutId: id }, 'Payout reset to pending by admin retry');
    return c.json<AdminPayoutView>(toView(row as PayoutRow));
  } catch (err) {
    log.error({ err, payoutId: id }, 'Admin retry failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to retry payout' }, 500);
  }
}
