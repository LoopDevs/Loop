/**
 * Admin per-user credit-transactions CSV export (ADR 009 / 015).
 *
 * `GET /api/admin/users/:userId/credit-transactions.csv` — finance /
 * compliance / support CSV of one user's full credit-ledger history
 * in a window. Support use: hand the rows to a user disputing a
 * balance, or to legal for a subject-access-request response.
 * Mirrors the JSON endpoint at the same path (without `.csv`) but
 * emits RFC 4180 CSV with the standard attachment headers.
 *
 * Window: `?since=<iso>` lower bound on `created_at`, default 366d
 * (one year — the most common SAR window). Capped at 366 days so
 * an unbounded request can't scan the whole table. Row cap 10 000
 * — over the cap, a single `__TRUNCATED__` sentinel row trails the
 * output + the handler log-warns the real rowCount.
 *
 * Response body: id, type, amount_minor, currency, reference_type,
 * reference_id, created_at. bigint-as-string for amount_minor;
 * ISO-8601 for created_at. No cross-user leakage — the `user_id`
 * lives in the URL, not the payload.
 */
import type { Context } from 'hono';
import { UUID_RE } from '../uuid.js';
import { and, asc, eq, gte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions } from '../db/schema.js';
import { logger } from '../logger.js';
import { csvEscape } from './csv-escape.js';

const log = logger.child({ handler: 'admin-user-credit-transactions-csv' });

const DEFAULT_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const ROW_CAP = 10_000;

const HEADERS = [
  'id',
  'type',
  'amount_minor',
  'currency',
  'reference_type',
  'reference_id',
  'created_at',
] as const;

function csvRow(values: Array<string | null | undefined>): string {
  return values.map((v) => csvEscape(v ?? null)).join(',');
}

interface Row {
  id: string;
  type: string;
  amountMinor: bigint;
  currency: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
}

export async function adminUserCreditTransactionsCsvHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || userId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId is required' }, 400);
  }
  if (!UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }

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
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.userId, userId),
          // A2-1610: typed `gte()` — see matching fix in `audit-tail-csv.ts`.
          gte(creditTransactions.createdAt, since),
        ),
      )
      .orderBy(asc(creditTransactions.createdAt))
      .limit(ROW_CAP + 1)) as Row[];

    const lines: string[] = [HEADERS.join(',')];
    const truncated = rows.length > ROW_CAP;
    const emitted = truncated ? rows.slice(0, ROW_CAP) : rows;

    for (const r of emitted) {
      lines.push(
        csvRow([
          r.id,
          r.type,
          r.amountMinor.toString(),
          r.currency,
          r.referenceType,
          r.referenceId,
          r.createdAt.toISOString(),
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { rowCount: rows.length, userId, since: since.toISOString() },
        'Admin user credit-transactions CSV truncated — narrow the window',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const filename = `credit-transactions-${userId.slice(0, 8)}-${since.toISOString().slice(0, 10)}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err, userId }, 'Admin user credit-transactions CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
