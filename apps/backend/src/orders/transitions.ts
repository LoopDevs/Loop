/**
 * Order mirror transitions (ADR 052).
 *
 * ctx owns the order lifecycle; these writers apply CTX's
 * `displayStatus` onto the local mirror row with state guards so a
 * late or replayed event can never regress the mirror:
 *
 *   unpaid → paid → fulfilled
 *      └──▶ rejected | expired          (from unpaid/paid)
 *   refunded                            (from any non-expired state —
 *                                        CTX can refund a paid or even
 *                                        fulfilled card)
 *
 * Every writer is a guarded single-row UPDATE (`WHERE state IN ...`),
 * so concurrent delivery (ws event vs mirror sweep) resolves to
 * exactly one effective transition. Returns the updated row or null
 * when the guard didn't match (already there / already terminal).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import type { Order } from './repo.js';
import { encryptRedeemField } from './redeem-crypto.js';

export interface RedemptionPayload {
  code: string | null;
  pin: string | null;
  url: string | null;
}

export async function markOrderPaid(orderId: string): Promise<Order | null> {
  const rows = await db
    .update(orders)
    .set({ state: 'paid' })
    .where(and(eq(orders.id, orderId), eq(orders.state, 'unpaid')))
    .returning();
  return rows[0] ?? null;
}

/**
 * `unpaid|paid → fulfilled` — a card can jump straight from unpaid
 * when Loop missed the paid event. CF-25 / X-PRIV-03: code + PIN are
 * spendable bearer secrets — envelope-encrypted at rest;
 * `redeem_url` is the landing page, not the secret, so it stays
 * plaintext. Redemption fields may be absent (CTX SSE races the
 * provider); the redemption backfill re-fetches them.
 */
export async function markOrderFulfilled(
  orderId: string,
  opts: { redemption?: RedemptionPayload },
): Promise<Order | null> {
  const rows = await db
    .update(orders)
    .set({
      state: 'fulfilled',
      fulfilledAt: new Date(),
      redeemCode: encryptRedeemField(opts.redemption?.code),
      redeemPin: encryptRedeemField(opts.redemption?.pin),
      redeemUrl: opts.redemption?.url ?? null,
    })
    .where(and(eq(orders.id, orderId), inArray(orders.state, ['unpaid', 'paid'])))
    .returning();
  return rows[0] ?? null;
}

export async function markOrderRejected(
  orderId: string,
  reason: string | null,
): Promise<Order | null> {
  const rows = await db
    .update(orders)
    .set({
      state: 'rejected',
      failedAt: new Date(),
      ...(reason !== null ? { failureReason: reason } : {}),
    })
    .where(and(eq(orders.id, orderId), inArray(orders.state, ['unpaid', 'paid'])))
    .returning();
  return rows[0] ?? null;
}

export async function markOrderRefunded(orderId: string): Promise<Order | null> {
  const rows = await db
    .update(orders)
    .set({ state: 'refunded', failedAt: new Date() })
    .where(and(eq(orders.id, orderId), inArray(orders.state, ['unpaid', 'paid', 'fulfilled'])))
    .returning();
  return rows[0] ?? null;
}

/**
 * Loop-local expiry: CTX leaves a never-paid card `unpaid` forever
 * once its payment window lapses, so the mirror sweep flips the
 * local row. Guarded to `unpaid` only — a paid event always wins.
 */
export async function markOrderExpired(orderId: string): Promise<Order | null> {
  const rows = await db
    .update(orders)
    .set({ state: 'expired', failedAt: new Date(), failureReason: 'payment window expired' })
    .where(and(eq(orders.id, orderId), eq(orders.state, 'unpaid')))
    .returning();
  return rows[0] ?? null;
}
