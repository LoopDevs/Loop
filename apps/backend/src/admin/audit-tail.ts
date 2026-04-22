/**
 * Admin audit tail (ADR 017 / 018).
 *
 * Newest-first snapshot of `admin_idempotency_keys` — the store
 * every admin write lands in. Gives ops a one-page view of "what
 * admin activity has happened recently" without having to scroll
 * the Discord channel. Joins `users` for the actor's email so the
 * UI doesn't have to round-trip a separate fetch.
 *
 * Response intentionally omits the stored response body: audit is
 * "who did what, when" not "here's the prior 200 payload". Callers
 * that want the full snapshot can hit the endpoint's own replay
 * path with the original Idempotency-Key.
 */
import type { Context } from 'hono';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { adminIdempotencyKeys, users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-audit-tail' });

export interface AdminAuditTailRow {
  actorUserId: string;
  actorEmail: string;
  method: string;
  path: string;
  status: number;
  createdAt: string;
}

export interface AdminAuditTailResponse {
  rows: AdminAuditTailRow[];
}

interface DbRow {
  adminUserId: string;
  method: string;
  path: string;
  status: number;
  createdAt: Date;
  actorEmail: string;
}

export async function adminAuditTailHandler(c: Context): Promise<Response> {
  const limitRaw = c.req.query('limit');
  const parsed = Number.parseInt(limitRaw ?? '25', 10);
  const limit = Math.min(Math.max(Number.isNaN(parsed) ? 25 : parsed, 1), 100);

  const beforeRaw = c.req.query('before');
  let before: Date | undefined;
  if (beforeRaw !== undefined && beforeRaw.length > 0) {
    const d = new Date(beforeRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'before must be an ISO-8601 timestamp' },
        400,
      );
    }
    before = d;
  }

  try {
    const base = db
      .select({
        adminUserId: adminIdempotencyKeys.adminUserId,
        method: adminIdempotencyKeys.method,
        path: adminIdempotencyKeys.path,
        status: adminIdempotencyKeys.status,
        createdAt: adminIdempotencyKeys.createdAt,
        actorEmail: users.email,
      })
      .from(adminIdempotencyKeys)
      .innerJoin(users, eq(adminIdempotencyKeys.adminUserId, users.id));
    const filtered =
      before === undefined ? base : base.where(sql`${adminIdempotencyKeys.createdAt} < ${before}`);
    const rows = (await filtered
      .orderBy(desc(adminIdempotencyKeys.createdAt))
      .limit(limit)) as DbRow[];

    return c.json<AdminAuditTailResponse>({
      rows: rows.map((r) => ({
        actorUserId: r.adminUserId,
        actorEmail: r.actorEmail,
        method: r.method,
        path: r.path,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    log.error({ err }, 'Admin audit tail failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load audit tail' }, 500);
  }
}
