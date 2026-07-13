/**
 * User profile handlers.
 *
 * `GET /api/users/me` — returns the caller's Loop user profile. The
 * primary surface for the client to read `home_currency` (ADR 015)
 * + admin flag + email. Works for both Loop-native bearers (userId
 * comes straight off the JWT) and legacy CTX bearers (user row is
 * resolved via the existing CTX-anchored upsert path).
 *
 * `POST /api/users/me/home-currency` — first-time-only write path.
 * Onboarding UIs call this after OTP verify to set the user's
 * region. Guarded on `user.order_count === 0` at the DB layer:
 * once a user places their first order, pricing + cashback are
 * pinned to that row's `charge_currency` and letting the user
 * flip regions would misalign the ledger. Support has a separate
 * path to correct regions for existing users (not in this slice).
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { getStaffRole } from '../db/staff-roles.js';
import { orders, userCredits, users, HOME_CURRENCIES } from '../db/schema.js';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { type User } from '../db/users.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'users' });

export interface UserMeView {
  id: string;
  email: string;
  isAdmin: boolean;
  /**
   * ADR 037 staff role — 'admin' | 'support' | null (not staff).
   * Resolved with requireStaff semantics: staff_roles row wins,
   * legacy users.is_admin shim when no row exists.
   */
  staffRole: 'admin' | 'support' | null;
  /** ADR 015 — USD / GBP / EUR. Drives order denomination + cashback asset. */
  homeCurrency: string;
  /** ADR 015 — Stellar address for on-chain cashback payouts. Null when unlinked. */
  stellarAddress: string | null;
  /**
   * ADR 015 — off-chain cashback balance in `homeCurrency` minor units
   * (pence / cents), returned as a bigint-string to survive JSON
   * round-trips without precision loss. `"0"` when the user has no
   * ledger row yet (first-order users, pre-cashback). Cross-currency
   * balances from rare edge cases (support-mediated home-currency
   * flips) are not exposed here — they're admin-only.
   */
  homeCurrencyBalanceMinor: string;
}

/**
 * Looks up the user's off-chain cashback balance in their current
 * home currency. Returns `0n` when there's no matching row — the
 * normal state for anyone who hasn't earned cashback yet.
 */
async function resolveHomeCurrencyBalance(userId: string, homeCurrency: string): Promise<bigint> {
  const row = await db.query.userCredits.findFirst({
    where: and(eq(userCredits.userId, userId), eq(userCredits.currency, homeCurrency)),
  });
  return row?.balanceMinor ?? 0n;
}

export async function toView(row: User): Promise<UserMeView> {
  const balanceMinor = await resolveHomeCurrencyBalance(row.id, row.homeCurrency);
  // ADR 037: resolve the staff role with the same semantics as
  // requireStaff — staff_roles row wins; legacy users.is_admin shim
  // ('admin') when no row exists; lookup failure falls back to the
  // shim so /users/me never 500s on a staff-table blip.
  let staffRole: UserMeView['staffRole'] = null;
  try {
    const staffRow = await getStaffRole(row.id);
    staffRole = staffRow?.role ?? (row.isAdmin ? 'admin' : null);
  } catch {
    staffRole = row.isAdmin ? 'admin' : null;
  }
  return {
    id: row.id,
    email: row.email,
    isAdmin: row.isAdmin,
    staffRole,
    homeCurrency: row.homeCurrency,
    stellarAddress: row.stellarAddress,
    homeCurrencyBalanceMinor: balanceMinor.toString(),
  };
}

/**
 * A2-550 / A2-551 fix: identity is now resolved only from the
 * cryptographically-verified Loop-signed token. See
 * `apps/backend/src/auth/authenticated-user.ts` for the rationale.
 */
export async function resolveCallingUser(c: Context): Promise<User | null> {
  return await resolveLoopAuthenticatedUser(c);
}

export async function getMeHandler(c: Context): Promise<Response> {
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
  return c.json<UserMeView>(await toView(user));
}

const SetHomeCurrencyBody = z.object({
  currency: z.enum(HOME_CURRENCIES),
});

/**
 * POST /api/users/me/home-currency — onboarding-time picker.
 * Succeeds when the caller has zero orders; returns 409 otherwise so
 * the client can render a "contact support" path for existing users.
 */
