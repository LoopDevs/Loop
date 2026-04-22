/**
 * Admin per-user credit-transaction log (ADR 009).
 *
 * `GET /api/admin/users/:userId/credit-transactions` — paginated
 * list of `credit_transactions` rows for the given user, newest
 * first. The balance drill-down at
 * `/api/admin/users/:userId/credits` tells ops *what* is owed;
 * this endpoint tells them *how the balance got there* (cashback
 * accruals, withdrawals, refunds, adjustments).
 *
 * Cursor pagination: `?before=<iso-8601>` returns rows strictly
 * older than that `createdAt`. Limit clamps 1..100, default 20.
 * Optional `?type=` filters to a single movement kind.
 *
 * `amountMinor` is bigint-as-string on the wire (signed — negative
 * for spend/withdrawal, positive for cashback/interest/refund).
 */
import type { Context } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-credit-transactions' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors the CHECK constraint on credit_transactions.type. Kept
// local because the shared @loop/shared enum extraction hasn't
// landed on main yet (#456 on branch); this handler doesn't need
// to drift from that on merge.
const CREDIT_TRANSACTION_TYPES = [
  'cashback',
  'interest',
  'spend',
  'withdrawal',
  'refund',
  'adjustment',
] as const;

export interface AdminCreditTransactionView {
  id: string;
  type: string;
  amountMinor: string;
  currency: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}

interface DbRow {
  id: string;
  type: string;
  amountMinor: bigint;
  currency: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
}

export async function adminUserCreditTransactionsHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || userId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId is required' }, 400);
  }
  if (!UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }

  const typeParam = c.req.query('type');
  if (
    typeParam !== undefined &&
    !(CREDIT_TRANSACTION_TYPES as ReadonlyArray<string>).includes(typeParam)
  ) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: `type must be one of: ${CREDIT_TRANSACTION_TYPES.join(', ')}`,
      },
      400,
    );
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
    const conditions = [eq(creditTransactions.userId, userId)];
    if (typeParam !== undefined) conditions.push(eq(creditTransactions.type, typeParam));
    if (before !== undefined) {
      conditions.push(sql`${creditTransactions.createdAt} < ${before}`);
    }

    const rows = (await db
      .select()
      .from(creditTransactions)
      .where(and(...conditions))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(limit)) as DbRow[];

    const transactions: AdminCreditTransactionView[] = rows.map((r) => ({
      id: r.id,
      type: r.type,
      amountMinor: r.amountMinor.toString(),
      currency: r.currency,
      referenceType: r.referenceType,
      referenceId: r.referenceId,
      createdAt: r.createdAt.toISOString(),
    }));

    return c.json({ transactions });
  } catch (err) {
    log.error({ err, userId }, 'Admin user credit-transactions lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch credit transactions' }, 500);
  }
}
