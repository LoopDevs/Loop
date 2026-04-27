/**
 * Caller-scoped cashback-history + credits handlers (ADR 009 / 015).
 *
 * Lifted out of `apps/backend/src/users/handler.ts`. Three handlers
 * that back the credit-ledger read paths — same routes the openapi
 * spec splits into `./openapi/users-history-credits.ts`:
 *
 *   - GET /api/users/me/cashback-history       → getCashbackHistoryHandler
 *   - GET /api/users/me/cashback-history.csv   → getCashbackHistoryCsvHandler
 *   - GET /api/users/me/credits                → getUserCreditsHandler
 *
 * Four locally-scoped types travel with the slice:
 *   - `CashbackHistoryEntry` / `CashbackHistoryResponse`
 *   - `UserCreditRow` / `UserCreditsResponse`
 */
import type { Context } from 'hono';
import { and, desc, eq, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, userCredits } from '../db/schema.js';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { type User } from '../db/users.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'users' });

async function resolveCallingUser(c: Context): Promise<User | null> {
  return await resolveLoopAuthenticatedUser(c);
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
