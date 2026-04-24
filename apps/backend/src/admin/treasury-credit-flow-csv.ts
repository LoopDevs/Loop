/**
 * Admin treasury credit-flow CSV export (ADR 009 / 015 / 018).
 *
 * `GET /api/admin/treasury/credit-flow.csv?days=31&currency=USD` —
 * RFC 4180 CSV form of the credit-flow time series (per-day × per-
 * currency credited / debited / net from `credit_transactions`).
 *
 * Completes the finance-CSV quartet next to the existing exports:
 *   - cashback-activity.csv         — what Loop minted
 *   - payouts-activity.csv          — what Loop settled on-chain
 *   - supplier-spend/activity.csv   — what Loop paid CTX
 *   - treasury/credit-flow.csv      — net ledger movement (this file)
 *
 * Each row is an (day, currency) tuple:
 *   day,currency,credited_minor,debited_minor,net_minor
 *
 * Zero-activity days emit a single row with empty `currency` and
 * all amounts at 0 — same convention as the other Tier-3 exports.
 *
 * `?currency=USD|GBP|EUR` filters via LEFT JOIN generate_series to
 * zero-fill every day (stable chart layout). Without the filter,
 * only (day, currency) pairs with activity appear.
 *
 * Window: `?days=<N>` (default 31, cap 366). Row cap 10 000 with
 * `__TRUNCATED__` sentinel. Every money column bigint-as-string
 * (preserves precision past 2^53).
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { HOME_CURRENCIES, type HomeCurrency } from '../db/schema.js';
import { logger } from '../logger.js';
import { csvEscape } from './csv-escape.js';

const log = logger.child({ handler: 'admin-treasury-credit-flow-csv' });

const DEFAULT_DAYS = 31;
const MAX_DAYS = 366;
const ROW_CAP = 10_000;

const HEADERS = ['day', 'currency', 'credited_minor', 'debited_minor', 'net_minor'] as const;

function csvRow(values: Array<string | null | undefined>): string {
  return values.map((v) => csvEscape(v ?? null)).join(',');
}

interface AggRow {
  day: string | Date;
  currency: string | null;
  credited_minor: string | number | bigint;
  debited_minor: string | number | bigint;
}

function toYmd(day: string | Date): string {
  if (typeof day === 'string') return day.slice(0, 10);
  return day.toISOString().slice(0, 10);
}

function toBigInt(v: string | number | bigint): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  return BigInt(v);
}

function isHomeCurrency(v: string): v is HomeCurrency {
  return (HOME_CURRENCIES as ReadonlyArray<string>).includes(v);
}

export async function adminTreasuryCreditFlowCsvHandler(c: Context): Promise<Response> {
  const daysRaw = c.req.query('days');
  const parsedDays = Number.parseInt(daysRaw ?? `${DEFAULT_DAYS}`, 10);
  const days = Math.min(
    Math.max(Number.isNaN(parsedDays) ? DEFAULT_DAYS : parsedDays, 1),
    MAX_DAYS,
  );

  const currencyRaw = c.req.query('currency');
  let currencyFilter: HomeCurrency | null = null;
  if (currencyRaw !== undefined && currencyRaw.length > 0) {
    const upper = currencyRaw.toUpperCase();
    if (!isHomeCurrency(upper)) {
      return c.json(
        {
          code: 'VALIDATION_ERROR',
          message: `currency must be one of ${HOME_CURRENCIES.join(', ')}`,
        },
        400,
      );
    }
    currencyFilter = upper;
  }

  try {
    const result = currencyFilter
      ? await db.execute(sql`
          WITH days AS (
            SELECT generate_series(
              (CURRENT_DATE - (${days - 1}::int))::date,
              CURRENT_DATE,
              '1 day'::interval
            )::date AS d
          )
          SELECT
            days.d::text AS day,
            ${currencyFilter}::text AS currency,
            COALESCE(
              SUM(ct.amount_minor) FILTER (WHERE ct.amount_minor > 0),
              0
            )::text AS credited_minor,
            COALESCE(
              -SUM(ct.amount_minor) FILTER (WHERE ct.amount_minor < 0),
              0
            )::text AS debited_minor
          FROM days
          LEFT JOIN credit_transactions ct
            ON ct.created_at::date = days.d
           AND ct.currency = ${currencyFilter}
          GROUP BY days.d
          ORDER BY days.d ASC
          LIMIT ${ROW_CAP + 1}
        `)
      : await db.execute(sql`
          SELECT
            DATE_TRUNC('day', ct.created_at AT TIME ZONE 'UTC')::date::text AS day,
            ct.currency AS currency,
            COALESCE(
              SUM(ct.amount_minor) FILTER (WHERE ct.amount_minor > 0),
              0
            )::text AS credited_minor,
            COALESCE(
              -SUM(ct.amount_minor) FILTER (WHERE ct.amount_minor < 0),
              0
            )::text AS debited_minor
          FROM credit_transactions ct
          WHERE ct.created_at >=
            DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '1 day' * (${days - 1})
          GROUP BY DATE_TRUNC('day', ct.created_at AT TIME ZONE 'UTC'), ct.currency
          ORDER BY day ASC, currency ASC
          LIMIT ${ROW_CAP + 1}
        `);

    const rows = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const lines: string[] = [HEADERS.join(',')];
    const truncated = rows.length > ROW_CAP;
    const emitted = truncated ? rows.slice(0, ROW_CAP) : rows;

    for (const r of emitted) {
      const credited = toBigInt(r.credited_minor);
      const debited = toBigInt(r.debited_minor);
      const net = credited - debited;
      lines.push(
        csvRow([
          toYmd(r.day),
          r.currency ?? '',
          credited.toString(),
          debited.toString(),
          net.toString(),
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { rowCount: rows.length, days },
        'Admin treasury credit-flow CSV truncated — narrow the window',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const today = new Date().toISOString().slice(0, 10);
    const filename = `treasury-credit-flow-${today}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin treasury credit-flow CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
