/**
 * Admin exact-match user lookup by email.
 *
 * `GET /api/admin/users/by-email?email=<address>` — support pastes the
 * full email address from a customer ticket, gets the user id + profile
 * back in one request. Complements the fragment search on
 * `/api/admin/users?q=` (ILIKE-based, pagination) — this one does exact
 * equality against a normalised lowercase form and always returns at
 * most one row.
 *
 * Emails are case-insensitive in practice ("Alice@Example.COM" is the
 * same mailbox as "alice@example.com") but the `users.email` column
 * stores whatever signup recorded. Normalise to lowercase both sides
 * of the comparison so an admin pasting the exact string from a
 * support ticket doesn't miss the row on case alone.
 *
 * The handler is deliberately narrower than `/users?q=`: one row by
 * exact match, no pagination, different 404 semantics when nothing
 * matches. Support workflow is "I have the address, give me the user" —
 * a fragment search would force them to re-select from suggestions.
 */
import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-by-email' });

// Plausible email shape — not a full RFC 5321 validator. Full
// validation lives at signup; this handler just filters obvious
// garbage (missing '@', embedded whitespace) so the DB lookup
// doesn't waste a round-trip on syntactically impossible input.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;

export interface AdminUserByEmailView {
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

export async function adminUserByEmailHandler(c: Context): Promise<Response> {
  const raw = c.req.query('email');
  if (raw === undefined || raw.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'email is required' }, 400);
  }
  if (raw.length > EMAIL_MAX_LENGTH) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: `email must be at most ${EMAIL_MAX_LENGTH} chars` },
      400,
    );
  }
  if (!EMAIL_SHAPE.test(raw)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'email must look like an email' }, 400);
  }
  const normalised = raw.toLowerCase();

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
      .where(eq(sql`LOWER(${users.email})`, normalised))
      .limit(1)) as DbRow[];
    if (row === undefined) {
      return c.json({ code: 'NOT_FOUND', message: 'No user with that email' }, 404);
    }
    return c.json<AdminUserByEmailView>({
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
    log.error({ err }, 'Admin user-by-email lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to look up user' }, 500);
  }
}
