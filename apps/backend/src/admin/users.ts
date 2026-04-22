/**
 * Admin user drill-down (ADR 011 / 015).
 *
 * `GET /api/admin/users/:userId` — one-shot summary for the admin
 * UI's user-detail page. Collapses the info an operator usually
 * wants when triaging a specific user (email thread, support reply,
 * audit request):
 *
 *   - identity (email, homeCurrency, stellarAddress, isAdmin, createdAt)
 *   - off-chain balance in home currency (user_credits.balance_minor)
 *   - lifetime cashback earned — sum of positive credit_transactions
 *     rows with type='cashback' in the user's home currency (ADR 015)
 *   - total order count + pending-payout row count
 *
 * Deliberately *does not* inline recent orders / payouts. The admin
 * already has /admin/orders?userId=X and /admin/payouts?userId=X
 * drill-downs for paginated detail — duplicating them here would
 * add latency + open questions about which view is authoritative.
 *
 * Auth: layered `requireAuth` + `requireAdmin` on the `/api/admin/*`
 * prefix. A non-admin call is 403 at the middleware boundary before
 * reaching this handler.
 */
import type { Context } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, userCredits, creditTransactions, orders, pendingPayouts } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-users' });

/**
 * RFC 4122 UUID shape (any version / variant). Mirrors the regex
 * used by /admin/orders + /admin/payouts so the validation story is
 * consistent across the admin surface.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminUserView {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: 'USD' | 'GBP' | 'EUR';
  stellarAddress: string | null;
  createdAt: string;
  /** Current off-chain balance in home-currency minor units. BigInt-string. */
  balanceMinor: string;
  /** Lifetime sum of cashback credits in home currency. BigInt-string. */
  lifetimeCashbackEarnedMinor: string;
  /** Total orders across every state. BigInt-string. */
  orderCount: string;
  /** pending_payouts rows still open (pending + submitted). BigInt-string. */
  pendingPayoutCount: string;
}

/** GET /api/admin/users/:userId */
export async function adminGetUserHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || !UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a UUID' }, 400);
  }

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      isAdmin: users.isAdmin,
      homeCurrency: users.homeCurrency,
      stellarAddress: users.stellarAddress,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (row === undefined) {
    return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
  }

  // Four cheap aggregations run in parallel. Each is a single-row
  // COALESCE(SUM|COUNT, 0) so the handler's shape never has to branch
  // on "table empty for this user" (that's already the 0 case).
  const [balanceRow, lifetimeRow, orderCountRow, pendingPayoutRow] = await Promise.all([
    db
      .select({
        total: sql<string>`COALESCE(SUM(${userCredits.balanceMinor}), 0)::text`,
      })
      .from(userCredits)
      .where(and(eq(userCredits.userId, userId), eq(userCredits.currency, row.homeCurrency))),
    db
      .select({
        total: sql<string>`COALESCE(SUM(${creditTransactions.amountMinor}), 0)::text`,
      })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.userId, userId),
          eq(creditTransactions.currency, row.homeCurrency),
          eq(creditTransactions.type, 'cashback'),
          sql`${creditTransactions.amountMinor} > 0`,
        ),
      ),
    db
      .select({ count: sql<string>`COUNT(*)::text` })
      .from(orders)
      .where(eq(orders.userId, userId)),
    db
      .select({ count: sql<string>`COUNT(*)::text` })
      .from(pendingPayouts)
      .where(
        and(
          eq(pendingPayouts.userId, userId),
          sql`${pendingPayouts.state} IN ('pending', 'submitted')`,
        ),
      ),
  ]);

  const view: AdminUserView = {
    id: row.id,
    email: row.email,
    isAdmin: row.isAdmin,
    // DB CHECK already constrains this to the three-value enum; cast
    // is load-bearing for the client type only.
    homeCurrency: row.homeCurrency as 'USD' | 'GBP' | 'EUR',
    stellarAddress: row.stellarAddress,
    createdAt: row.createdAt.toISOString(),
    balanceMinor: balanceRow[0]?.total ?? '0',
    lifetimeCashbackEarnedMinor: lifetimeRow[0]?.total ?? '0',
    orderCount: orderCountRow[0]?.count ?? '0',
    pendingPayoutCount: pendingPayoutRow[0]?.count ?? '0',
  };

  log.debug({ userId }, 'admin user drill-down served');
  return c.json({ user: view });
}
