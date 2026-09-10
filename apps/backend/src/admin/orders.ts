// Admin orders surface — list, drill, activity, CSV export
import type { Context } from 'hono';
import { ORDER_STATES, isOrderState, type OrderState } from '@loop/shared';
import { db } from '../db/client.js';
import type { Filter } from '../db/store.js';
import type { OrderDoc } from '../db/types.js';
import { UUID_RE } from '../uuid.js';
import { logger } from '../logger.js';
import { csvRow } from './csv-escape.js';

const log = logger.child({ handler: 'admin-orders' });

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const CSV_MAX_ROWS = 5000;

export interface AdminOrderView {
  id: string;
  userId: string;
  merchantId: string;
  state: OrderState;
  currency: string;
  faceValueMinor: number;
  chargeCurrency: string;
  chargeMinor: number;
  userCashbackMinor: number;
  /** Null until the operator economics read-back succeeds (ADR 052). */
  expectedCommissionMinor: number | null;
  ctxOrderId: string | null;
  ctxPaymentId: string | null;
  paymentCryptoCurrency: string | null;
  /**
   * Whether redemption details have landed — never the values. This
   * is the field triage actually needs: "fulfilled but nothing to
   * redeem" is the failure a customer reports.
   */
  hasRedemption: boolean;
  redemptionBackfillAttempts: number;
  failureReason: string | null;
  createdAt: string;
  fulfilledAt: string | null;
  failedAt: string | null;
}

export interface AdminOrdersListResponse {
  orders: AdminOrderView[];
}

export function rowToView(row: OrderDoc): AdminOrderView {
  return {
    id: row.id,
    userId: row.userId,
    merchantId: row.merchantId,
    state: row.state,
    currency: row.currency,
    faceValueMinor: row.faceValueMinor,
    chargeCurrency: row.chargeCurrency,
    chargeMinor: row.chargeMinor,
    userCashbackMinor: row.userCashbackMinor,
    expectedCommissionMinor: row.expectedCommissionMinor,
    ctxOrderId: row.ctxOrderId,
    ctxPaymentId: row.ctxPaymentId,
    paymentCryptoCurrency: row.paymentCryptoCurrency,
    hasRedemption: row.redeemCode !== null || row.redeemPin !== null || row.redeemUrl !== null,
    redemptionBackfillAttempts: row.redemptionBackfillAttempts,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
  };
}

function parseListQuery(
  c: Context,
  maxLimit: number,
): Response | { filter: Filter<OrderDoc>; limit: number } {
  const filter: Filter<OrderDoc> = {};

  const state = c.req.query('state');
  if (state !== undefined && state.length > 0) {
    if (!isOrderState(state)) {
      return c.json(
        {
          code: 'VALIDATION_ERROR',
          message: `state must be one of ${ORDER_STATES.join(', ')}`,
        },
        400,
      );
    }
    filter.state = state;
  }

  const userId = c.req.query('userId');
  if (userId !== undefined && userId.length > 0) {
    if (!UUID_RE.test(userId)) {
      return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
    }
    filter.userId = userId;
  }

  const merchantId = c.req.query('merchantId');
  if (merchantId !== undefined && merchantId.length > 0) {
    filter.merchantId = merchantId;
  }

  const beforeRaw = c.req.query('before');
  if (beforeRaw !== undefined && beforeRaw.length > 0) {
    const d = new Date(beforeRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'before must be an ISO-8601 timestamp' },
        400,
      );
    }
    filter.createdAt = { $lt: d };
  }

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? String(DEFAULT_LIMIT), 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit, 1),
    maxLimit,
  );

  return { filter, limit };
}

export async function adminListOrdersHandler(c: Context): Promise<Response> {
  const parsed = parseListQuery(c, MAX_LIMIT);
  if (parsed instanceof Response) return parsed;

  try {
    const rows = await db
      .collection('orders')
      .findMany(parsed.filter, { sort: [['createdAt', 'desc']], limit: parsed.limit });
    return c.json<AdminOrdersListResponse>({ orders: rows.map(rowToView) });
  } catch (err) {
    log.error({ err }, 'Admin orders list failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to list orders' }, 500);
  }
}

