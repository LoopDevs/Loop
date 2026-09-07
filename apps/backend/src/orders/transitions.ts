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
import { db } from '../db/client.js';
import type { Order } from './repo.js';
import { encryptRedeemField } from './redeem-crypto.js';

export interface RedemptionPayload {
  code: string | null;
  pin: string | null;
  url: string | null;
}

export async function markOrderPaid(orderId: string): Promise<Order | null> {
  return db
    .collection('orders')
    .updateOne({ id: orderId, state: 'unpaid' }, { $set: { state: 'paid' } });
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
  return db.collection('orders').updateOne(
    { id: orderId, state: { $in: ['unpaid', 'paid'] } },
    {
      $set: {
        state: 'fulfilled',
        fulfilledAt: new Date(),
        redeemCode: encryptRedeemField(opts.redemption?.code),
        redeemPin: encryptRedeemField(opts.redemption?.pin),
        redeemUrl: opts.redemption?.url ?? null,
      },
    },
  );
}

export async function markOrderRejected(
  orderId: string,
  reason: string | null,
): Promise<Order | null> {
  return db.collection('orders').updateOne(
    { id: orderId, state: { $in: ['unpaid', 'paid'] } },
    {
      $set: {
        state: 'rejected',
        failedAt: new Date(),
        ...(reason !== null ? { failureReason: reason } : {}),
      },
    },
  );
}

export async function markOrderRefunded(orderId: string): Promise<Order | null> {
  return db
    .collection('orders')
    .updateOne(
      { id: orderId, state: { $in: ['unpaid', 'paid', 'fulfilled'] } },
      { $set: { state: 'refunded', failedAt: new Date() } },
    );
}

/**
 * Loop-local expiry: CTX leaves a never-paid card `unpaid` forever
 * once its payment window lapses, so the mirror sweep flips the
 * local row. Guarded to `unpaid` only — a paid event always wins.
 */
export async function markOrderExpired(orderId: string): Promise<Order | null> {
  return db
    .collection('orders')
    .updateOne(
      { id: orderId, state: 'unpaid' },
      { $set: { state: 'expired', failedAt: new Date(), failureReason: 'payment window expired' } },
    );
}
