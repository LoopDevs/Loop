/**
 * Admin per-user credit-balance drill-down (ADR 009 / 015).
 *
 * `GET /api/admin/users/:userId/credits` — lists every
 * `user_credits` row for a user. Ops opens this from a support
 * ticket to see exactly what Loop owes that user, per currency,
 * right now.
 *
 * Distinct from the treasury aggregate (`/api/admin/treasury`):
 * that one is "how much does Loop owe everyone, summed"; this one
 * answers "what does Loop owe this specific user?". The admin UI
 * renders the result next to the user's recent credit_transactions
 * so ops can correlate a reported balance with the entries that
 * built it.
 *
 * `bigint`-as-string on the wire, same as every other money field.
 */
import type { Context } from 'hono';
import { UUID_RE } from '../uuid.js';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { userCredits } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-credits' });

export interface AdminUserCreditRow {
  currency: string;
  balanceMinor: string;
  updatedAt: string;
}

export interface AdminUserCreditsResponse {
  userId: string;
  rows: AdminUserCreditRow[];
}

interface DbRow {
  currency: string;
  balanceMinor: bigint;
  updatedAt: Date;
}

export async function adminUserCreditsHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || userId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId is required' }, 400);
  }
  if (!UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }

  try {
    const rows = (await db
      .select({
        currency: userCredits.currency,
        balanceMinor: userCredits.balanceMinor,
        updatedAt: userCredits.updatedAt,
      })
      .from(userCredits)
      .where(eq(userCredits.userId, userId))
      .orderBy(asc(userCredits.currency))) as DbRow[];

    const body: AdminUserCreditsResponse = {
      userId,
      rows: rows.map((r) => ({
        currency: r.currency,
        balanceMinor: r.balanceMinor.toString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
    return c.json(body);
  } catch (err) {
    log.error({ err, userId }, 'Admin user-credits lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch user credits' }, 500);
  }
}
