/**
 * Admin per-merchant cashback-summary (ADR 009 / 011 / 015).
 *
 * `GET /api/admin/merchants/:merchantId/cashback-summary` — lifetime
 * user-cashback minted on orders at this merchant, grouped by the
 * charge currency the order was paid in. Answers the ops question:
 * "how much have we credited to users for spending at Amazon?"
 *
 * Per-currency rather than rolled into one total — per-merchant
 * volume can span multiple user home_currencies (GBP user buying a
 * USD card), so the aggregate only makes sense denominated. Sibling
 * of `/api/admin/users/:userId/cashback-summary` but scoped the
 * other way round.
 *
 * Source of truth: `orders.user_cashback_minor` rather than
 * `credit_transactions`. Cashback is pinned at order creation, minted
 * on fulfillment — for the "what have we committed to users on
 * Merchant X" question, summing the pinned per-order values gives
 * the aggregate that never drifts from the cashback-config audit
 * trail even if the `credit_transactions` row for an order hasn't
 * posted yet.
 *
 * Filter `state = 'fulfilled'` — unfulfilled orders are revocable
 * (pending_payment expires, procuring can fail) so including them
 * over-counts committed cashback.
 *
 * Zero-volume merchants return an empty `currencies` list, not 404
 * (a catalog merchant with no fulfilled orders is a valid row).
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-merchant-cashback-summary' });

const MERCHANT_ID_RE = /^[A-Za-z0-9._-]+$/;
const MERCHANT_ID_MAX = 128;

export interface AdminMerchantCashbackCurrencyBucket {
  currency: string;
  fulfilledCount: number;
  /** SUM(user_cashback_minor) over fulfilled orders in this currency. bigint-as-string. */
  lifetimeCashbackMinor: string;
  /** SUM(charge_minor) in this currency — context for "cashback as % of spend". */
  lifetimeChargeMinor: string;
}

export interface AdminMerchantCashbackSummary {
  merchantId: string;
  /** Fulfilled-order total across every currency. */
  totalFulfilledCount: number;
  /** One entry per charge currency the merchant has seen. Sorted desc by fulfilledCount. */
  currencies: AdminMerchantCashbackCurrencyBucket[];
}

interface DbRow extends Record<string, unknown> {
  currency: string;
  fulfilledCount: number;
  lifetimeCashbackMinor: string | number | bigint | null;
  lifetimeChargeMinor: string | number | bigint | null;
}

export async function adminMerchantCashbackSummaryHandler(c: Context): Promise<Response> {
  const merchantId = c.req.param('merchantId');
  if (merchantId === undefined || merchantId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is required' }, 400);
  }
  if (merchantId.length > MERCHANT_ID_MAX || !MERCHANT_ID_RE.test(merchantId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is malformed' }, 400);
  }

  try {
    const result = await db.execute<DbRow>(sql`
      SELECT
        ${orders.chargeCurrency} AS "currency",
        COUNT(*)::int AS "fulfilledCount",
        COALESCE(SUM(${orders.userCashbackMinor}), 0)::bigint AS "lifetimeCashbackMinor",
        COALESCE(SUM(${orders.chargeMinor}), 0)::bigint AS "lifetimeChargeMinor"
      FROM ${orders}
      WHERE ${orders.merchantId} = ${merchantId}
        AND ${orders.state} = 'fulfilled'
      GROUP BY ${orders.chargeCurrency}
      ORDER BY "fulfilledCount" DESC, "currency" ASC
    `);
    const rows: DbRow[] = Array.isArray(result)
      ? (result as DbRow[])
      : ((result as { rows?: DbRow[] }).rows ?? []);

    const currencies: AdminMerchantCashbackCurrencyBucket[] = rows.map((r) => ({
      currency: r.currency,
      fulfilledCount: r.fulfilledCount,
      lifetimeCashbackMinor: (r.lifetimeCashbackMinor ?? '0').toString(),
      lifetimeChargeMinor: (r.lifetimeChargeMinor ?? '0').toString(),
    }));
    const totalFulfilledCount = currencies.reduce((sum, c) => sum + c.fulfilledCount, 0);

    return c.json<AdminMerchantCashbackSummary>({
      merchantId,
      totalFulfilledCount,
      currencies,
    });
  } catch (err) {
    log.error({ err, merchantId }, 'Admin merchant cashback-summary query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to load merchant cashback summary' },
      500,
    );
  }
}
