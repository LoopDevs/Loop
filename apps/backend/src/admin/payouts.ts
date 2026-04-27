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
import { listPayoutsForAdmin } from '../credits/pending-payouts.js';

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

export interface PayoutRow {
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

export function toView(row: PayoutRow): AdminPayoutView {
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

// `adminGetPayoutHandler` and `adminPayoutByOrderHandler` (the two
// single-row drill handlers) live in `./payouts-detail.ts`.
// Re-exported below so existing import sites against
// `'../admin/payouts.js'` keep resolving.
export { adminGetPayoutHandler, adminPayoutByOrderHandler } from './payouts-detail.js';

// `adminRetryPayoutHandler` (POST /api/admin/payouts/:id/retry —
// the ADR-017 admin write) lives in `./payouts-retry.ts`. Re-
// exported here so the routes module's existing import block
// keeps working without re-targeting.
export { adminRetryPayoutHandler } from './payouts-retry.js';
