/**
 * Admin orders CSV export (ADR 011 / 017).
 *
 * `GET /api/admin/orders.csv` — one-shot dump of the orders table
 * as a downloadable attachment. Complement to the user-facing
 * `/api/users/me/cashback-history.csv` (#412) but:
 *   - admin-scoped (gated by the `/api/admin/*` middleware);
 *   - exposes the full per-order split (wholesale / user cashback
 *     / loop margin) plus the CTX procurement record and timestamps.
 *
 * Filters:
 *   - `?state=` optional, restricts to a single lifecycle state.
 *     Validated against the ORDER_STATES enum.
 *   - no before/limit filters: the CSV is intentionally a bulk dump,
 *     capped at `CSV_EXPORT_ROW_LIMIT` rows total. Ops that needs
 *     more granular slicing pages the JSON endpoint instead.
 *
 * Headers:
 *   - `Content-Type: text/csv; charset=utf-8`
 *   - `Content-Disposition: attachment; filename="loop-admin-orders[-<state>].csv"`
 *   - `Cache-Control: private, no-store` — the dump contains
 *     customer + wholesale data; no CDN caching under any circumstance.
 *   - `X-Result-Count` — informational count of rows emitted.
 */
import type { Context } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-orders-csv' });

const ORDER_STATES = [
  'pending_payment',
  'paid',
  'procuring',
  'fulfilled',
  'failed',
  'expired',
] as const;
type OrderState = (typeof ORDER_STATES)[number];

/** Matches #412's cap — a user with 10k+ orders is either pathological or a test fixture. */
const CSV_EXPORT_ROW_LIMIT = 10_000;

const CSV_HEADER = [
  'Created (UTC)',
  'State',
  'User ID',
  'Merchant ID',
  'Currency',
  'Face value (minor)',
  'Charge currency',
  'Charge (minor)',
  'Payment method',
  'Wholesale (minor)',
  'User cashback (minor)',
  'Loop margin (minor)',
  'CTX order ID',
  'CTX operator',
  'Failure reason',
  'Paid at',
  'Procured at',
  'Fulfilled at',
  'Failed at',
].join(',');

/** GET /api/admin/orders.csv */
export async function adminOrdersCsvHandler(c: Context): Promise<Response> {
  const stateRaw = c.req.query('state');
  let stateFilter: OrderState | undefined;
  if (stateRaw !== undefined) {
    if (!(ORDER_STATES as ReadonlyArray<string>).includes(stateRaw)) {
      return c.json(
        {
          code: 'VALIDATION_ERROR',
          message: `state must be one of: ${ORDER_STATES.join(', ')}`,
        },
        400,
      );
    }
    stateFilter = stateRaw as OrderState;
  }

  const baseQuery = db.select().from(orders);
  const filtered =
    stateFilter !== undefined ? baseQuery.where(eq(orders.state, stateFilter)) : baseQuery;
  const rows = await filtered.orderBy(desc(orders.createdAt)).limit(CSV_EXPORT_ROW_LIMIT);

  if (rows.length >= CSV_EXPORT_ROW_LIMIT) {
    log.warn(
      { state: stateFilter, limit: CSV_EXPORT_ROW_LIMIT },
      'Admin orders CSV hit the row cap — more rows exist beyond the dump',
    );
  }

  const body = rows
    .map((r) => {
      const cols = [
        r.createdAt.toISOString(),
        r.state,
        r.userId,
        r.merchantId,
        r.currency,
        r.faceValueMinor.toString(),
        r.chargeCurrency,
        r.chargeMinor.toString(),
        r.paymentMethod,
        r.wholesaleMinor.toString(),
        r.userCashbackMinor.toString(),
        r.loopMarginMinor.toString(),
        r.ctxOrderId ?? '',
        r.ctxOperatorId ?? '',
        r.failureReason ?? '',
        r.paidAt?.toISOString() ?? '',
        r.procuredAt?.toISOString() ?? '',
        r.fulfilledAt?.toISOString() ?? '',
        r.failedAt?.toISOString() ?? '',
      ];
      return cols.map(csvField).join(',');
    })
    .join('\r\n');

  const filename =
    stateFilter !== undefined ? `loop-admin-orders-${stateFilter}.csv` : 'loop-admin-orders.csv';
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Result-Count', String(rows.length));
  return c.body(`${CSV_HEADER}\r\n${body}`);
}

/**
 * RFC 4180 CSV field encoder. Shared with #412's user-facing CSV —
 * duplicated here rather than split into a shared module to keep each
 * export handler self-contained + auditable. If a third exporter
 * lands, extract into `lib/csv.ts`.
 */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
