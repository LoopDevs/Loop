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
import { STELLAR_PUBKEY_REGEX } from '@loop/shared';
import { db } from '../db/client.js';
import {
  creditTransactions,
  orders,
  userCredits,
  users,
  HOME_CURRENCIES,
  PAYOUT_STATES,
} from '../db/schema.js';
import { getPayoutForUser, listPayoutsForUser } from '../credits/pending-payouts.js';
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
// with 'G'. Shared regex — see `@loop/shared/stellar` for the
// single source of truth across backend + web + env validation.
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
 * `GET /api/users/me/credits` — caller's off-chain cashback balance
 * per currency (ADR 009 / 015).
 *
 * `GET /api/users/me` already surfaces a single scalar in the user's
 * current `home_currency`. This endpoint is the multi-currency
 * complement — useful when a user has flipped home currency (a
 * support-mediated flip leaves a non-zero balance in the old
 * currency) or was credited in a non-home currency via ops adjustment.
 *
 * Scoped to the authenticated caller — no admin-privileged
 * cross-user access from this endpoint.
 */
export interface UserCreditRow {
  currency: string;
  /** bigint-as-string in minor units (pence / cents). */
  balanceMinor: string;
  /** ISO-8601 timestamp of the last ledger movement that wrote to this row. */
  updatedAt: string;
}

export interface UserCreditsResponse {
  credits: UserCreditRow[];
}

export async function getUserCreditsHandler(c: Context): Promise<Response> {
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

  const rows = await db
    .select({
      currency: userCredits.currency,
      balanceMinor: userCredits.balanceMinor,
      updatedAt: userCredits.updatedAt,
    })
    .from(userCredits)
    .where(eq(userCredits.userId, user.id))
    .orderBy(userCredits.currency);

  return c.json<UserCreditsResponse>({
    credits: rows.map((r) => ({
      currency: r.currency,
      balanceMinor: r.balanceMinor.toString(),
      updatedAt: r.updatedAt.toISOString(),
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

const PENDING_PAYOUT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `GET /api/users/me/pending-payouts/:id` — caller-scoped single
 * payout drill-down (ADR 015 / 016). Permalink for a stuck
 * payout row: the /settings/cashback detail view deep-links each
 * list row to this endpoint so the user can bookmark / share a
 * link with support when asking why a cashback payout is stuck.
 *
 * Cross-user access returns 404 (not 403) — enumerating other
 * users' payout ids should be indistinguishable from a genuine miss.
 */
export async function getUserPendingPayoutDetailHandler(c: Context): Promise<Response> {
  const id = c.req.param('id');
  if (id === undefined || id.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id is required' }, 400);
  }
  if (!PENDING_PAYOUT_UUID_RE.test(id)) {
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
 * `GET /api/users/me/cashback-summary` — compact two-number summary
 * the home / cashback pages use for a "£42 lifetime · £3.20 this
 * month" headline. Avoids paging the whole `credit_transactions`
 * ledger when the UI only wants totals.
 *
 * Both totals are filtered to `type='cashback'` so they reflect what
 * the user actually *earned* — spend / adjustment / withdrawal don't
 * belong in an earnings summary. Currency comes from the user's
 * current `home_currency`; we don't cross-currency-sum. A user who
 * has moved regions (rare, support-mediated) sees only home-currency
 * earnings here; the admin ledger view has the cross-currency detail.
 *
 * Single query with two conditional SUMs — one round-trip.
 */
export interface UserCashbackSummary {
  currency: string;
  /** All-time cashback earned in `currency`, bigint-safe string. */
  lifetimeMinor: string;
  /**
   * Cashback earned since the start of the current UTC calendar
   * month. Resets at 00:00 UTC on the 1st.
   */
  thisMonthMinor: string;
}

interface CashbackSummaryRow extends Record<string, unknown> {
  lifetimeMinor: string | null;
  thisMonthMinor: string | null;
}

export async function getCashbackSummaryHandler(c: Context): Promise<Response> {
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
    const result = await db.execute<CashbackSummaryRow>(sql`
      SELECT
        COALESCE(SUM(${creditTransactions.amountMinor}), 0)::bigint AS "lifetimeMinor",
        COALESCE(
          SUM(${creditTransactions.amountMinor}) FILTER (
            WHERE ${creditTransactions.createdAt}
              >= DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC')
          ),
          0
        )::bigint AS "thisMonthMinor"
      FROM ${creditTransactions}
      WHERE ${creditTransactions.userId} = ${user.id}
        AND ${creditTransactions.type} = 'cashback'
        AND ${creditTransactions.currency} = ${user.homeCurrency}
    `);
    const rows: CashbackSummaryRow[] = Array.isArray(result)
      ? (result as CashbackSummaryRow[])
      : ((result as { rows?: CashbackSummaryRow[] }).rows ?? []);
    const row = rows[0];

    return c.json<UserCashbackSummary>({
      currency: user.homeCurrency,
      lifetimeMinor: (row?.lifetimeMinor ?? '0').toString(),
      thisMonthMinor: (row?.thisMonthMinor ?? '0').toString(),
    });
  } catch (err) {
    log.error({ err }, 'Cashback-summary query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load cashback summary' }, 500);
  }
}
