/**
 * Admin user-credits CSV export (ADR 009 / 019 Tier 3).
 *
 * `GET /api/admin/user-credits.csv` — one row per `(user_id, currency)`
 * balance, joined to `users` for email. Support uses this to audit
 * total liability per currency, reconcile against reports, or pull
 * a list of balance-holders.
 *
 * Columns: User ID, Email, Currency, Balance (minor), Updated at
 * (UTC). Bigint-safe balance as a raw integer string.
 *
 * Tier 3 conventions per ADR 019: text/csv + attachment,
 * `Cache-Control: private, no-store` (contains email), RFC 4180
 * escape, 10 000-row cap with `__TRUNCATED__` sentinel + log.warn.
 */
import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { userCredits, users } from '../db/schema.js';
import { logger } from '../logger.js';
import { csvEscape } from './csv-escape.js';

const log = logger.child({ handler: 'admin-user-credits-csv' });

const HEADER = ['User ID', 'Email', 'Currency', 'Balance (minor)', 'Updated at (UTC)'] as const;

const ROW_CAP = 10_000;

function csvRow(fields: readonly (string | number | bigint | Date | null)[]): string {
  return fields
    .map((f) => {
      if (f === null || f === undefined) return '';
      if (f instanceof Date) return csvEscape(f.toISOString());
      if (typeof f === 'bigint') return f.toString();
      return csvEscape(String(f));
    })
    .join(',');
}

export async function adminUserCreditsCsvHandler(c: Context): Promise<Response> {
  try {
    // Join on users to pull email for the spreadsheet. Order by
    // currency then balance desc so a "top holders" audit is the
    // natural read order.
    const rows = await db
      .select({
        userId: userCredits.userId,
        email: users.email,
        currency: userCredits.currency,
        balanceMinor: userCredits.balanceMinor,
        updatedAt: userCredits.updatedAt,
      })
      .from(userCredits)
      .innerJoin(users, eq(users.id, userCredits.userId))
      .orderBy(userCredits.currency, sql`${userCredits.balanceMinor} DESC`)
      .limit(ROW_CAP + 1);

    const truncated = rows.length > ROW_CAP;
    const emitted = truncated ? rows.slice(0, ROW_CAP) : rows;
    if (truncated) {
      log.warn({ rowCount: rows.length }, 'User-credits CSV hit row cap');
    }

    const lines: string[] = [csvRow(HEADER)];
    for (const r of emitted) {
      lines.push(csvRow([r.userId, r.email, r.currency, r.balanceMinor, r.updatedAt]));
    }
    if (truncated) {
      // A2-510: route the sentinel through csvRow so the truncation
      // shape matches every other Tier-3 admin export (payouts-csv,
      // merchants-catalog-csv, supplier-spend-activity-csv). Output
      // byte stays identical today because the sentinel has no
      // RFC-4180 escapables, but unifying the path keeps the shape
      // drift-free if the sentinel or csvRow format ever changes.
      lines.push(csvRow(['__TRUNCATED__']));
    }
    const body = `${lines.join('\r\n')}\r\n`;

    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="loop-user-credits.csv"',
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    log.error({ err }, 'User-credits CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to export user-credits CSV' }, 500);
  }
}
