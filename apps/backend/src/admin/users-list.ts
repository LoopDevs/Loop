/**
 * Admin user list (paginated).
 *
 * `GET /api/admin/users` — newest-first page of Loop users, optionally
 * filtered by an email fragment (`?q=`). Complements the exact drill
 * at `/api/admin/users/:userId`: this is the browse surface for the
 * admin panel's user directory, where `users/search` is the
 * type-ahead.
 *
 * Cursor pagination on `createdAt`: `?before=<iso>` returns rows
 * strictly older. Limit clamps 1..100, default 20.
 */
import type { Context } from 'hono';
import { db } from '../db/client.js';
import { containsFilter } from '../db/store.js';
import type { Filter } from '../db/store.js';
import type { UserDoc } from '../db/types.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-users-list' });

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

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
  const parsedLimit = Number.parseInt(limitRaw ?? String(DEFAULT_LIMIT), 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit, 1),
    MAX_LIMIT,
  );

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
    const filter: Filter<UserDoc> = {};
    if (qFragment !== undefined) filter.email = containsFilter(qFragment);
    if (before !== undefined) filter.createdAt = { $lt: before };

    const rows = await db
      .collection('users')
      .findMany(filter, { sort: [['createdAt', 'desc']], limit });

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
