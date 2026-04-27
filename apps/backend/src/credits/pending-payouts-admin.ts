/**
 * Admin-side `pending_payouts` reads.
 *
 * Lifted out of `apps/backend/src/credits/pending-payouts.ts` so
 * the three admin-only read paths (`listPayoutsForAdmin`,
 * `getPayoutForAdmin`, `getPayoutByOrderId`) live in their own
 * focused module separate from the worker-facing reads + state
 * transitions in the parent file. The split mirrors the existing
 * user-side split (`./pending-payouts-user.ts`), keeping each
 * audience's reads next to each other.
 *
 * Re-exported from `pending-payouts.ts` so the wide network of
 * call sites — handlers, tests, OpenAPI registrations — keeps
 * importing from the historical `'../credits/pending-payouts.js'`
 * path without a re-target.
 */
import { and, desc, eq, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pendingPayouts } from '../db/schema.js';
import type { PendingPayout } from './pending-payouts.js';

/**
 * Admin paginated list. Filters on optional `state`, `userId`,
 * `assetCode`, `kind`. Cursor-paged via `before` (createdAt). Newest-
 * first (admin UI pattern — you want to see the most recent failures
 * first when you open the page). `before` is the ISO `created_at` of
 * the last row the client has rendered; next page fetches rows older
 * than that. Limit clamps 1..100.
 */
export async function listPayoutsForAdmin(opts: {
  state?: string;
  userId?: string;
  assetCode?: string;
  /** ADR-024 §2: filter by payout discriminator. Lets treasury split order-cashback from withdrawal flows visually. */
  kind?: 'order_cashback' | 'withdrawal';
  before?: Date;
  limit?: number;
}): Promise<PendingPayout[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const conditions = [];
  if (opts.state !== undefined) conditions.push(eq(pendingPayouts.state, opts.state));
  if (opts.userId !== undefined) conditions.push(eq(pendingPayouts.userId, opts.userId));
  if (opts.assetCode !== undefined) conditions.push(eq(pendingPayouts.assetCode, opts.assetCode));
  if (opts.kind !== undefined) conditions.push(eq(pendingPayouts.kind, opts.kind));
  // A2-1610: typed `lt()` + `desc()` — postgres-js can't bind a Date
  // through the raw sql interpolator. See `audit-tail-csv.ts`.
  if (opts.before !== undefined) conditions.push(lt(pendingPayouts.createdAt, opts.before));
  const where = conditions.length === 0 ? undefined : and(...conditions);
  const q = db.select().from(pendingPayouts);
  const filtered = where === undefined ? q : q.where(where);
  return filtered.orderBy(desc(pendingPayouts.createdAt)).limit(limit);
}

/**
 * Single-row lookup for the admin drill-down (complement to the list
 * at `listPayoutsForAdmin`). Returns null when the id matches nothing;
 * the handler turns that into a 404.
 */
export async function getPayoutForAdmin(id: string): Promise<PendingPayout | null> {
  const [row] = await db.select().from(pendingPayouts).where(eq(pendingPayouts.id, id)).limit(1);
  return row ?? null;
}

/**
 * Order-id lookup. `pending_payouts.order_id` is UNIQUE, so at most
 * one row matches. Returns null when the order has no payout row yet
 * (e.g. cashback hasn't been issued, the order is still pending, or
 * the payout builder deliberately skipped this order).
 *
 * Ops uses this to jump from an order-support ticket straight to the
 * payout state instead of fishing for the payout id in the list.
 */
export async function getPayoutByOrderId(orderId: string): Promise<PendingPayout | null> {
  const [row] = await db
    .select()
    .from(pendingPayouts)
    .where(eq(pendingPayouts.orderId, orderId))
    .limit(1);
  return row ?? null;
}