export async function adminGetOrderHandler(c: Context): Promise<Response> {
  const orderId = c.req.param('orderId');
  if (orderId === undefined || !UUID_RE.test(orderId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'orderId must be a uuid' }, 400);
  }
  try {
    const row = await db.collection('orders').findOne({ id: orderId });
    if (row === null) {
      return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
    }
    return c.json<AdminOrderView>(rowToView(row));
  } catch (err) {
    log.error({ err, orderId }, 'Admin order drill failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch order' }, 500);
  }
}

export interface AdminOrdersActivityResponse {
  windowHours: number;
  counts: Record<OrderState, number>;
  total: number;
}

const DEFAULT_ACTIVITY_WINDOW_HOURS = 24;
const MAX_ACTIVITY_WINDOW_HOURS = 24 * 90;

export async function adminOrdersActivityHandler(c: Context): Promise<Response> {
  const raw = c.req.query('windowHours');
  const parsed = Number.parseInt(raw ?? String(DEFAULT_ACTIVITY_WINDOW_HOURS), 10);
  const windowHours = Math.min(
    Math.max(Number.isNaN(parsed) ? DEFAULT_ACTIVITY_WINDOW_HOURS : parsed, 1),
    MAX_ACTIVITY_WINDOW_HOURS,
  );

  try {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    // One count per state rather than one scan plus a group-by: the
    // store has no aggregation, and six counted queries are cheaper
    // than pulling every row of a busy window into memory to tally.
    const counted = await Promise.all(
      ORDER_STATES.map(async (state) => ({
        state,
        n: await db.collection('orders').count({ state, createdAt: { $gte: since } }),
      })),
    );
    const counts = Object.fromEntries(counted.map((r) => [r.state, r.n])) as Record<
      OrderState,
      number
    >;
    return c.json<AdminOrdersActivityResponse>({
      windowHours,
      counts,
      total: counted.reduce((sum, r) => sum + r.n, 0),
    });
  } catch (err) {
    log.error({ err }, 'Admin orders activity failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load order activity' }, 500);
  }
}

const CSV_HEADER = [
  'order_id',
  'user_id',
  'merchant_id',
  'state',
  'currency',
  'face_value_minor',
  'charge_currency',
  'charge_minor',
  'user_cashback_minor',
  'expected_commission_minor',
  'ctx_order_id',
  'payment_crypto_currency',
  'has_redemption',
  'failure_reason',
  'created_at',
  'fulfilled_at',
  'failed_at',
];

export async function adminOrdersCsvHandler(c: Context): Promise<Response> {
  const parsed = parseListQuery(c, CSV_MAX_ROWS);
  if (parsed instanceof Response) return parsed;

  try {
    const rows = await db
      .collection('orders')
      .findMany(parsed.filter, { sort: [['createdAt', 'desc']], limit: CSV_MAX_ROWS + 1 });
    const truncated = rows.length > CSV_MAX_ROWS;
    const trimmed = truncated ? rows.slice(0, CSV_MAX_ROWS) : rows;

    const lines = [csvRow(CSV_HEADER)];
    for (const row of trimmed) {
      const v = rowToView(row);
      lines.push(
        csvRow([
          v.id,
          v.userId,
          v.merchantId,
          v.state,
          v.currency,
          String(v.faceValueMinor),
          v.chargeCurrency,
          String(v.chargeMinor),
          String(v.userCashbackMinor),
          v.expectedCommissionMinor === null ? '' : String(v.expectedCommissionMinor),
          v.ctxOrderId,
          v.paymentCryptoCurrency,
          v.hasRedemption ? 'true' : 'false',
          v.failureReason,
          v.createdAt,
          v.fulfilledAt,
          v.failedAt,
        ]),
      );
    }
    if (truncated) {
      lines.push(csvRow([`TRUNCATED at ${CSV_MAX_ROWS} rows — narrow the filter and re-export`]));
    }

    return new Response(`${lines.join('\n')}\n`, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="orders.csv"',
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin orders CSV export failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to export orders' }, 500);
  }
}
