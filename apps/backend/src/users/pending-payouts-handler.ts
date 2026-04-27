/**
 * Caller-scoped pending-payouts handlers (ADR 015 / 016 / 024).
 *
 * Lifted out of `apps/backend/src/users/handler.ts`. Four handlers
 * that back the user-side pending-payouts surface — the same paths
 * the openapi spec splits into `./openapi/users-pending-payouts.ts`:
 *
 *   - GET /api/users/me/pending-payouts          → getUserPendingPayoutsHandler
 *   - GET /api/users/me/pending-payouts/summary  → getUserPendingPayoutsSummaryHandler
 *   - GET /api/users/me/pending-payouts/{id}     → getUserPendingPayoutDetailHandler
 *   - GET /api/users/me/orders/{orderId}/payout  → getUserPayoutByOrderHandler
 *
 * The `UserPendingPayoutView` and `UserPendingPayoutsResponse`
 * interfaces travel with the slice — they\'re only referenced by
 * the four handlers + the openapi spec\'s schema mirror.
 */
import type { Context } from 'hono';
import { PAYOUT_STATES } from '../db/schema.js';
import { listPayoutsForUser, pendingPayoutsSummaryForUser } from '../credits/pending-payouts.js';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { type User } from '../db/users.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'users' });

async function resolveCallingUser(c: Context): Promise<User | null> {
  return await resolveLoopAuthenticatedUser(c);
}

/**
 * `GET /api/users/me/pending-payouts` — caller's on-chain payout
 * rows (ADR 015 / 016). Each row tracks the lifecycle of one outbound
 * LOOP-asset payment (pending → submitted → confirmed | failed) so
 * the user can see "your £5 cashback is queued" or "payout confirmed
 * — tx abc123" rather than just watching the off-chain balance
 * change.
 *
 * Scoped to the authenticated caller — `userId` pinned from the
 * bearer, no admin-privileged cross-user access from this endpoint.
 * Same pagination shape as `/cashback-history`: `?state=`, `?before=`,
 * `?limit=` (default 20, cap 100).
 */
export interface UserPendingPayoutView {
  id: string;
  /** Null for `kind='withdrawal'` payouts (A2-901 / ADR-024 §2). */
  orderId: string | null;
  assetCode: string;
  assetIssuer: string;
  /** Stroops (7 decimals). BigInt as string — JSON-safe. */
  amountStroops: string;
  state: (typeof PAYOUT_STATES)[number];
  /** Confirmed tx hash; null until the payout is confirmed on Stellar. */
  txHash: string | null;
  attempts: number;
  createdAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
}

export interface UserPendingPayoutsResponse {
  payouts: UserPendingPayoutView[];
}

export async function getUserPendingPayoutsHandler(c: Context): Promise<Response> {
  // ?state filter — optional; reject unknowns rather than silently
  // returning the unfiltered list. Mirrors the admin endpoint.
  const stateRaw = c.req.query('state');
  if (stateRaw !== undefined && !(PAYOUT_STATES as ReadonlyArray<string>).includes(stateRaw)) {
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

  let user: User | null;
  try {
    user = await resolveCallingUser(c);
  } catch (err) {
    log.error({ err }, 'Failed to resolve calling user');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to resolve user' }, 500);
  }
  if (user === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  const rows = await listPayoutsForUser(user.id, {
    ...(stateRaw !== undefined ? { state: stateRaw } : {}),
    ...(before !== undefined ? { before } : {}),
    limit,
  });

  return c.json<UserPendingPayoutsResponse>({
    payouts: rows.map((row) => ({
      id: row.id,
      orderId: row.orderId,
      assetCode: row.assetCode,
      assetIssuer: row.assetIssuer,
      amountStroops: row.amountStroops.toString(),
      state: row.state as (typeof PAYOUT_STATES)[number],
      txHash: row.txHash,
      attempts: row.attempts,
      createdAt: row.createdAt.toISOString(),
      submittedAt: row.submittedAt?.toISOString() ?? null,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      failedAt: row.failedAt?.toISOString() ?? null,
    })),
  });
}

export interface UserPendingPayoutsSummaryRow {
  assetCode: string;
  state: 'pending' | 'submitted';
  count: number;
  /** Stroops as bigint-string — JSON-safe. */
  totalStroops: string;
  /** ISO-8601 of the oldest row in this (asset, state) bucket. */
  oldestCreatedAt: string;
}

export interface UserPendingPayoutsSummaryResponse {
  rows: UserPendingPayoutsSummaryRow[];
}

/**
 * `GET /api/users/me/pending-payouts/summary` — caller-scoped
 * aggregate view of pending / submitted payouts, bucketed by
 * (asset_code, state). One round-trip replaces paging through the
 * full list when a UI only needs "you have $X cashback settling"
 * signal.
 *
 * Confirmed rows are deliberately excluded (they've landed on-chain
 * — the user reads them in the cashback history feed instead) as
 * are failed rows (they belong to the admin retry flow, not the
 * user's in-flight view). Empty response when the caller has no
 * in-flight payouts.
 */
export async function getUserPendingPayoutsSummaryHandler(c: Context): Promise<Response> {
  let user: User | null;
  try {
    user = await resolveCallingUser(c);
  } catch (err) {
    log.error({ err }, 'Failed to resolve calling user');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to resolve user' }, 500);
  }
  if (user === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  const rows = await pendingPayoutsSummaryForUser(user.id);
  return c.json<UserPendingPayoutsSummaryResponse>({
    rows: rows.map((r) => ({
      assetCode: r.assetCode,
      state: r.state as 'pending' | 'submitted',
      count: r.count,
      totalStroops: r.totalStroops.toString(),
      oldestCreatedAt: new Date(r.oldestCreatedAtMs).toISOString(),
    })),
  });
}

// `getUserPendingPayoutDetailHandler` and
// `getUserPayoutByOrderHandler` (the two single-row drill
// handlers) live in `./pending-payouts-detail.ts`. Re-exported
// below so existing import sites against
// `'./pending-payouts-handler.js'` keep resolving.
export {
  getUserPendingPayoutDetailHandler,
  getUserPayoutByOrderHandler,
} from './pending-payouts-detail.js';
