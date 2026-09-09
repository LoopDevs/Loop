/**
 * Admin write-audit tail (ADR 017 / 018).
 *
 * `GET /api/admin/audit-tail`     — newest admin writes, paginated
 * `GET /api/admin/audit-tail.csv` — the same, for finance and legal
 *
 * Reads `admin_idempotency_keys`, which doubles as the durable record
 * of every applied admin mutation: a row exists there only because its
 * write committed, and NS-03 retention keeps it long after its 24h
 * replay window has closed. So the same rows that make a retry safe
 * are also the answer to "what have admins actually done".
 *
 * The stored response body is deliberately NOT echoed. It is whatever
 * the endpoint returned, which for some writes includes the target's
 * details; the tail is a "who did what, when" index, and an operator
 * who needs the payload can pull the specific write. What it does
 * surface is the actor's email, resolved at read time rather than
 * stored — an actor who is later renamed should read correctly in the
 * history, and denormalising it would freeze a stale copy.
 */
import type { Context } from 'hono';
import { db } from '../db/client.js';
import type { AdminIdempotencyKeyDoc } from '../db/types.js';
import type { Filter } from '../db/store.js';
import { logger } from '../logger.js';
import { csvRow } from './csv-escape.js';

const log = logger.child({ handler: 'admin-audit-tail' });

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const CSV_MAX_ROWS = 5000;

export interface AdminAuditTailRow {
  actorUserId: string;
  /** Resolved at read time; null when the actor's row is gone. */
  actorEmail: string | null;
  idempotencyKey: string;
  method: string;
  path: string;
  status: number;
  appliedAt: string;
}

export interface AdminAuditTailResponse {
  rows: AdminAuditTailRow[];
}

/** Shared parse for the JSON tail and its CSV twin. */
function parseQuery(
  c: Context,
  maxLimit: number,
): Response | { filter: Filter<AdminIdempotencyKeyDoc>; limit: number } {
  const filter: Filter<AdminIdempotencyKeyDoc> = {};

  const actorUserId = c.req.query('actorUserId');
  if (actorUserId !== undefined && actorUserId.length > 0) {
    filter.adminUserId = actorUserId;
  }

  const beforeRaw = c.req.query('before');
  if (beforeRaw !== undefined && beforeRaw.length > 0) {
    const d = new Date(beforeRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'before must be an ISO-8601 timestamp' },
        400,
      );
    }
    filter.createdAt = { $lt: d };
  }

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? String(DEFAULT_LIMIT), 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit, 1),
    maxLimit,
  );

  return { filter, limit };
}

/** Resolves actor emails for a page of rows in one pass. */
async function resolveActorEmails(
  rows: readonly AdminIdempotencyKeyDoc[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.adminUserId))];
  const users = await Promise.all(ids.map(async (id) => db.collection('users').findOne({ id })));
  const byId = new Map<string, string>();
  for (const user of users) {
    if (user !== null) byId.set(user.id, user.email);
  }
  return byId;
}

function toRows(
  rows: readonly AdminIdempotencyKeyDoc[],
  emails: Map<string, string>,
): AdminAuditTailRow[] {
  return rows.map((r) => ({
    actorUserId: r.adminUserId,
    actorEmail: emails.get(r.adminUserId) ?? null,
    idempotencyKey: r.key,
    method: r.method,
    path: r.path,
    status: r.status,
    appliedAt: r.createdAt.toISOString(),
  }));
}

/** GET /api/admin/audit-tail */
export async function adminAuditTailHandler(c: Context): Promise<Response> {
  const parsed = parseQuery(c, MAX_LIMIT);
  if (parsed instanceof Response) return parsed;

  try {
    const rows = await db
      .collection('admin_idempotency_keys')
      .findMany(parsed.filter, { sort: [['createdAt', 'desc']], limit: parsed.limit });
    return c.json<AdminAuditTailResponse>({
      rows: toRows(rows, await resolveActorEmails(rows)),
    });
  } catch (err) {
    log.error({ err }, 'Admin audit tail query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load the audit tail' }, 500);
  }
}

/** GET /api/admin/audit-tail.csv */
export async function adminAuditTailCsvHandler(c: Context): Promise<Response> {
  const parsed = parseQuery(c, CSV_MAX_ROWS);
  if (parsed instanceof Response) return parsed;

  try {
    const found = await db
      .collection('admin_idempotency_keys')
      .findMany(parsed.filter, { sort: [['createdAt', 'desc']], limit: CSV_MAX_ROWS + 1 });
    const truncated = found.length > CSV_MAX_ROWS;
    const rows = truncated ? found.slice(0, CSV_MAX_ROWS) : found;
    const emails = await resolveActorEmails(rows);

    const lines = [
      csvRow([
        'applied_at',
        'actor_user_id',
        'actor_email',
        'method',
        'path',
        'status',
        'idempotency_key',
      ]),
    ];
    for (const r of toRows(rows, emails)) {
      lines.push(
        csvRow([
          r.appliedAt,
          r.actorUserId,
          r.actorEmail,
          r.method,
          r.path,
          String(r.status),
          r.idempotencyKey,
        ]),
      );
    }
    if (truncated) {
      lines.push(csvRow([`TRUNCATED at ${CSV_MAX_ROWS} rows — narrow the range and re-export`]));
    }

    return new Response(`${lines.join('\n')}\n`, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="admin-audit-tail.csv"',
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin audit-tail CSV export failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to export the audit tail' }, 500);
  }
}
