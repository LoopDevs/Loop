/**
 * Admin refund on a failed order (ADR 009 / 011).
 *
 * `POST /api/admin/orders/:orderId/refund` — Loop is the merchant of
 * record (ADR 010), so when CTX can't procure the gift card after the
 * user has paid, Loop owes the customer their money back. Orders in
 * `state='failed'` are the refund-eligible population; everything else
 * returns 409.
 *
 * The refund is written as `credit_transactions(type='refund')` in
 * the user's home currency at the order's charged minor amount
 * (`orders.charge_minor`). `user_credits.balance_minor` is bumped in
 * the same transaction so the ledger sum and materialised balance
 * always agree.
 *
 * Idempotency: the (referenceType='order', referenceId=orderId,
 * type='refund') tuple is unique per order by construction — the
 * handler checks for an existing row before inserting and returns
 * 409 if one is present. Re-hits after a successful refund are a
 * no-op rather than a double-credit.
 */
import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, orders, userCredits } from '../db/schema.js';
import type { User } from '../db/users.js';
import { notifyOrderRefunded } from '../discord.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-order-refund' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OrderRefundEntry {
  id: string;
  userId: string;
  orderId: string;
  amountMinor: string;
  currency: string;
  createdAt: string;
}

export interface OrderRefundResponse {
  entry: OrderRefundEntry;
  balance: { currency: string; balanceMinor: string };
}

/** POST /api/admin/orders/:orderId/refund */
export async function adminRefundOrderHandler(c: Context): Promise<Response> {
  const orderId = c.req.param('orderId');
  if (orderId === undefined || !UUID_RE.test(orderId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'orderId must be a UUID' }, 400);
  }

  const [order] = await db
    .select({
      id: orders.id,
      userId: orders.userId,
      state: orders.state,
      chargeMinor: orders.chargeMinor,
      chargeCurrency: orders.chargeCurrency,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (order === undefined) {
    return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
  }
  if (order.state !== 'failed') {
    return c.json(
      {
        code: 'ORDER_NOT_REFUNDABLE',
        message: `Only failed orders can be refunded; this one is ${order.state}`,
      },
      409,
    );
  }

  // Idempotency guard. (referenceType='order', referenceId=orderId,
  // type='refund') is unique per order — if a previous refund has
  // already landed, don't write a second one. The DB doesn't enforce
  // this as a constraint because other types (cashback on the same
  // order) legitimately co-exist with the same reference pair.
  const [existing] = await db
    .select({ id: creditTransactions.id })
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.referenceType, 'order'),
        eq(creditTransactions.referenceId, orderId),
        eq(creditTransactions.type, 'refund'),
      ),
    )
    .limit(1);
  if (existing !== undefined) {
    return c.json(
      { code: 'ALREADY_REFUNDED', message: 'This order has already been refunded' },
      409,
    );
  }

  const admin = c.get('user') as User;

  try {
    const { entry, balance } = await db.transaction(async (tx) => {
      // Read current balance for the user's charge currency. Orders in
      // state='failed' ran through payment validation, so we can be
      // confident chargeMinor ≥ 0 and the currency matches the user's
      // home currency today (ADR 015 only supports charge==home for now).
      const [creditsRow] = await tx
        .select({ balanceMinor: userCredits.balanceMinor })
        .from(userCredits)
        .where(
          and(eq(userCredits.userId, order.userId), eq(userCredits.currency, order.chargeCurrency)),
        )
        .limit(1);
      const current = creditsRow?.balanceMinor ?? 0n;
      const nextBalance = current + order.chargeMinor;

      if (creditsRow === undefined) {
        await tx.insert(userCredits).values({
          userId: order.userId,
          currency: order.chargeCurrency,
          balanceMinor: nextBalance,
        });
      } else {
        await tx
          .update(userCredits)
          .set({ balanceMinor: nextBalance, updatedAt: new Date() })
          .where(
            and(
              eq(userCredits.userId, order.userId),
              eq(userCredits.currency, order.chargeCurrency),
            ),
          );
      }

      const [insertedEntry] = await tx
        .insert(creditTransactions)
        .values({
          userId: order.userId,
          type: 'refund',
          amountMinor: order.chargeMinor,
          currency: order.chargeCurrency,
          referenceType: 'order',
          referenceId: orderId,
        })
        .returning();

      if (insertedEntry === undefined) {
        throw new Error('credit_transactions insert returned no row');
      }

      return {
        entry: insertedEntry,
        balance: { currency: order.chargeCurrency, balanceMinor: nextBalance },
      };
    });

    log.info(
      {
        orderId,
        userId: order.userId,
        adminId: admin.id,
        currency: order.chargeCurrency,
        amountMinor: order.chargeMinor.toString(),
      },
      'Admin refunded failed order',
    );

    const entryView: OrderRefundEntry = {
      id: entry.id,
      userId: entry.userId,
      orderId,
      amountMinor: entry.amountMinor.toString(),
      currency: entry.currency,
      createdAt: entry.createdAt.toISOString(),
    };

    // Fire the orders-channel webhook AFTER the txn commits so a
    // flaky Discord hop can't stretch the DB lock. sendWebhook is
    // fire-and-forget — a failure inside it logs a warn but never
    // rolls back the already-committed refund.
    notifyOrderRefunded({
      orderId,
      targetUserId: order.userId,
      adminId: admin.id,
      amountMinor: entryView.amountMinor,
      currency: entryView.currency,
    });

    return c.json<OrderRefundResponse>(
      {
        entry: entryView,
        balance: { currency: balance.currency, balanceMinor: balance.balanceMinor.toString() },
      },
      201,
    );
  } catch (err) {
    log.error({ err, orderId }, 'Admin refund transaction failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to write refund' }, 500);
  }
}
