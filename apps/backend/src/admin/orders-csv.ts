/**
 * Admin orders CSV export (ADR 011 / 015).
 *
 * `GET /api/admin/orders.csv` — finance-ready RFC 4180 CSV of
 * Loop-native order rows in a time window. Ops uses this at
 * month-end to reconcile:
 *   - face-value totals against the CTX invoice (wholesale_minor)
 *   - user-cashback totals against the credit-ledger accrual feed
 *   - loop-margin totals against the P&L line
 *
 * Window: `?since=<iso>` lower bound on `createdAt` (default 31
 * days ago), capped at 366. Row cap 10 000 — past that, the
 * response appends a `__TRUNCATED__` sentinel row and the handler
 * log-warns the real rowCount so ops knows to narrow the window.
 *
 * Gift-card fields (`redeem_code`, `redeem_pin`, `redeem_url`)
 * are deliberately omitted — this export is for reconciliation,
 * not redemption, and keeping card secrets out of bulk downloads
 * shrinks the blast radius of an admin-token leak.
 *
 * Headers:
 *   Content-Type: text/csv; charset=utf-8
 *   Cache-Control: private, no-store
 *   Content-Disposition: attachment; filename="orders-<since>.csv"
 */
import type { Context } from 'hono';
import { asc, gte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';
import { csvEscape } from './csv-escape.js';

const log = logger.child({ handler: 'admin-orders-csv' });

const DEFAULT_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const ROW_CAP = 10_000;

const HEADERS = [
  'id',
  'user_id',
  'merchant_id',
  'state',
  'currency',
  'face_value_minor',
  'charge_currency',
  'charge_minor',
  'payment_method',
  'wholesale_pct',
  'user_cashback_pct',
  'loop_margin_pct',
  'wholesale_minor',
  'user_cashback_minor',
  'loop_margin_minor',
  'ctx_order_id',
  'ctx_operator_id',
  'failure_reason',
  'created_at',
  'paid_at',
  'procured_at',
  'fulfilled_at',
  'failed_at',
] as const;

function csvRow(values: Array<string | null | undefined>): string {
  return values.map((v) => csvEscape(v ?? null)).join(',');
}

interface Row {
  id: string;
  userId: string;
  merchantId: string;
  state: string;
  currency: string;
  faceValueMinor: bigint;
  chargeCurrency: string;
  chargeMinor: bigint;
  paymentMethod: string;
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  wholesaleMinor: bigint;
  userCashbackMinor: bigint;
  loopMarginMinor: bigint;
  ctxOrderId: string | null;
  ctxOperatorId: string | null;
  failureReason: string | null;
  createdAt: Date;
  paidAt: Date | null;
  procuredAt: Date | null;
  fulfilledAt: Date | null;
  failedAt: Date | null;
}

export async function adminOrdersCsvHandler(c: Context): Promise<Response> {
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

  try {
    const rows = (await db
      .select()
      .from(orders)
      // A2-1610: typed `gte()` instead of raw sql template — see
      // matching fix in `audit-tail-csv.ts`. postgres-js can't bind a
      // Date object directly through the sql template; the typed
      // operator routes through the column's timestamp mapper.
      .where(gte(orders.createdAt, since))
      .orderBy(asc(orders.createdAt))
      .limit(ROW_CAP + 1)) as Row[];

    const lines: string[] = [HEADERS.join(',')];
    const truncated = rows.length > ROW_CAP;
    const emitted = truncated ? rows.slice(0, ROW_CAP) : rows;

    for (const r of emitted) {
      lines.push(
        csvRow([
          r.id,
          r.userId,
          r.merchantId,
          r.state,
          r.currency,
          r.faceValueMinor.toString(),
          r.chargeCurrency,
          r.chargeMinor.toString(),
          r.paymentMethod,
          r.wholesalePct,
          r.userCashbackPct,
          r.loopMarginPct,
          r.wholesaleMinor.toString(),
          r.userCashbackMinor.toString(),
          r.loopMarginMinor.toString(),
          r.ctxOrderId,
          r.ctxOperatorId,
          r.failureReason,
          r.createdAt.toISOString(),
          r.paidAt?.toISOString() ?? null,
          r.procuredAt?.toISOString() ?? null,
          r.fulfilledAt?.toISOString() ?? null,
          r.failedAt?.toISOString() ?? null,
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { rowCount: rows.length, since: since.toISOString() },
        'Admin orders CSV truncated — narrow the window',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const filename = `orders-${since.toISOString().slice(0, 10)}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin orders CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
