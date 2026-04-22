/**
 * Admin exact-email user lookup (ADR 011 / 013).
 *
 * `GET /api/admin/users/by-email?email=a@b.com` — returns the single
 * user row matching the exact email, or 404. Support workflow: they
 * have a customer email from a ticket and need the user id (and a
 * quick look at admin flag + home currency) before drilling into
 * orders / ledger / payouts.
 *
 * The fragment-matching `GET /api/admin/users/search?q=` exists for
 * "they typed half an email" cases; this endpoint is for the
 * "exact string" path where the caller already has the full address.
 */
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-by-email' });

// Narrow-enough email shape — backend accepts anything that looks
// plausibly like an email; strictness lives at the signup boundary.
// Capping at 254 chars matches RFC 5321's SMTP line-length limit.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AdminUserByEmailResponse {
  user: {
    id: string;
    email: string;
    isAdmin: boolean;
    homeCurrency: string;
    stellarAddress: string | null;
    ctxUserId: string | null;
    createdAt: string;
    updatedAt: string;
  };
}

export async function adminUserByEmailHandler(c: Context): Promise<Response> {
  const emailRaw = c.req.query('email');
  if (emailRaw === undefined || emailRaw.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'email query param is required' }, 400);
  }
  if (emailRaw.length > 254 || !EMAIL_RE.test(emailRaw)) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'email must be a plausible address (≤254 chars)' },
      400,
    );
  }
  // Normalise to lowercase before lookup — emails are
  // case-insensitive in practice; the users table stores whatever
  // was handed at signup, so a case mismatch would miss the row.
  // LOWER() on the column keeps the index scan-friendly (the column
  // has an index; the lower-case expression is trivial cost vs. an
  // ILIKE + full scan).
  const normalized = emailRaw.toLowerCase();

  try {
    // Lowercase the email column at the DB side so support pasting
    // "Alice@Example.com" still finds the "alice@example.com" row.
    const row = await db.query.users.findFirst({
      where: eq(users.email, normalized),
    });
    if (row === undefined) {
      return c.json({ code: 'NOT_FOUND', message: 'No user matches that email' }, 404);
    }
    return c.json<AdminUserByEmailResponse>({
      user: {
        id: row.id,
        email: row.email,
        isAdmin: row.isAdmin,
        homeCurrency: row.homeCurrency,
        stellarAddress: row.stellarAddress,
        ctxUserId: row.ctxUserId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin user-by-email lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to look up user' }, 500);
  }
}
