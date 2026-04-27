/**
 * Caller-scoped single-row pending-payout detail handlers
 * (ADR 015 / 016).
 *
 * Lifted out of `apps/backend/src/users/pending-payouts-handler.ts`
 * so the two single-row drill handlers live in their own focused
 * module separate from the list + summary aggregates in the
 * parent file:
 *
 *   - `getUserPendingPayoutDetailHandler` —
 *     `GET /api/users/me/pending-payouts/{id}`, permalink for
 *     one of the caller's payout rows.
 *   - `getUserPayoutByOrderHandler` —
 *     `GET /api/users/me/orders/{orderId}/payout`, jumps from
 *     a caller's order id to the matching payout row.
 *
 * Both 404 on cross-user access (ownership-scoped) so payout
 * ids and order ids stay non-enumerable.
 *
 * Re-exported from `pending-payouts-handler.ts` so the existing
 * import path used by `routes/users.ts` and the test suite
 * resolves unchanged.
 */
import type { Context } from 'hono';
import { UUID_RE } from '../uuid.js';
import type { PAYOUT_STATES } from '../db/schema.js';
import { getPayoutByOrderIdForUser, getPayoutForUser } from '../credits/pending-payouts.js';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { type User } from '../db/users.js';
import { logger } from '../logger.js';
import type { UserPendingPayoutView } from './pending-payouts-handler.js';

const log = logger.child({ handler: 'users' });

async function resolveCallingUser(c: Context): Promise<User | null> {
  return await resolveLoopAuthenticatedUser(c);
}

/**
 * `GET /api/users/me/pending-payouts/:id` — caller-scoped
 * permalink for one of their own payout rows. The settings/cashback
 * page deep-links each list row to this endpoint so the user can
 * bookmark / share a link with support when asking why a cashback
 * payout is stuck.
 *
 * Cross-user access returns 404 (not 403) — enumerating other
 * users' payout ids should be indistinguishable from a genuine miss.
 */
export async function getUserPendingPayoutDetailHandler(c: Context): Promise<Response> {
  const id = c.req.param('id');
  if (id === undefined || id.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id is required' }, 400);
  }
  if (!UUID_RE.test(id)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id must be a uuid' }, 400);
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

  const row = await getPayoutForUser(id, user.id);
  if (row === null) {
    return c.json({ code: 'NOT_FOUND', message: 'Payout not found' }, 404);
  }

  return c.json<UserPendingPayoutView>({
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
  });
}

/**
 * `GET /api/users/me/orders/:orderId/payout` — for one of the
 * caller's own orders, return the single pending-payout row tied to
 * it (if any). Mirror of `/api/admin/orders/:orderId/payout` but
 * ownership-scoped: cross-user access returns 404 (not 403) so
 * order ids aren't enumerable.
 *
 * Powers a per-order cashback-settlement card on `/orders/:id` so
 * users can see their Stellar-side state ("pending / submitted /
 * confirmed / failed") without scrolling the global payouts list.
 * 404 covers both "order doesn't exist" and "order exists but
 * belongs to someone else" — same copy on the client.
 */
export async function getUserPayoutByOrderHandler(c: Context): Promise<Response> {
  const orderId = c.req.param('orderId');
  if (orderId === undefined || orderId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'orderId is required' }, 400);
  }
  if (!UUID_RE.test(orderId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'orderId must be a uuid' }, 400);
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

  const row = await getPayoutByOrderIdForUser(orderId, user.id);
  if (row === null) {
    return c.json({ code: 'NOT_FOUND', message: 'No payout for this order' }, 404);
  }

  return c.json<UserPendingPayoutView>({
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
  });
}
