/**
 * A2-1905 — Data Subject Rights (DSR) account deletion.
 *
 * `POST /api/users/me/dsr/delete` — deletes the calling user's
 * account. Privacy-policy promise (`/privacy` route, §5 — erasure +
 * the GDPR / CCPA equivalent for non-EU jurisdictions).
 *
 * **What "delete" means here.** Order history must be retained for
 * tax / regulatory reporting, so "delete" is **anonymisation** rather
 * than a hard row removal:
 *
 *   - `users.email` is replaced with a synthetic
 *     `deleted-{userId}@deleted.loopfinance.io` placeholder so the
 *     doc remains consistent with order history but no longer carries
 *     a real PII anchor.
 *   - `users.ctxUserId` is set null.
 *   - `user_identities` docs are deleted (Google/Apple OAuth links).
 *   - All refresh tokens are revoked so any session in flight is
 *     immediately invalidated.
 *
 * **Pre-conditions.** Refuse to anonymise while any order is
 * mid-flight (`unpaid` / `paid`) — the purchase is being fulfilled
 * and CTX attribution still needs the account.
 *
 * **Post-deletion auth.** A subsequent OTP request to the original
 * email creates a fresh user doc (the deleted doc's email is now
 * `deleted-{id}@…`). Old order history is invisible to the new
 * account.
 */
import { db } from '../db/client.js';
import { revokeAllRefreshTokensForUser } from '../auth/refresh-tokens.js';
import { logger } from '../logger.js';

export type DsrDeleteBlockReason = 'in_flight_orders';

export interface DsrDeleteResult {
  /** True when the anonymisation succeeded; the caller's session is dead. */
  ok: boolean;
  /** Set when `ok=false`. The first blocker found wins. */
  blockedBy?: DsrDeleteBlockReason;
}

/**
 * Build the synthetic placeholder email used post-deletion. Pure;
 * exposed so tests can pin the format without redoing the synthesis.
 * The `userId` segment is the doc's UUID so different deletions
 * never collide.
 */
export function deletedEmailFor(userId: string): string {
  return `deleted-${userId}@deleted.loopfinance.io`;
}

/**
 * Anonymises the user identified by `userId`. Refuses (returns
 * `ok: false`) when a fulfilment is in flight.
 */
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
