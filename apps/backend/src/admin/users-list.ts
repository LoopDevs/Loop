/**
 * Admin user list (paginated).
 *
 * `GET /api/admin/users` — newest-first paginated list of Loop users.
 * Optional `?q=` filters to emails containing that fragment
 * (case-insensitive ILIKE). Complements the exact-by-id drill at
 * `/api/admin/users/:userId` — this is the "browse + search" surface
 * for the admin panel's user directory.
 *
 * Cursor pagination on `createdAt`: `?before=<iso>` returns rows
 * strictly older. Limit clamps 1..100, default 20.
 */
import type { Context } from 'hono';
import { and, desc, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-users-list' });

export interface AdminUserListRow {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: string;
  createdAt: string;
}

export interface AdminUserListResponse {
  users: AdminUserListRow[];
}

interface DbRow {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: string;
  createdAt: Date;
}

// LIKE-pattern safety: escape the three ILIKE metacharacters so a
// search for `foo_bar` doesn't secretly match `foo?bar`. Backslash
// is the default ILIKE escape character; we prefix each special
// char with one.
function escapeLike(raw: string): string {
  return raw.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export async function adminListUsersHandler(c: Context): Promise<Response> {
  const qRaw = c.req.query('q');
  let qFragment: string | undefined;
  if (qRaw !== undefined && qRaw.length > 0) {
    if (qRaw.length > 254) {
      return c.json({ code: 'VALIDATION_ERROR', message: 'q is too long' }, 400);
    }
    qFragment = qRaw;
  }

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? '20', 10);
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 20 : parsedLimit, 1), 100);

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
    const conditions = [];
    if (qFragment !== undefined) {
      const pattern = `%${escapeLike(qFragment.toLowerCase())}%`;
      conditions.push(sql`LOWER(${users.email}) LIKE ${pattern}`);
    }
    if (before !== undefined) conditions.push(lt(users.createdAt, before));
    const where = conditions.length === 0 ? undefined : and(...conditions);

    const q = db
      .select({
        id: users.id,
        email: users.email,
        isAdmin: users.isAdmin,
        homeCurrency: users.homeCurrency,
        createdAt: users.createdAt,
      })
      .from(users);
    const filtered = where === undefined ? q : q.where(where);
    const rows = (await filtered.orderBy(desc(users.createdAt)).limit(limit)) as DbRow[];

    return c.json<AdminUserListResponse>({
      users: rows.map((r) => ({
        id: r.id,
        email: r.email,
        isAdmin: r.isAdmin,
        homeCurrency: r.homeCurrency,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    log.error({ err }, 'Admin users list failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to list users' }, 500);
  }
}
