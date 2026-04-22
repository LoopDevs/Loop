/**
 * Admin user-detail drill-down.
 *
 * `GET /api/admin/users/:userId` — full user row for the admin panel's
 * user-detail page. Complement to the other per-user admin drills
 * (`/credits` for balances, `/credit-transactions` for ledger) — this
 * is the row the UI fetches first and uses to key off home currency,
 * admin flag, Stellar address, CTX linkage, etc.
 *
 * Uuid-validated, 404 on miss. Email + createdAt + updatedAt are
 * surfaced — the admin panel renders `createdAt` as "member since"
 * and uses `updatedAt` to spot recent support edits.
 */
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-detail' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminUserView {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: string;
  stellarAddress: string | null;
  ctxUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DbRow {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: string;
  stellarAddress: string | null;
  ctxUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function adminGetUserHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || userId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId is required' }, 400);
  }
  if (!UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }
  try {
    const [row] = (await db
      .select({
        id: users.id,
        email: users.email,
        isAdmin: users.isAdmin,
        homeCurrency: users.homeCurrency,
        stellarAddress: users.stellarAddress,
        ctxUserId: users.ctxUserId,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)) as DbRow[];
    if (row === undefined) {
      return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
    }
    return c.json<AdminUserView>({
      id: row.id,
      email: row.email,
      isAdmin: row.isAdmin,
      homeCurrency: row.homeCurrency,
      stellarAddress: row.stellarAddress,
      ctxUserId: row.ctxUserId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  } catch (err) {
    log.error({ err, userId }, 'Admin user-detail lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch user' }, 500);
  }
}
