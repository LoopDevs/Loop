/**
 * Admin per-user cashback-by-merchant breakdown (ADR 009 / 015 / 017).
 *
 * `GET /api/admin/users/:userId/cashback-by-merchant` — answer
 * support's most common triage question: "user asks why they haven't
 * earned cashback on merchant X — what's the actual ledger say?".
 * Mirrors the user-scoped `/api/users/me/cashback-by-merchant` but
 * takes the target user id as a path parameter and is admin-gated
 * by `requireAdmin` at the route level.
 *
 * Same join path — `credit_transactions.reference_id::uuid =
 * orders.id`, scoped on type='cashback' + reference_type='order' —
 * and same ordering (cashback DESC, ties break on lastEarnedAt).
 *
 * Default window 180 days (covers a support ticket that references
 * an order from months ago); clamped 1..366. Default limit 25
 * (higher than user-facing 10 — ops wants the full picture);
 * clamped 1..100. Currency always resolves from the target user's
 * home_currency, not the admin's.
 */
import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, orders, users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-cashback-by-merchant' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export interface AdminUserCashbackByMerchantRow {
  merchantId: string;
  cashbackMinor: string;
  orderCount: number;
  lastEarnedAt: string;
}

export interface AdminUserCashbackByMerchantResponse {
  userId: string;
  currency: string;
  since: string;
  rows: AdminUserCashbackByMerchantRow[];
}

interface AggRow {
  merchant_id: string;
  cashback_minor: string | number | bigint;
  order_count: string | number | bigint;
  last_earned_at: string | Date;
}

export async function adminUserCashbackByMerchantHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || userId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId is required' }, 400);
  }
  if (!UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }

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

  try {
    // Resolve the target user's home_currency for the currency scope
    // + for echoing in the response. 404 rather than returning an
    // empty aggregate so an enumeration probe doesn't look identical
    // to a user with no cashback yet.
    const [userRow] = await db
      .select({ homeCurrency: users.homeCurrency })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (userRow === undefined) {
      return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
    }

    const result = await db.execute(sql`
      SELECT
        ${orders.merchantId} AS merchant_id,
        SUM(${creditTransactions.amountMinor})::bigint AS cashback_minor,
        COUNT(DISTINCT ${orders.id})::bigint AS order_count,
        MAX(${creditTransactions.createdAt}) AS last_earned_at
      FROM ${creditTransactions}
      INNER JOIN ${orders}
        ON ${orders.id} = ${creditTransactions.referenceId}::uuid
      WHERE ${creditTransactions.userId} = ${userId}
        AND ${creditTransactions.type} = 'cashback'
        AND ${creditTransactions.referenceType} = 'order'
        AND ${creditTransactions.currency} = ${userRow.homeCurrency}
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

    const rows: AdminUserCashbackByMerchantRow[] = raw.map((r) => ({
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

    const body: AdminUserCashbackByMerchantResponse = {
      userId,
      currency: userRow.homeCurrency,
      since: since.toISOString(),
      rows,
    };
    return c.json(body);
  } catch (err) {
    log.error({ err, userId }, 'Admin user cashback-by-merchant query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to load cashback-by-merchant breakdown' },
      500,
    );
  }
}
