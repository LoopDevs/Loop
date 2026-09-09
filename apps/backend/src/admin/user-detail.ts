/**
 * Admin user-detail drill-down and its two lookup siblings.
 *
 * `GET /api/admin/users/:userId`        — the row by internal uuid
 * `GET /api/admin/users/by-email?email` — the row by exact address
 *
 * The detail row is what the admin panel's user page fetches first and
 * keys everything else off: home currency, staff tier, CTX linkage,
 * "member since". `updatedAt` is surfaced because it is how support
 * spots a recent edit.
 *
 * The by-email variant is deliberately narrower than the `?q=`
 * fragment search: one row by exact match, no pagination, a 404 when
 * nothing matches. The support workflow is "I have the address from
 * the ticket, give me the user" — a fragment search would make them
 * re-select from suggestions. Emails are case-insensitive in practice
 * ("Alice@Example.COM" is the same mailbox), and the stored form is
 * already normalised at signup, so the comparison lowercases the input
 * to match.
 */
import type { Context } from 'hono';
import { UUID_RE } from '../uuid.js';
import { db } from '../db/client.js';
import type { UserDoc } from '../db/types.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-detail' });

// Plausible email shape — not a full RFC 5321 validator. Real
// validation lives at signup; this only filters obvious garbage
// (missing `@`, embedded whitespace) so an impossible input doesn't
// cost a lookup.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;

export interface AdminUserView {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: string;
  ctxUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toView(row: UserDoc): AdminUserView {
  return {
    id: row.id,
    email: row.email,
    isAdmin: row.isAdmin,
    homeCurrency: row.homeCurrency,
    ctxUserId: row.ctxUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** GET /api/admin/users/:userId */
export async function adminGetUserHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || userId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId is required' }, 400);
  }
  if (!UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }
  try {
    const row = await db.collection('users').findOne({ id: userId });
    if (row === null) {
      return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
    }
    return c.json<AdminUserView>(toView(row));
  } catch (err) {
    log.error({ err, userId }, 'Admin user-detail lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch user' }, 500);
  }
}

/** GET /api/admin/users/by-email?email=… */
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

  try {
    const row = await db.collection('users').findOne({ email: raw.toLowerCase().trim() });
    if (row === null) {
      return c.json({ code: 'NOT_FOUND', message: 'No user with that email' }, 404);
    }
    return c.json<AdminUserView>(toView(row));
  } catch (err) {
    log.error({ err }, 'Admin user-by-email lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to look up user' }, 500);
  }
}
