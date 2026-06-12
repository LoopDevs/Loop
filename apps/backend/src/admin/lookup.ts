/**
 * Reverse lookup (ADR 037 §4.1) — the user-360 entry point.
 *
 * `GET /api/admin/lookup?q=<order id | payment memo | stellar address>`
 *
 * Support pastes whatever artifact the customer can quote and gets
 * the owning user back. The three shapes are syntactically
 * disjoint, so classification is by shape, then ONE index-backed
 * query per shape (never a scan):
 *
 *   - uuid                 → orders PK
 *   - 20-char base32       → orders.payment_memo
 *                            (partial index `orders_payment_memo`,
 *                            migration 0039; memo format from
 *                            generatePaymentMemo)
 *   - G + 55-char base32   → users.wallet_address (partial unique,
 *                            migration 0037), falling back to the
 *                            legacy users.stellar_address (partial
 *                            index, migration 0039)
 *
 * Anything else is a 400; a well-formed query with no match is the
 * uniform admin 404 (NOT_FOUND).
 */
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import type { AdminLookupResponse } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import { db } from '../db/client.js';
import { orders, users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-lookup' });

/** generatePaymentMemo: 20 chars from the RFC-4648 base32 alphabet. */
const PAYMENT_MEMO_RE = /^[A-Z2-7]{20}$/;
/** Stellar ed25519 public key (account id) — G + 55 base32 chars. */
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

export async function adminLookupHandler(c: Context): Promise<Response> {
  const q = c.req.query('q')?.trim();
  if (q === undefined || q.length === 0 || q.length > 64) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'q is required (max 64 chars)' }, 400);
  }

  try {
    if (UUID_RE.test(q)) {
      const [order] = await db
        .select({ id: orders.id, userId: orders.userId })
        .from(orders)
        .where(eq(orders.id, q));
      if (order === undefined) {
        return c.json({ code: 'NOT_FOUND', message: 'No order with that id' }, 404);
      }
      return c.json<AdminLookupResponse>({
        kind: 'order',
        userId: order.userId,
        orderId: order.id,
      });
    }

    if (PAYMENT_MEMO_RE.test(q)) {
      const [order] = await db
        .select({ id: orders.id, userId: orders.userId })
        .from(orders)
        .where(eq(orders.paymentMemo, q));
      if (order === undefined) {
        return c.json({ code: 'NOT_FOUND', message: 'No order with that payment memo' }, 404);
      }
      return c.json<AdminLookupResponse>({
        kind: 'payment_memo',
        userId: order.userId,
        orderId: order.id,
      });
    }

    if (STELLAR_ADDRESS_RE.test(q)) {
      const [byWallet] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.walletAddress, q));
      if (byWallet !== undefined) {
        return c.json<AdminLookupResponse>({ kind: 'stellar_address', userId: byWallet.id });
      }
      const [byLegacy] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.stellarAddress, q))
        .limit(1);
      if (byLegacy !== undefined) {
        return c.json<AdminLookupResponse>({ kind: 'stellar_address', userId: byLegacy.id });
      }
      return c.json({ code: 'NOT_FOUND', message: 'No user with that Stellar address' }, 404);
    }

    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: 'q must be an order id (uuid), a payment memo, or a Stellar address',
      },
      400,
    );
  } catch (err) {
    log.error({ err }, 'Admin lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Lookup failed' }, 500);
  }
}
