/**
 * Admin credit-ledger view for a single user (ADR 009 / 011).
 *
 * `GET /api/admin/users/:userId/credit-history` — paginated list of
 * `credit_transactions` rows scoped to one user. Mirrors the caller-
 * scoped `/api/users/me/cashback-history` but includes fields that
 * only make sense on the admin surface:
 *   - `note` (migration 0011) — free-text reason on support-initiated
 *     adjustments, invisible in the user-facing view.
 *   - `referenceId` — already on the user view, but here it's useful
 *     for correlating an adjustment to the admin id that wrote it.
 *
 * Pagination: `?before=<iso>` + `?limit=<n>` (default 20, cap 100).
 * `before` pages by `createdAt`, newest first.
 */
import type { Context } from 'hono';
import { and, desc, eq, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-credit-history' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminCreditLedgerEntry {
  id: string;
  userId: string;
  type: string;
  /** bigint-string — signed amount in `currency` minor units. */
  amountMinor: string;
  currency: string;
  referenceType: string | null;
  referenceId: string | null;
  /** Populated on type='adjustment' rows (migration 0011). */
  note: string | null;
  createdAt: string;
}

export interface AdminCreditHistoryResponse {
  entries: AdminCreditLedgerEntry[];
}

/** GET /api/admin/users/:userId/credit-history */
export async function adminCreditHistoryHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || !UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a UUID' }, 400);
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

  const predicate =
    before === undefined
      ? eq(creditTransactions.userId, userId)
      : and(eq(creditTransactions.userId, userId), lt(creditTransactions.createdAt, before));
  const rows = await db
    .select()
    .from(creditTransactions)
    .where(predicate)
    .orderBy(desc(creditTransactions.createdAt))
    .limit(limit);

  const entries: AdminCreditLedgerEntry[] = rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    type: row.type,
    amountMinor: row.amountMinor.toString(),
    currency: row.currency,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  }));

  log.debug({ userId, count: entries.length }, 'admin credit-history served');
  return c.json<AdminCreditHistoryResponse>({ entries });
}
