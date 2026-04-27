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
import { orders, userCredits, users, HOME_CURRENCIES } from '../db/schema.js';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { type User } from '../db/users.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'users' });

export interface UserMeView {
  id: string;
  email: string;
  isAdmin: boolean;
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
  return {
    id: row.id,
    email: row.email,
    isAdmin: row.isAdmin,
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
  const [updated] = await db
    .update(users)
    .set({ homeCurrency: parsed.data.currency, updatedAt: sql`NOW()` })
    .where(
      sql`${users.id} = ${user.id} AND NOT EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.userId} = ${user.id})`,
    )
    .returning();
  if (updated !== undefined) {
    return c.json<UserMeView>(await toView(updated));
  }

  // Zero rows updated: either the user has at least one order (locked)
  // or the user row vanished between resolve-and-update. Disambiguate
  // with a cheap existence probe so the client can render the right
  // copy — "contact support" for the locked case, a re-auth prompt
  // for the vanished case.
  const [stillExists] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (stillExists === undefined) {
    return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
  }
  return c.json(
    {
      code: 'HOME_CURRENCY_LOCKED',
      message: 'Home currency cannot be changed after placing an order',
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
