/**
 * Admin audit-tail CSV export (ADR 017 / 018).
 *
 * `GET /api/admin/audit-tail.csv` — finance-ready CSV of admin
 * write-audit rows (`admin_idempotency_keys` joined to `users` for
 * the actor email) in a time window. Compliance / legal hand-off:
 * SOC-2 auditors want a month of admin-write history exportable in
 * a neutral format, and Linear / Slack exports don't cut it.
 *
 * Window: `?since=<iso>` lower bound on `created_at`, default 31
 * days ago. Capped at 366 days so an unbounded request can't scan
 * the full table. Row cap 10k — over the cap, the response emits a
 * single `__TRUNCATED__` sentinel row and the handler log-warns
 * with the real rowCount so ops knows to narrow the window.
 *
 * Response body is the audit envelope without the stored response
 * body — actor / method / path / status / timestamp only. That
 * mirrors the JSON tail's contract: audit is "who did what, when",
 * not "here's the prior 200 payload".
 */
import type { Context } from 'hono';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { adminIdempotencyKeys, users } from '../db/schema.js';
import { logger } from '../logger.js';
import { csvEscape } from './csv-escape.js';

const log = logger.child({ handler: 'admin-audit-tail-csv' });

const DEFAULT_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const ROW_CAP = 10_000;

const HEADERS = [
  'actor_user_id',
  'actor_email',
  'method',
  'path',
  'status',
  'idempotency_key',
  'created_at',
] as const;

function csvRow(values: Array<string | null | undefined>): string {
  return values.map((v) => csvEscape(v ?? null)).join(',');
}

interface Row {
  adminUserId: string;
  actorEmail: string;
  method: string;
  path: string;
  status: number;
  key: string;
  createdAt: Date;
}

export async function adminAuditTailCsvHandler(c: Context): Promise<Response> {
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
      .select({
        adminUserId: adminIdempotencyKeys.adminUserId,
        method: adminIdempotencyKeys.method,
        path: adminIdempotencyKeys.path,
        status: adminIdempotencyKeys.status,
        key: adminIdempotencyKeys.key,
        createdAt: adminIdempotencyKeys.createdAt,
        actorEmail: users.email,
      })
      .from(adminIdempotencyKeys)
      .innerJoin(users, eq(adminIdempotencyKeys.adminUserId, users.id))
      .where(sql`${adminIdempotencyKeys.createdAt} >= ${since}`)
      .orderBy(asc(adminIdempotencyKeys.createdAt))
      .limit(ROW_CAP + 1)) as Row[];

    const lines: string[] = [HEADERS.join(',')];
    const truncated = rows.length > ROW_CAP;
    const emitted = truncated ? rows.slice(0, ROW_CAP) : rows;

    for (const r of emitted) {
      lines.push(
        csvRow([
          r.adminUserId,
          r.actorEmail,
          r.method,
          r.path,
          r.status.toString(),
          r.key,
          r.createdAt.toISOString(),
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { rowCount: rows.length, since: since.toISOString() },
        'Admin audit-tail CSV truncated — narrow the window',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const filename = `admin-audit-${since.toISOString().slice(0, 10)}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin audit-tail CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
