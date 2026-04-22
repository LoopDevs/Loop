/**
 * Admin merchants-catalog CSV export (ADR 011 / 018).
 *
 * `GET /api/admin/merchants-catalog.csv` — every merchant in the
 * in-memory catalog joined against the admin
 * merchant_cashback_configs table. Finance / BD runs this to get
 * a single spreadsheet view of "what commercial terms does Loop
 * have across the whole catalog?" without clicking through the
 * /admin/merchants UI one row at a time.
 *
 * Shape (one row per catalog merchant):
 *   merchant_id,name,enabled,user_cashback_pct,active,updated_by,updated_at
 *
 * Merchants without a cashback_config row emit empty values for
 * the config columns — the "no config yet" state, distinct from
 * an explicit `active=false` row (ADR 011). Merchants evicted
 * from the catalog (ADR 021 Rule B) do NOT appear — we join on
 * the catalog as the source of truth; a config row pointing at
 * an evicted merchant is a stale pointer that shouldn't surface
 * on a finance export.
 *
 * ADR 018 Tier-3 conventions:
 *   - RFC 4180 CSV: CRLF line endings, comma escape, quote-double
 *   - 10 000 row cap with `__TRUNCATED__` sentinel + log.warn
 *   - Rate-limited 10/min
 *   - Cache-Control: private, no-store
 *   - Content-Disposition: attachment; filename=merchants-catalog-YYYY-MM-DD.csv
 */
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { merchantCashbackConfigs } from '../db/schema.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-merchants-catalog-csv' });

const ROW_CAP = 10_000;

const HEADERS = [
  'merchant_id',
  'name',
  'enabled',
  'user_cashback_pct',
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
  userCashbackPct: string;
  active: boolean;
  updatedBy: string;
  updatedAt: Date | string;
}

function formatTimestamp(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return value;
}

export async function adminMerchantsCatalogCsvHandler(c: Context): Promise<Response> {
  try {
    const configRows = (await db
      .select({
        merchantId: merchantCashbackConfigs.merchantId,
        userCashbackPct: merchantCashbackConfigs.userCashbackPct,
        active: merchantCashbackConfigs.active,
        updatedBy: merchantCashbackConfigs.updatedBy,
        updatedAt: merchantCashbackConfigs.updatedAt,
      })
      .from(merchantCashbackConfigs)
      .where(
        eq(merchantCashbackConfigs.merchantId, merchantCashbackConfigs.merchantId),
      )) as ConfigRow[];

    const configsById = new Map<string, ConfigRow>();
    for (const r of configRows) configsById.set(r.merchantId, r);

    const { merchants } = getMerchants();
    const total = merchants.length;
    const truncated = total > ROW_CAP;
    const emitted = truncated ? merchants.slice(0, ROW_CAP) : merchants;

    const lines: string[] = [HEADERS.join(',')];
    for (const m of emitted) {
      const cfg = configsById.get(m.id);
      lines.push(
        csvRow([
          m.id,
          m.name,
          String(m.enabled !== false),
          cfg?.userCashbackPct ?? '',
          cfg === undefined ? '' : String(cfg.active),
          cfg?.updatedBy ?? '',
          formatTimestamp(cfg?.updatedAt),
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { total, cap: ROW_CAP },
        'Admin merchants-catalog CSV truncated — catalog exceeded row cap',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const today = new Date().toISOString().slice(0, 10);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="merchants-catalog-${today}.csv"`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin merchants-catalog CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