export async function setHomeCurrencyHandler(c: Context): Promise<Response> {
  const parsed = SetHomeCurrencyBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: 'currency must be USD, GBP, or EUR',
      },
      400,
    );
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

  // Early-exit: no-op when the user is already on the requested
  // currency. Lets the client call this endpoint unconditionally
  // from onboarding without first checking `GET /me`.
  if (user.homeCurrency === parsed.data.currency) {
    return c.json<UserMeView>(await toView(user));
  }

  // Order guard — the ledger pins charge_currency at order creation
  // (ADR 015). Flipping home_currency after even one order would
  // leave future orders denominated in a different currency from the
  // user's balance. A2-552: collapsed count→update into a single
  // conditional UPDATE so a concurrent `POST /api/orders` can't slip
  // an order in between the lock check and the write. The NOT EXISTS
  // subquery is evaluated inside the UPDATE's statement-level snapshot,
  // closing the interleave window that made the previous two-statement
  // sequence visible to racing writers.
  // DOM-03 (money-correctness): mirror the ADMIN home-currency path's
  // non-zero-balance guard (`applyAdminHomeCurrencyChange` →
  // `HomeCurrencyHasLiveBalanceError` in ./home-currency-change.ts). A
  // live `user_credits` balance is denominated in the CURRENT home
  // currency; flipping home_currency without zeroing it first orphans
  // that balance — every user surface filters on
  // `charge_currency = user.home_currency`, so the row stays on the
  // ledger but goes invisible, mis-stating money. The admin path
  // rejects this; the self-serve path must too. Folded into the same
  // conditional UPDATE as the A2-552 order guard (second NOT EXISTS)
  // so the balance check shares the statement-level snapshot and a
  // concurrent credit-write can't slip a balance in between check and
  // write.
  const [updated] = await db
    .update(users)
    .set({ homeCurrency: parsed.data.currency, updatedAt: sql`NOW()` })
    .where(
      sql`${users.id} = ${user.id}
        AND NOT EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.userId} = ${user.id})
        AND NOT EXISTS (SELECT 1 FROM ${userCredits} WHERE ${userCredits.userId} = ${user.id} AND ${userCredits.currency} = ${user.homeCurrency} AND ${userCredits.balanceMinor} <> 0)`,
    )
    .returning();
  if (updated !== undefined) {
    return c.json<UserMeView>(await toView(updated));
  }

  // Zero rows updated: the user vanished between resolve-and-update,
  // OR one of the two guards blocked the write. Disambiguate so the
  // client can render the right copy.
  const [stillExists] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (stillExists === undefined) {
    return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
  }

  // Order guard keeps precedence — the "first-time-only" contract and
  // its "contact support" client copy predate the balance guard, so a
  // user who has placed an order still sees HOME_CURRENCY_LOCKED.
  const [hasOrder] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.userId, user.id))
    .limit(1);
  if (hasOrder !== undefined) {
    return c.json(
      {
        code: 'HOME_CURRENCY_LOCKED',
        message: 'Home currency cannot be changed after placing an order',
      },
      409,
    );
  }

  // No orders, so the only remaining blocking predicate is the live-
  // balance guard. Surface the SAME error the admin path returns
  // (code + message shape) so the two surfaces are indistinguishable.
  const liveBalanceMinor = await resolveHomeCurrencyBalance(user.id, user.homeCurrency);
  return c.json(
    {
      code: 'HOME_CURRENCY_HAS_LIVE_BALANCE',
      message: `User has a non-zero ${user.homeCurrency} credit balance (${liveBalanceMinor} minor) — zero it via a credit-adjustment before changing home currency`,
    },
    409,
  );
}

// `setStellarAddressHandler` (ADR 015 wallet-link mutation) lives
// in `./stellar-address-handler.ts`. Re-exported here so
// `routes/users.ts` and the test suite keep resolving against
// `'../users/handler.js'`.
export { setStellarAddressHandler } from './stellar-address-handler.js';

// Cashback-history + credits handlers (3 functions covering
// /cashback-history list + .csv export + /credits balance) live
// in `./cashback-history-handler.ts`. Re-exported here so the
// routes module's existing import block keeps working without
// re-targeting.
export {
  getCashbackHistoryHandler,
  getCashbackHistoryCsvHandler,
  getUserCreditsHandler,
  type CashbackHistoryEntry,
  type CashbackHistoryResponse,
  type UserCreditRow,
  type UserCreditsResponse,
} from './cashback-history-handler.js';

// Pending-payouts handlers (4 functions) live in
// `./pending-payouts-handler.ts`. Re-exported here so the routes
// module's existing import block keeps working without
// re-targeting.
export {
  getUserPendingPayoutsHandler,
  getUserPendingPayoutsSummaryHandler,
  getUserPendingPayoutDetailHandler,
  getUserPayoutByOrderHandler,
  type UserPendingPayoutView,
  type UserPendingPayoutsResponse,
  type UserPendingPayoutsSummaryRow,
  type UserPendingPayoutsSummaryResponse,
} from './pending-payouts-handler.js';

// Cashback-summary handler (1 function — the lifetime + MTD
// headline) lives in `./cashback-summary-handler.ts`. Re-exported
// here so the routes module's existing import block keeps working
// without re-targeting.
export { getCashbackSummaryHandler, type UserCashbackSummary } from './cashback-summary-handler.js';

// DSR handlers (2 functions covering data-subject-rights export +
// delete, A2-1905 + A2-1906) live in `./dsr-handler.ts`. Re-
// exported here so the routes module's existing import block keeps
// working without re-targeting.
export { dsrExportHandler, dsrDeleteHandler } from './dsr-handler.js';
