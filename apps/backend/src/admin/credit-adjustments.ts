/**
 * Admin credit-adjustment endpoint (ADR 009 / 011).
 *
 * `POST /api/admin/users/:userId/credit-adjustments` — support
 * action that writes a signed `type='adjustment'` row to
 * `credit_transactions` and atomically bumps the matching
 * `user_credits.balance_minor`. The audit trail lives on the ledger
 * itself: every adjustment row records the admin who made it
 * (`reference_type='admin_adjustment'`, `reference_id=<admin.id>`)
 * and a free-text `note` explaining *why* (migration 0011).
 *
 * Amount semantics:
 *   - positive → credit the user (goodwill / reissue)
 *   - negative → debit the user (refund clawback / correction)
 *   - zero → 400 (no-op adjustments add noise to the ledger)
 *
 * Sign is enforced by the DB's `credit_transactions_amount_sign`
 * check constraint, which allows *any* nonzero sign for type
 * 'adjustment'. A negative adjustment that would push the balance
 * below zero is caught by the `user_credits_non_negative` check and
 * surfaced as 409 rather than letting the raw Postgres error bubble.
 *
 * Auth: `requireAuth` + `requireAdmin` on `/api/admin/*` already
 * gate the route — the handler just needs the admin's User record
 * off `c.get('user')` for the reference.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, userCredits, creditTransactions, HOME_CURRENCIES } from '../db/schema.js';
import { notifyAdminCreditAdjustment } from '../discord.js';
import type { User } from '../db/users.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-credit-adjustments' });

/** Same UUID regex used across the admin surface. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses a signed bigint-string. Returns `null` for anything that
 * isn't a well-formed integer (float, empty, hex, NaN). Callers
 * enforce the non-zero rule separately — a zero-value adjustment is
 * a product error (noise), not a parse error.
 */
function parseSignedBigint(s: string): bigint | null {
  if (!/^-?\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

const AdjustmentBody = z.object({
  amountMinor: z.string().min(1).max(32),
  currency: z.enum(HOME_CURRENCIES),
  note: z.string().trim().min(3).max(500),
});

export interface CreditAdjustmentEntry {
  id: string;
  userId: string;
  type: 'adjustment';
  amountMinor: string;
  currency: string;
  referenceType: string | null;
  referenceId: string | null;
  note: string | null;
  createdAt: string;
}

export interface UserCreditsRow {
  currency: string;
  balanceMinor: string;
}

/** POST /api/admin/users/:userId/credit-adjustments */
export async function adminCreditAdjustmentHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || !UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a UUID' }, 400);
  }

  const rawBody = await c.req.json().catch(() => null);
  const parsed = AdjustmentBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }

  const delta = parseSignedBigint(parsed.data.amountMinor);
  if (delta === null) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'amountMinor must be a signed integer string' },
      400,
    );
  }
  if (delta === 0n) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'amountMinor must be non-zero' }, 400);
  }

  // Target user must exist. We also fetch their home currency so the
  // handler can compare the adjustment currency against it and reject
  // cross-currency writes — user_credits is keyed by (userId, currency),
  // but mixing USD credits into a GBP-home user wouldn't match the
  // Account view and creates a reconciliation gap.
  const [target] = await db
    .select({ id: users.id, homeCurrency: users.homeCurrency })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (target === undefined) {
    return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
  }
  if (target.homeCurrency !== parsed.data.currency) {
    return c.json(
      {
        code: 'CURRENCY_MISMATCH',
        message: `User's home currency is ${target.homeCurrency}; adjustment must match`,
      },
      400,
    );
  }

  const admin = c.get('user') as User;

  try {
    const { entry, balance } = await db.transaction(async (tx) => {
      const [creditsRow] = await tx
        .select({ balanceMinor: userCredits.balanceMinor })
        .from(userCredits)
        .where(and(eq(userCredits.userId, userId), eq(userCredits.currency, parsed.data.currency)))
        .limit(1);
      const current = creditsRow?.balanceMinor ?? 0n;
      const nextBalance = current + delta;
      if (nextBalance < 0n) {
        throw new InsufficientBalanceError();
      }

      // Upsert the user_credits row. First-time adjustment on a user
      // who has never earned cashback takes the INSERT branch; repeat
      // adjustments go through the UPDATE. Both paths leave the CHECK
      // constraint to backstop a negative balance, though our
      // pre-check already rejected that above.
      if (creditsRow === undefined) {
        await tx.insert(userCredits).values({
          userId,
          currency: parsed.data.currency,
          balanceMinor: nextBalance,
        });
      } else {
        await tx
          .update(userCredits)
          .set({ balanceMinor: nextBalance, updatedAt: new Date() })
          .where(
            and(eq(userCredits.userId, userId), eq(userCredits.currency, parsed.data.currency)),
          );
      }

      const [insertedEntry] = await tx
        .insert(creditTransactions)
        .values({
          userId,
          type: 'adjustment',
          amountMinor: delta,
          currency: parsed.data.currency,
          referenceType: 'admin_adjustment',
          referenceId: admin.id,
          note: parsed.data.note,
        })
        .returning();

      if (insertedEntry === undefined) {
        throw new Error('credit_transactions insert returned no row');
      }

      return {
        entry: insertedEntry,
        balance: { currency: parsed.data.currency, balanceMinor: nextBalance },
      };
    });

    log.info(
      {
        targetUserId: userId,
        adminId: admin.id,
        currency: parsed.data.currency,
        amountMinor: parsed.data.amountMinor,
      },
      'Admin credit-adjustment written',
    );

    const entryView: CreditAdjustmentEntry = {
      id: entry.id,
      userId: entry.userId,
      type: 'adjustment',
      amountMinor: entry.amountMinor.toString(),
      currency: entry.currency,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      note: entry.note,
      createdAt: entry.createdAt.toISOString(),
    };
    const balanceView: UserCreditsRow = {
      currency: balance.currency,
      balanceMinor: balance.balanceMinor.toString(),
    };

    // Fire the audit webhook after the txn commits so a flaky
    // Discord / network hop doesn't stretch the DB lock. sendWebhook
    // is itself fire-and-forget — a failure inside it logs a warn
    // but never throws back into the response path.
    notifyAdminCreditAdjustment({
      targetUserId: userId,
      adminId: admin.id,
      currency: parsed.data.currency,
      amountMinor: entryView.amountMinor,
      newBalanceMinor: balanceView.balanceMinor,
      note: parsed.data.note,
    });

    return c.json({ entry: entryView, balance: balanceView }, 201);
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      return c.json(
        {
          code: 'INSUFFICIENT_BALANCE',
          message: 'Adjustment would push the balance below zero',
        },
        409,
      );
    }
    log.error({ err, userId }, 'Admin credit-adjustment transaction failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to write adjustment' }, 500);
  }
}

class InsufficientBalanceError extends Error {
  constructor() {
    super('insufficient balance');
    this.name = 'InsufficientBalanceError';
  }
}
