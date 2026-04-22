/**
 * Admin cashback-configs history CSV export (ADR 011 / 019 Tier 3).
 *
 * `GET /api/admin/merchant-cashback-configs/history.csv` — Tier 3
 * companion to the JSON history feed. Same rows, newest-first, but
 * streamed as CSV so admins can analyse pricing changes over time in
 * a spreadsheet (average config lifetime, most-edited merchants,
 * who-changed-what audit trails).
 *
 * Column order mirrors the JSON feed's field order. Adding a column
 * is backwards-compatible; renaming / reordering is breaking — per
 * ADR 019 Tier 3 conventions.
 */
import type { Context } from 'hono';
import { desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { merchantCashbackConfigHistory } from '../db/schema.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-configs-history-csv' });

const HEADER = [
  'History ID',
  'Changed at (UTC)',
  'Merchant ID',
  'Merchant name',
  'Wholesale %',
  'User cashback %',
  'Loop margin %',
  'Active',
  'Changed by',
] as const;

const ROW_CAP = 10_000;

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(fields: readonly (string | number | boolean | Date | null)[]): string {
  return fields
    .map((f) => {
      if (f === null || f === undefined) return '';
      if (f instanceof Date) return csvEscape(f.toISOString());
      if (typeof f === 'boolean') return f ? 'true' : 'false';
      return csvEscape(String(f));
    })
    .join(',');
}

export async function adminConfigsHistoryCsvHandler(c: Context): Promise<Response> {
  try {
    const rows = await db
      .select()
      .from(merchantCashbackConfigHistory)
      .orderBy(desc(merchantCashbackConfigHistory.changedAt))
      .limit(ROW_CAP + 1);

    const truncated = rows.length > ROW_CAP;
    const emitted = truncated ? rows.slice(0, ROW_CAP) : rows;
    if (truncated) {
      log.warn({ rowCount: rows.length }, 'Configs-history CSV hit row cap');
    }

    const { merchantsById } = getMerchants();
    const lines: string[] = [csvRow(HEADER)];
    for (const r of emitted) {
      lines.push(
        csvRow([
          r.id,
          r.changedAt,
          r.merchantId,
          merchantsById.get(r.merchantId)?.name ?? r.merchantId,
          r.wholesalePct,
          r.userCashbackPct,
          r.loopMarginPct,
          r.active,
          r.changedBy,
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
        'content-disposition': 'attachment; filename="loop-cashback-configs-history.csv"',
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    log.error({ err }, 'Configs-history CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to export configs history CSV' }, 500);
  }
}
