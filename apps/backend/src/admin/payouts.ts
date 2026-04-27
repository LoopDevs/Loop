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
import { UUID_RE } from '../uuid.js';
import { PAYOUT_STATES } from '../db/schema.js';
import { LOOP_ASSET_CODES } from '../credits/payout-asset.js';
import {
  getPayoutByOrderId,
  getPayoutForAdmin,
  listPayoutsForAdmin,
} from '../credits/pending-payouts.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-payouts' });

export interface AdminPayoutView {
  id: string;
  userId: string;
  /**
   * ADR-024 §2: NULL for `kind='withdrawal'` rows. Pre-this-ADR every
   * payout was order-funded so the field was always populated; that's
   * no longer true.
   */
  orderId: string | null;
  /** ADR-024 §2 discriminator — `order_cashback` or `withdrawal`. */
  kind: 'order_cashback' | 'withdrawal';
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
  orderId: string | null;
  kind: 'order_cashback' | 'withdrawal';
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
    kind: row.kind,
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

  const userIdParam = c.req.query('userId');
  if (userIdParam !== undefined && !UUID_RE.test(userIdParam)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }

  // Pin to the enumerated LOOP_ASSET_CODES — lets a malformed asset
  // 400 up front rather than returning an empty page, which ops might
  // misread as "no stuck payouts for this asset".
  const assetCodeParam = c.req.query('assetCode');
  if (
    assetCodeParam !== undefined &&
    !(LOOP_ASSET_CODES as ReadonlyArray<string>).includes(assetCodeParam)
  ) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: `assetCode must be one of: ${LOOP_ASSET_CODES.join(', ')}`,
      },
      400,
    );
  }

  // ADR-024 §2: kind discriminator filter. Treasury wants to split
  // order-cashback (cashback owed on a fulfilled order) from
  // withdrawal (admin cash-out from balance) flows visually.
  const kindParam = c.req.query('kind');
  if (kindParam !== undefined && kindParam !== 'order_cashback' && kindParam !== 'withdrawal') {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: 'kind must be one of: order_cashback, withdrawal',
      },
      400,
    );
  }

  const rows = await listPayoutsForAdmin({
    ...(stateParam !== undefined ? { state: stateParam } : {}),
    ...(userIdParam !== undefined ? { userId: userIdParam } : {}),
    ...(assetCodeParam !== undefined ? { assetCode: assetCodeParam } : {}),
    ...(kindParam !== undefined ? { kind: kindParam } : {}),
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

// `adminRetryPayoutHandler` (POST /api/admin/payouts/:id/retry —
// the ADR-017 admin write) lives in `./payouts-retry.ts`. Re-
// exported here so the routes module's existing import block
// keeps working without re-targeting.
export { adminRetryPayoutHandler } from './payouts-retry.js';
