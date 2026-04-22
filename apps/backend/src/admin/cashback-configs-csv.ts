/**
 * Admin cashback-configs CSV export (ADR 011 / 018).
 *
 * `GET /api/admin/merchant-cashback-configs.csv` — Tier-3 bulk
 * export per ADR 018 so admins can audit the commercial-terms table
 * in a spreadsheet (or prep bulk edits — a bulk-import endpoint is
 * a separate slice).
 *
 * Complements the Tier-2 list endpoint
 * (`GET /api/admin/merchant-cashback-configs`) + per-merchant history
 * drill (`/merchant-cashback-configs/:merchantId/history`). This is
 * the flat snapshot of *current* terms across every configured
 * merchant — it doesn't attempt to replay history (the per-row
 * history endpoint owns that).
 *
 * Column layout is deliberately spreadsheet-friendly:
 *
 *   merchant_id, merchant_name, wholesale_pct, user_cashback_pct,
 *   loop_margin_pct, active, updated_by, updated_at
 *
 * Merchant-name resolution follows the ADR 021 Rule A fallback:
 * evicted-merchant rows render the `merchant_id` as the name so the
 * admin can still act on the row.
 *
 * Active flag serialises as the literal `true` / `false` so
 * spreadsheet filters work (blank-vs-"false" is a common footgun).
 *
 * RFC 4180: CRLF line endings, quote-escape cells containing
 * `"`, `,`, or newline, `Content-Disposition: attachment`,
 * `Cache-Control: private, no-store` (the `updated_by` column can
 * identify an admin). Row cap 10 000 with `__TRUNCATED__` sentinel
 * on overflow — the merchant_cashback_configs table is at most
 * ~hundreds of rows in practice, but the cap matches the other
 * admin CSVs so the behaviour is uniform.
 */
import type { Context } from 'hono';
import { desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { merchantCashbackConfigs } from '../db/schema.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-cashback-configs-csv' });

const ROW_CAP = 10_000;

const HEADERS = [
  'merchant_id',
  'merchant_name',
  'wholesale_pct',
  'user_cashback_pct',
  'loop_margin_pct',
  'active',
  'updated_by',
  'updated_at',
] as const;

function csvEscape(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function csvRow(values: Array<string | null | undefined>): string {
  return values.map((v) => csvEscape(v ?? null)).join(',');
}

interface ConfigRow {
  merchantId: string;
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  active: boolean;
  updatedBy: string;
  updatedAt: Date;
}

export async function adminCashbackConfigsCsvHandler(c: Context): Promise<Response> {
  try {
    const rows = (await db
      .select({
        merchantId: merchantCashbackConfigs.merchantId,
        wholesalePct: merchantCashbackConfigs.wholesalePct,
        userCashbackPct: merchantCashbackConfigs.userCashbackPct,
        loopMarginPct: merchantCashbackConfigs.loopMarginPct,
        active: merchantCashbackConfigs.active,
        updatedBy: merchantCashbackConfigs.updatedBy,
        updatedAt: merchantCashbackConfigs.updatedAt,
      })
      .from(merchantCashbackConfigs)
      .orderBy(desc(merchantCashbackConfigs.updatedAt))
      .limit(ROW_CAP + 1)) as ConfigRow[];

    const { merchantsById } = getMerchants();

    const lines: string[] = [HEADERS.join(',')];
    const truncated = rows.length > ROW_CAP;
    const emitted = truncated ? rows.slice(0, ROW_CAP) : rows;

    for (const r of emitted) {
      // ADR 021 Rule A: admin surfaces fall back to merchantId as the
      // display name when the catalog has evicted the merchant.
      const name = merchantsById.get(r.merchantId)?.name ?? r.merchantId;
      lines.push(
        csvRow([
          r.merchantId,
          name,
          r.wholesalePct,
          r.userCashbackPct,
          r.loopMarginPct,
          r.active ? 'true' : 'false',
          r.updatedBy,
          r.updatedAt.toISOString(),
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { rowCount: rows.length },
        'Admin cashback-configs CSV truncated — merchant_cashback_configs grew past the row cap',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const filename = `cashback-configs-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin cashback-configs CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
