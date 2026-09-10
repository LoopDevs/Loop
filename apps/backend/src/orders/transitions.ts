// Order mirror transitions — ADR 052
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

// CF-25 / X-PRIV-03: code + PIN are spendable bearer secrets — envelope-encrypted at rest;
// `redeem_url` is the landing page, not the secret, so it stays plaintext.
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

// CTX leaves a never-paid card `unpaid` forever once its payment window lapses, so the mirror sweep flips the local row.
export async function markOrderExpired(orderId: string): Promise<Order | null> {
  return db
    .collection('orders')
    .updateOne(
      { id: orderId, state: 'unpaid' },
      { $set: { state: 'expired', failedAt: new Date(), failureReason: 'payment window expired' } },
    );
}
