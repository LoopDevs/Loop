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
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  creditTransactions,
  orders,
  userCredits,
  users,
  HOME_CURRENCIES,
  PAYOUT_STATES,
} from '../db/schema.js';
import { listPayoutsForUser } from '../credits/pending-payouts.js';
import { getMerchants } from '../merchants/sync.js';
import { decodeJwtPayload } from '../auth/jwt.js';
import { upsertUserFromCtx, getUserById, type User } from '../db/users.js';
import type { LoopAuthContext } from '../auth/handler.js';
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

async function toView(row: User): Promise<UserMeView> {
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
 * Resolves the authenticated caller to a Loop user row. Loop-native
 * bearers already carry a resolved `userId` on `c.get('auth')`; CTX
 * bearers fall through to the upsert path so the row is created on
 * first touch (mirrors `requireAdmin`'s resolution semantics).
 */
async function resolveCallingUser(c: Context): Promise<User | null> {
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined) return null;
  if (auth.kind === 'loop') {
    return await getUserById(auth.userId);
  }
  const claims = decodeJwtPayload(auth.bearerToken);
  if (claims === null) return null;
  return await upsertUserFromCtx({
    ctxUserId: claims.sub,
    email: typeof claims['email'] === 'string' ? claims['email'] : undefined,
  });
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
  // user's balance. Support has a separate path to handle that.
  const [orderCountRow] = await db
    .select({ n: sql<string>`COUNT(*)::text` })
    .from(orders)
    .where(eq(orders.userId, user.id));
  const orderCount = BigInt(orderCountRow?.n ?? '0');
  if (orderCount > 0n) {
    return c.json(
      {
        code: 'HOME_CURRENCY_LOCKED',
        message: 'Home currency cannot be changed after placing an order',
      },
      409,
    );
  }

  const [updated] = await db
    .update(users)
    .set({ homeCurrency: parsed.data.currency, updatedAt: sql`NOW()` })
    .where(eq(users.id, user.id))
    .returning();
  if (updated === undefined) {
    // User row disappeared between resolve and update — race with
    // account deletion, or a concurrent support-auth'd edit.
    return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
  }
  return c.json<UserMeView>(await toView(updated));
}

// Stellar ED25519 public keys: 56 uppercase base32 chars starting
// with 'G'. Validated here rather than at the column level (which is
// just `text`) so the backend can null-out bad data via SQL in a
// pinch.
const STELLAR_PUBKEY_REGEX = /^G[A-Z2-7]{55}$/;
const SetStellarAddressBody = z.object({
  /** Null explicitly unlinks the address; any string is validated against the pubkey regex. */
  address: z.union([z.string().regex(STELLAR_PUBKEY_REGEX), z.null()]),
});

/**
 * PUT /api/users/me/stellar-address — user opts into on-chain
 * cashback payouts by linking a Stellar address. Re-linking (changing
 * the address) is allowed because the column is a routing hint, not a
 * ledger-pinned value — subsequent payouts just go to the new target.
 * Passing `address: null` unlinks, returning the user to off-chain-
 * only cashback accrual.
 */
export async function setStellarAddressHandler(c: Context): Promise<Response> {
  const parsed = SetStellarAddressBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message:
          parsed.error.issues[0]?.message ?? 'address must be a Stellar public key (G...) or null',
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
  if (user.stellarAddress === parsed.data.address) {
    return c.json<UserMeView>(await toView(user));
  }
  const [updated] = await db
    .update(users)
    .set({ stellarAddress: parsed.data.address, updatedAt: sql`NOW()` })
    .where(eq(users.id, user.id))
    .returning();
  if (updated === undefined) {
    return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
  }
  return c.json<UserMeView>(await toView(updated));
}

/**
 * `GET /api/users/me/cashback-history` — recent credit-ledger events
 * for the caller (ADR 009 / 015). Pages by `?before=<iso>` +
 * `?limit=N` (default 20, hard-capped at 100). Returns the
 * `credit_transactions` rows as-is so the client can render cashback
 * earnings, interest accrual, and withdrawals on the Account view.
 *
 * Scoped to the caller — no admin-privileged view into other users'
 * ledger from this endpoint (admins use `/api/admin/*` for that).
 */
export interface CashbackHistoryEntry {
  id: string;
  type: string;
  /** bigint as string — pence/cents in `currency`. Positive for cashback/interest/refund, negative for spend/withdrawal. */
  amountMinor: string;
  currency: string;
  /** Ledger-source tag, e.g. `'order'` for per-order cashback. Null when adjusted directly by support. */
  referenceType: string | null;
  /** Matching reference id (e.g. order UUID). Null when referenceType is null. */
  referenceId: string | null;
  createdAt: string;
}

export interface CashbackHistoryResponse {
  entries: CashbackHistoryEntry[];
}

export async function getCashbackHistoryHandler(c: Context): Promise<Response> {
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

  const predicate =
    before === undefined
      ? eq(creditTransactions.userId, user.id)
      : and(eq(creditTransactions.userId, user.id), lt(creditTransactions.createdAt, before));
  const rows = await db
    .select()
    .from(creditTransactions)
    .where(predicate)
    .orderBy(desc(creditTransactions.createdAt))
    .limit(limit);
  return c.json<CashbackHistoryResponse>({
    entries: rows.map((row) => ({
      id: row.id,
      type: row.type,
      amountMinor: row.amountMinor.toString(),
      currency: row.currency,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      createdAt: row.createdAt.toISOString(),
    })),
  });
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
  orderId: string;
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

/**
 * `GET /api/users/me/cashback-by-merchant` — per-merchant cashback
 * leaderboard for the caller. Top N merchants by lifetime
 * user-cashback earned on fulfilled orders, grouped by chargeCurrency
 * (users who have moved home regions see rows per (merchant, currency)
 * pair so the ledger still totals correctly). Drives the
 * "where's your cashback coming from?" panel on the cashback settings
 * page — users care about this more than the ordered ledger when
 * choosing which merchants to spend with next.
 *
 * Single GROUP BY — one round-trip. Merchant names are resolved from
 * the in-memory catalog (never a DB join), falling back to the id
 * when the upstream catalog has evicted a merchant we still have
 * history for.
 */
export interface CashbackByMerchantEntry {
  merchantId: string;
  /** Resolved via the in-memory merchant cache — falls back to merchantId. */
  merchantName: string;
  chargeCurrency: string;
  orderCount: number;
  /** Total user-cashback minor units earned from this (merchant, currency). */
  cashbackMinor: string;
  /** Total amount charged across those orders, minor units. */
  chargeMinor: string;
}

export interface CashbackByMerchantResponse {
  entries: CashbackByMerchantEntry[];
}

interface CashbackByMerchantRow extends Record<string, unknown> {
  merchantId: string;
  chargeCurrency: string;
  orderCount: string | number;
  cashbackMinor: string | null;
  chargeMinor: string | null;
}

export async function getCashbackByMerchantHandler(c: Context): Promise<Response> {
  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? '10', 10);
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 10 : parsedLimit, 1), 50);

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

  try {
    const result = await db.execute<CashbackByMerchantRow>(sql`
      SELECT
        ${orders.merchantId} AS "merchantId",
        ${orders.chargeCurrency} AS "chargeCurrency",
        COUNT(*)::bigint AS "orderCount",
        COALESCE(SUM(${orders.userCashbackMinor}), 0)::bigint AS "cashbackMinor",
        COALESCE(SUM(${orders.chargeMinor}), 0)::bigint AS "chargeMinor"
      FROM ${orders}
      WHERE ${orders.userId} = ${user.id}
        AND ${orders.state} = 'fulfilled'
      GROUP BY ${orders.merchantId}, ${orders.chargeCurrency}
      ORDER BY COALESCE(SUM(${orders.userCashbackMinor}), 0) DESC
      LIMIT ${limit}
    `);
    const rows: CashbackByMerchantRow[] = Array.isArray(result)
      ? (result as CashbackByMerchantRow[])
      : ((result as { rows?: CashbackByMerchantRow[] }).rows ?? []);

    const { merchantsById } = getMerchants();
    const entries: CashbackByMerchantEntry[] = rows.map((row) => ({
      merchantId: row.merchantId,
      merchantName: merchantsById.get(row.merchantId)?.name ?? row.merchantId,
      chargeCurrency: row.chargeCurrency,
      orderCount: Number(row.orderCount),
      cashbackMinor: (row.cashbackMinor ?? '0').toString(),
      chargeMinor: (row.chargeMinor ?? '0').toString(),
    }));
    return c.json<CashbackByMerchantResponse>({ entries });
  } catch (err) {
    log.error({ err }, 'Cashback-by-merchant query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load cashback breakdown' }, 500);
  }
}
