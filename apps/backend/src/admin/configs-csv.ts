/**
 * Admin cashback-configs CSV export (ADR 011 / 019 Tier 3).
 *
 * `GET /api/admin/merchant-cashback-configs.csv` — one row per
 * configured merchant. Ops workflow is: click "Export" on the
 * configs page, edit in a spreadsheet, re-apply via the PUT
 * endpoint per merchant (bulk import is a separate slice).
 *
 * Column order is stable and matches the order of fields declared
 * on `AdminCashbackConfig` in the OpenAPI schema — adding a column
 * is backwards-compatible; renaming or reordering is a breaking
 * change that any consumer spreadsheet template relies on.
 */
import type { Context } from 'hono';
import { db } from '../db/client.js';
import { merchantCashbackConfigs } from '../db/schema.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-configs-csv' });

const HEADER = [
  'Merchant ID',
  'Merchant name',
  'Wholesale %',
  'User cashback %',
  'Loop margin %',
  'Active',
  'Updated by',
  'Updated at (UTC)',
] as const;

/**
 * Hard cap per ADR 019 Tier 3. Current config table is <1k rows so
 * this is generous; the cap exists to prevent accidental multi-MB
 * responses if the merchant catalog ever balloons.
 */
const ROW_CAP = 10_000;

/**
 * RFC 4180 escape — wrap in double quotes when the value contains
 * `,` / `"` / `\r` / `\n`, and double any embedded quotes. Matches
 * the pattern used elsewhere in the admin CSV exports.
 */
function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function row(fields: readonly (string | number | boolean | Date | null)[]): string {
  return fields
    .map((f) => {
      if (f === null || f === undefined) return '';
      if (f instanceof Date) return csvEscape(f.toISOString());
      if (typeof f === 'boolean') return f ? 'true' : 'false';
      return csvEscape(String(f));
    })
    .join(',');
}

export async function adminConfigsCsvHandler(c: Context): Promise<Response> {
  try {
    const rows = await db
      .select()
      .from(merchantCashbackConfigs)
      .orderBy(merchantCashbackConfigs.merchantId)
      .limit(ROW_CAP + 1); // +1 so we can detect truncation

    const truncated = rows.length > ROW_CAP;
    const emitted = truncated ? rows.slice(0, ROW_CAP) : rows;
    if (truncated) {
      log.warn({ rowCount: rows.length }, 'Cashback-configs CSV hit row cap');
    }

    const { merchantsById } = getMerchants();
    const lines: string[] = [row(HEADER)];
    for (const r of emitted) {
      lines.push(
        row([
          r.merchantId,
          merchantsById.get(r.merchantId)?.name ?? r.merchantId,
          r.wholesalePct,
          r.userCashbackPct,
          r.loopMarginPct,
          r.active,
          r.updatedBy,
          r.updatedAt,
        ]),
      );
    }
    if (truncated) {
      lines.push('__TRUNCATED__');
    }
    const body = `${lines.join('\r\n')}\r\n`;

    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="loop-cashback-configs.csv"',
        // Tier 3 convention (ADR 019) — exports can contain admin-
        // identifying data (updated_by) and should never be edge-cached.
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    log.error({ err }, 'Cashback-configs CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to export configs CSV' }, 500);
  }
}
