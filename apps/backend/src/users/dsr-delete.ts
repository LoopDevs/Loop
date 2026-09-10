// A2-1905 — DSR account deletion via anonymisation
import { db } from '../db/client.js';
import { revokeAllRefreshTokensForUser } from '../auth/refresh-tokens.js';
import { logger } from '../logger.js';

export type DsrDeleteBlockReason = 'in_flight_orders';

export interface DsrDeleteResult {
  ok: boolean;
  blockedBy?: DsrDeleteBlockReason;
}

export function deletedEmailFor(userId: string): string {
  return `deleted-${userId}@deleted.loopfinance.io`;
}

export async function deleteUserViaAnonymisation(userId: string): Promise<DsrDeleteResult> {
  // Block: orders mid-fulfilment (ADR 052 states: unpaid → paid →
  // fulfilled). Anonymising during fulfilment could drop the CTX
  // attribution the order path relies on.
  const blockingOrder = await db
    .collection('orders')
    .findOne({ userId, state: { $in: ['unpaid', 'paid'] } });
  if (blockingOrder !== null) {
    return { ok: false, blockedBy: 'in_flight_orders' };
  }

  // OAuth identity links — deleting these means a re-auth via
  // Google/Apple under the same provider_sub spawns a fresh user
  // doc instead of resolving to the anonymised one.
  await db.collection('user_identities').deleteMany({ userId });

  // Email gets the synthetic placeholder; ctxUserId nulls out — both
  // are PII anchors.
  await db.collection('users').updateOne(
    { id: userId },
    {
      $set: {
        email: deletedEmailFor(userId),
        ctxUserId: null,
        updatedAt: new Date(),
      },
    },
  );

  // Sessions: revoke after the writes so a partial failure doesn't
  // leave the user logged-out without their data anonymised. The
  // refresh-token revoke is idempotent.
  //
  // A4-086: surface a revoke failure loudly. The anonymisation
  // already landed, so we cannot roll back; but a stale refresh
  // token against an anonymised doc is a privacy regression we want
  // operators to know about and remediate (running
  // revokeAllRefreshTokensForUser manually).
  try {
    await revokeAllRefreshTokensForUser(userId);
  } catch (err) {
    logger.error(
      { err, userId },
      'A4-086: DSR anonymisation succeeded but refresh-token revoke failed — rerun revokeAllRefreshTokensForUser manually',
    );
    throw err;
  }

  return { ok: true };
}
