/**
 * Admin per-user credit-transactions CSV export (ADR 009 / 019 Tier 3).
 *
 * `GET /api/admin/users/:userId/credit-transactions.csv` — emits the
 * full credit_transactions ledger for one user as a spreadsheet.
 * Support workflow: a user requests their ledger statement and an
 * admin pulls it on their behalf. The user-scoped cashback-history
 * CSV exists separately for self-service (ADR 017).
 *
 * 10 000-row cap per ADR 019 Tier 3; active users should stay well
 * under this for years. `__TRUNCATED__` sentinel on overflow + a
 * warn log so admin notices before the export is misread.
 */
import type { Context } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-credit-transactions-csv' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HEADER = [
  'Transaction ID',
  'Created at (UTC)',
  'Type',
  'Amount (minor)',
  'Currency',
  'Reference type',
  'Reference ID',
] as const;

const ROW_CAP = 10_000;

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(fields: readonly (string | bigint | Date | null)[]): string {
  return fields
    .map((f) => {
      if (f === null || f === undefined) return '';
      if (f instanceof Date) return csvEscape(f.toISOString());
      if (typeof f === 'bigint') return f.toString();
      return csvEscape(f);
    })
    .join(',');
}

export async function adminUserCreditTransactionsCsvHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || !UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a UUID' }, 400);
  }

  try {
    const rows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(ROW_CAP + 1);

    const truncated = rows.length > ROW_CAP;
    const emitted = truncated ? rows.slice(0, ROW_CAP) : rows;
    if (truncated) {
      log.warn({ userId, rowCount: rows.length }, 'User credit-transactions CSV hit row cap');
    }

    const lines: string[] = [csvRow(HEADER)];
    for (const r of emitted) {
      lines.push(
        csvRow([
          r.id,
          r.createdAt,
          r.type,
          r.amountMinor,
          r.currency,
          r.referenceType,
          r.referenceId,
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
        'content-disposition': `attachment; filename="loop-user-${userId}-credit-transactions.csv"`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    log.error({ err, userId }, 'User credit-transactions CSV failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to export credit-transactions CSV' },
      500,
    );
  }
}
