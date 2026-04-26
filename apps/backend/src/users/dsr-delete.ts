/**
 * A2-1905 — Data Subject Rights (DSR) account deletion.
 *
 * `POST /api/users/me/dsr/delete` — deletes the calling user's
 * account. Privacy-policy promise (`/privacy` route, §5 — erasure +
 * the GDPR / CCPA equivalent for non-EU jurisdictions).
 *
 * **What "delete" means here.** ADR-009 makes the credit ledger
 * append-only; tax / regulatory rules (UK FCA + IRS) require we
 * retain the underlying transaction record. So "delete" is
 * **anonymisation** rather than a hard row removal:
 *
 *   - `users.email` is replaced with a synthetic
 *     `deleted-{userId}@deleted.loopfinance.io` placeholder so the
 *     row remains FK-consistent with the ledger but no longer carries
 *     a real PII anchor.
 *   - `users.stellar_address` is set NULL.
 *   - `users.ctx_user_id` is set NULL.
 *   - `user_identities` rows are deleted (Google/Apple OAuth links).
 *   - All refresh tokens are revoked so any session in flight is
 *     immediately invalidated.
 *
 * Ledger rows (`credit_transactions` / `orders` / `pending_payouts`)
 * are RETAINED because the FK is `onDelete: 'restrict'` — we'd
 * violate the append-only invariant by deleting them, and we need
 * them for tax reporting per A2-1923. They no longer link to a real
 * person after the email scrub.
 *
 * **Pre-conditions.** Refuse to anonymise when:
 *   - any `pending_payouts` row is in `pending` or `submitted` state
 *     — money is in flight; user must wait or contact support
 *   - any `orders` row is in `pending_payment` / `paid` / `procuring`
 *     — purchase is mid-fulfilment; same reason
 *
 * **Post-deletion auth.** A subsequent OTP request to the original
 * email creates a fresh user row (the deleted row's email is now
 * `deleted-{id}@…` so the partial unique index doesn't collide).
 * Old order history is invisible to the new account — the ledger
 * link survives but the new user has no read access to the
 * anonymised row.
 *
 * **A note on the synthetic email.** `loopfinance.io` is operator-
 * controlled — `deleted-{uuid}@deleted.loopfinance.io` is
 * unrouteable but well-formed (passes the email regex), so any
 * code path that does `select(u where email=?)` keeps working
 * without special-casing the deletion sentinel.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders, pendingPayouts, userIdentities, users } from '../db/schema.js';
import type { PAYOUT_STATES, ORDER_STATES } from '../db/schema.js';
import { revokeAllRefreshTokensForUser } from '../auth/refresh-tokens.js';

/**
 * Pre-condition check: which user states would block deletion. The
 * caller surfaces these as 409 with the specific reason so the
 * client can render targeted UX ("your withdrawal is pending — try
 * again once it settles").
 */
export type DsrDeleteBlockReason = 'pending_payouts' | 'in_flight_orders';

export interface DsrDeleteResult {
  /** True when the anonymisation succeeded; the caller's session is dead. */
  ok: boolean;
  /** Set when `ok=false`. The first blocker found wins. */
  blockedBy?: DsrDeleteBlockReason;
}

/**
 * Build the synthetic placeholder email used post-deletion. Pure;
 * exposed so tests can pin the format without redoing the synthesis.
 * The `userId` segment is the row's UUID so different deletions
 * never collide on the partial unique index.
 */
export function deletedEmailFor(userId: string): string {
  return `deleted-${userId}@deleted.loopfinance.io`;
}

/**
 * Anonymises the user identified by `userId`. Refuses (returns
 * `ok: false`) when there's money or a fulfilment in flight.
 *
 * The whole anonymisation runs inside a single Postgres transaction
 * so a partial failure doesn't leave a half-deleted row.
 */
export async function deleteUserViaAnonymisation(userId: string): Promise<DsrDeleteResult> {
  // Block: any pending or submitted payout means money in flight.
  // We can't guarantee the right end-state for that money post-
  // anonymisation (e.g. an `op_no_trust` failure that needs the
  // user's Stellar address — which we just nulled).
  const blockingPayouts = await db
    .select({ id: pendingPayouts.id })
    .from(pendingPayouts)
    .where(
      and(
        eq(pendingPayouts.userId, userId),
        inArray(pendingPayouts.state, [
          'pending',
          'submitted',
        ] satisfies (typeof PAYOUT_STATES)[number][]),
      ),
    )
    .limit(1);
  if (blockingPayouts.length > 0) {
    return { ok: false, blockedBy: 'pending_payouts' };
  }

  // Block: orders mid-fulfilment. ADR 010 transitions are
  // pending_payment → paid → procuring → fulfilled / failed.
  // Anonymising during procurement could drop the email the CTX
  // proxy flow relies on for order-attribution.
  const blockingOrders = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.userId, userId),
        inArray(orders.state, [
          'pending_payment',
          'paid',
          'procuring',
        ] satisfies (typeof ORDER_STATES)[number][]),
      ),
    )
    .limit(1);
  if (blockingOrders.length > 0) {
    return { ok: false, blockedBy: 'in_flight_orders' };
  }

  await db.transaction(async (tx) => {
    // OAuth identity links — deleting these means a re-auth via
    // Google/Apple under the same provider_sub spawns a fresh user
    // row instead of resolving to the anonymised one.
    await tx.delete(userIdentities).where(eq(userIdentities.userId, userId));

    // Email gets the synthetic placeholder. ctx_user_id and
    // stellar_address null out — both are PII anchors.
    await tx
      .update(users)
      .set({
        email: deletedEmailFor(userId),
        ctxUserId: null,
        stellarAddress: null,
      })
      .where(eq(users.id, userId));
  });

  // Sessions: revoke after the txn so a partial failure doesn't
  // leave the user logged-out without their data anonymised. The
  // refresh-token revoke is idempotent.
  await revokeAllRefreshTokensForUser(userId);

  return { ok: true };
}
