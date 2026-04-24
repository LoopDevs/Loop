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
import { UUID_RE } from '../uuid.js';
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
import {
  getPayoutByOrderIdForUser,
  getPayoutForUser,
  listPayoutsForUser,
  pendingPayoutsSummaryForUser,
} from '../credits/pending-payouts.js';
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
 * A2-550 / A2-551 fix: identity is now resolved only from the
 * cryptographically-verified Loop-signed token. See
 * `apps/backend/src/auth/authenticated-user.ts` for the rationale.
 */
async function resolveCallingUser(c: Context): Promise<User | null> {
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
 * `GET /api/users/me/cashback-history.csv` — full credit-ledger
 * stream for the caller as a downloadable CSV. Unlike the paginated
 * JSON sibling, this is a one-shot dump intended for user-initiated
 * exports (tax records, personal bookkeeping, support chat
 * attachments). Caps at `CSV_EXPORT_ROW_LIMIT` rows so a
 * pathologically-active user can't wedge the handler.
 */
const CSV_EXPORT_ROW_LIMIT = 10_000;

export async function getCashbackHistoryCsvHandler(c: Context): Promise<Response> {
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
    .select()
    .from(creditTransactions)
    .where(eq(creditTransactions.userId, user.id))
    .orderBy(desc(creditTransactions.createdAt))
    .limit(CSV_EXPORT_ROW_LIMIT);

  if (rows.length >= CSV_EXPORT_ROW_LIMIT) {
    log.warn(
      { userId: user.id, limit: CSV_EXPORT_ROW_LIMIT },
      'Cashback CSV export hit the row cap — user has more history than the dump captures',
    );
  }

  const header = 'Created (UTC),Type,Amount (minor),Currency,Reference type,Reference ID\r\n';
  const body = rows
    .map((r) => {
      const cols = [
        r.createdAt.toISOString(),
        r.type,
        r.amountMinor.toString(),
        r.currency,
        r.referenceType ?? '',
        r.referenceId ?? '',
      ];
      return cols.map(csvField).join(',');
    })
    .join('\r\n');

  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', 'attachment; filename="loop-cashback-history.csv"');
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Result-Count', String(rows.length));
  return c.body(header + body);
}

/**
 * RFC 4180 CSV field encoder. Wraps in double quotes + doubles internal
 * quotes when the value contains any of: comma, double quote, CR, LF.
 */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
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
