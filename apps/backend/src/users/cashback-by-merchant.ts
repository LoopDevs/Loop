/**
 * User cashback-by-merchant breakdown (ADR 009 / 015).
 *
 * `GET /api/users/me/cashback-by-merchant` — groups the caller's
 * cashback ledger rows by the merchant their source order was placed
 * with, so the user can answer "which merchants do I actually earn
 * cashback from?" on /settings/cashback. Joins `credit_transactions`
 * (type='cashback', filtered to the caller) to `orders` via the
 * credit-transaction's `reference_id` — cashback rows stamp the
 * originating order id at write time so this join is the authoritative
 * path from ledger entry to merchant.
 *
 * Rows that can't resolve a merchant (an adjustment credit-transaction
 * with no referenceId, for instance) are skipped silently — the
 * admin ledger view owns the full picture, this one is focused on
 * the "earned from merchant X" story.
 *
 * Shape:
 *   { currency: "GBP",
 *     since: "2025-10-22T00:00:00Z",
 *     rows: [{ merchantId, cashbackMinor, orderCount, lastEarnedAt }] }
 *
 * Default window 180 days (covers a user who returns quarterly);
 * clamped 1..366. Default limit 10 (top-by-cashback); clamped 1..50.
 * Ordered by cashbackMinor DESC so the "biggest earner" surfaces
 * first — ties break on lastEarnedAt DESC so a newly-active merchant
 * leads a dormant tie.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, orders } from '../db/schema.js';
import type { User } from '../db/users.js';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'user-cashback-by-merchant' });

const DEFAULT_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export interface CashbackByMerchantRow {
  merchantId: string;
  /** Earned cashback in `currency`, minor units as bigint-string. */
  cashbackMinor: string;
  /** Number of distinct orders that contributed to this total. */
  orderCount: number;
  /** Newest ledger-row createdAt attributed to this merchant. */
  lastEarnedAt: string;
}

export interface CashbackByMerchantResponse {
  currency: string;
  since: string;
  rows: CashbackByMerchantRow[];
}

interface AggRow {
  merchant_id: string;
  cashback_minor: string | number | bigint;
  order_count: string | number | bigint;
  last_earned_at: string | Date;
}

/**
 * A2-550 / A2-551 fix: identity resolution now requires a verified
 * Loop-signed token. See `apps/backend/src/auth/authenticated-user.ts`.
 */
async function resolveCallingUser(c: Context): Promise<User | null> {
  return await resolveLoopAuthenticatedUser(c);
}

export async function getCashbackByMerchantHandler(c: Context): Promise<Response> {
  const sinceRaw = c.req.query('since');
  let since: Date;
  if (sinceRaw !== undefined && sinceRaw.length > 0) {
    const d = new Date(sinceRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'since must be an ISO-8601 timestamp' },
        400,
      );
    }
    since = d;
  } else {
    since = new Date(Date.now() - DEFAULT_WINDOW_MS);
  }
  if (Date.now() - since.getTime() > MAX_WINDOW_MS) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'since cannot be more than 366 days ago' },
      400,
    );
  }

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? `${DEFAULT_LIMIT}`, 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit, 1),
    MAX_LIMIT,
  );

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
    // Cashback rows stamp the source order id into `reference_id`, so
    // the join key is `credit_transactions.reference_id::uuid =
    // orders.id`. Scoping on `reference_type='order'` keeps any future
    // non-order-referenced cashback out of this view by design.
    const result = await db.execute(sql`
      SELECT
        ${orders.merchantId} AS merchant_id,
        SUM(${creditTransactions.amountMinor})::bigint AS cashback_minor,
        COUNT(DISTINCT ${orders.id})::bigint AS order_count,
        MAX(${creditTransactions.createdAt}) AS last_earned_at
      FROM ${creditTransactions}
      INNER JOIN ${orders}
        ON ${orders.id} = ${creditTransactions.referenceId}::uuid
      WHERE ${creditTransactions.userId} = ${user.id}
        AND ${creditTransactions.type} = 'cashback'
        AND ${creditTransactions.referenceType} = 'order'
        AND ${creditTransactions.currency} = ${user.homeCurrency}
        AND ${creditTransactions.createdAt} >= ${since}
      GROUP BY ${orders.merchantId}
      ORDER BY cashback_minor DESC, last_earned_at DESC
      LIMIT ${limit}
    `);

    const raw = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const rows: CashbackByMerchantRow[] = raw.map((r) => ({
      merchantId: r.merchant_id,
      cashbackMinor:
        typeof r.cashback_minor === 'bigint'
          ? r.cashback_minor.toString()
          : String(r.cashback_minor ?? '0'),
      orderCount: Number(r.order_count),
      lastEarnedAt:
        r.last_earned_at instanceof Date
          ? r.last_earned_at.toISOString()
          : new Date(r.last_earned_at).toISOString(),
    }));

    const body: CashbackByMerchantResponse = {
      currency: user.homeCurrency,
      since: since.toISOString(),
      rows,
    };
    return c.json(body);
  } catch (err) {
    log.error({ err }, 'cashback-by-merchant query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to load cashback-by-merchant breakdown' },
      500,
    );
  }
}
