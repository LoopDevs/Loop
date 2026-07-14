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
import { createHash } from 'node:crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  creditTransactions,
  orders,
  pendingPayouts,
  userCredits,
  userIdentities,
  users,
} from '../db/schema.js';
import type { PAYOUT_STATES, ORDER_STATES } from '../db/schema.js';
import { revokeAllRefreshTokensForUser } from '../auth/refresh-tokens.js';
import { logger } from '../logger.js';

/**
 * Pre-condition check: which user states would block deletion. The
 * caller surfaces these as 409 with the specific reason so the
 * client can render targeted UX ("your withdrawal is pending — try
 * again once it settles").
 */
/**
 * A4-078: extended block reasons.
 *
 *   - `pending_payouts`: a pending or submitted payout — money in
 *     flight on chain.
 *   - `in_flight_orders`: an order in pending_payment / paid /
 *     procuring — purchase being fulfilled.
 *   - `failed_uncompensated_withdrawals`: a LEGACY pre-ADR-036
 *     withdrawal payout (now `kind='emission'` with the at-send
 *     `type='withdrawal'` debit row, per migration 0038) in
 *     state='failed' with `compensated_at IS NULL`. The user owes
 *     themselves money; admin compensation needs to fire OR a
 *     manual recovery path. Anonymising in this window orphans
 *     the user_credits balance — admin compensation re-credits a
 *     row whose email is now `deleted-{uuid}@…`, the user's new
 *     account (re-signup with the original email) gets a fresh
 *     user_id and never sees the recovered balance. Post-ADR-036
 *     emissions never debit, so a failed one does NOT block —
 *     there is no compensation to wait for (and blocking on it
 *     would deadlock deletion, since compensation refuses
 *     debit-less rows).
 *   - `non_zero_credit_balance` (PLAT-30-03, 2026-06-30 cold audit): a
 *     `user_credits` row with `balanceMinor !== 0n`. Cashback is
 *     credited on every fulfilled order regardless of whether the
 *     user ever linked a Stellar wallet (`orders/fulfillment.ts`) — a
 *     `pending_payouts` row only exists when a wallet address was on
 *     file at fulfillment time. A user who never links a wallet can
 *     accumulate an arbitrary cashback balance with zero
 *     `pending_payouts` rows ever created, trivially satisfying the
 *     other three preconditions regardless of balance size. Without
 *     this check, anonymisation permanently orphans that balance:
 *     there's no self-serve withdrawal path (admin-only,
 *     `credits/withdrawals.ts`), yet `liabilities.ts`'s
 *     `sumOutstandingLiability` keeps counting it as outstanding
 *     company liability forever. Mirrors
 *     `home-currency-change.ts`'s identical live-balance guard.
 */
export type DsrDeleteBlockReason =
  | 'pending_payouts'
  | 'in_flight_orders'
  | 'failed_uncompensated_withdrawals'
  | 'non_zero_credit_balance';

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
 * A4-123: synthetic well-formed Stellar pubkey used to scrub
 * `pending_payouts.to_address` on terminal rows during DSR
 * anonymisation. Matches the `pending_payouts_to_address_format`
 * CHECK regex (`^G[A-Z2-7]{55}$`) but does not correspond to a
 * derivable account. Exposed so tests can assert the exact value.
 */
export const SCRUBBED_TO_ADDRESS = `G${'A'.repeat(55)}`;

/**
 * CON-02: per-user advisory-lock key that serialises the DSR
 * precondition re-check + anonymisation for a given user. sha256(
 * namespaced userId) → signed int64 — the same derivation
 * `orders/redeem.ts` (`redeemFenceLockKey`) and `admin/idempotency.ts`
 * (`idempotencyLockKey`) use. Namespaced with `loop:dsr-delete:` so it
 * can't collide with another subsystem's per-user lock.
 */
function dsrDeleteLockKey(userId: string): bigint {
  const digest = createHash('sha256').update(`loop:dsr-delete:${userId}`).digest();
  const raw =
    (BigInt(digest[0]!) << 56n) |
    (BigInt(digest[1]!) << 48n) |
    (BigInt(digest[2]!) << 40n) |
    (BigInt(digest[3]!) << 32n) |
    (BigInt(digest[4]!) << 24n) |
    (BigInt(digest[5]!) << 16n) |
    (BigInt(digest[6]!) << 8n) |
    BigInt(digest[7]!);
  return BigInt.asIntN(64, raw);
}

/**
 * Anonymises the user identified by `userId`. Refuses (returns
 * `ok: false`) when there's money or a fulfilment in flight.
 *
 * The whole anonymisation runs inside a single Postgres transaction
 * so a partial failure doesn't leave a half-deleted row.
 */
export async function deleteUserViaAnonymisation(userId: string): Promise<DsrDeleteResult> {
  // CON-02 (TOCTOU): the block preconditions and the anonymisation
  // writes MUST be one atomic critical section. Previously the four
  // preconditions were read on the pooled `db` handle OUTSIDE the write
  // transaction, so state could change in the window between "checked
  // clear" and "anonymised" — e.g. an order fulfilment enqueues a fresh
  // `pending_payouts` row (or credits a balance) right after the check
  // passes, and the delete then nulls `stellar_address` out from under
  // an in-flight payout / orphans a live balance. Re-checking every
  // precondition INSIDE the write transaction, under a per-user
  // transaction-scoped advisory lock, collapses that window: the checks
  // and the writes now commit atomically, and concurrent DSR deletes
  // for the same user serialise on the lock instead of both proceeding.
  const txnResult = await db.transaction<DsrDeleteResult>(async (tx) => {
    // Per-user lock — auto-released at COMMIT/ROLLBACK. Concurrent DSR
    // deletes for this user queue here; the second one, once it
    // acquires, re-reads the (now-anonymised) state and no-ops.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${dsrDeleteLockKey(userId)})`);

    // Block: any pending or submitted payout means money in flight.
    // We can't guarantee the right end-state for that money post-
    // anonymisation (e.g. an `op_no_trust` failure that needs the
    // user's Stellar address — which we just nulled).
    const blockingPayouts = await tx
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

    // A4-078 (narrowed by ADR 036): a failed LEGACY withdrawal-era
    // payout with compensated_at IS NULL means the at-send
    // user_credits debit landed but the on-chain payout never did,
    // and no admin compensation has re-credited the balance yet. The
    // user owes themselves money. Anonymising in this window severs
    // the recovery path: admin compensation re-credits the
    // (now-anonymised) user_id; if the user re-signs up with the same
    // email they get a fresh user_id and can't see the recovered
    // balance. Block until either the compensation lands
    // (compensated_at != NULL) or ops decides to write the balance
    // off via a separate admin path.
    //
    // The legacy discriminator is the at-send debit ledger row
    // (`type='withdrawal'` referencing the payout) — post-ADR-036
    // emissions never debit, are not compensable, and must not block
    // deletion.
    const failedUncompensated = await tx
      .select({ id: pendingPayouts.id })
      .from(pendingPayouts)
      .where(
        and(
          eq(pendingPayouts.userId, userId),
          eq(pendingPayouts.state, 'failed' as (typeof PAYOUT_STATES)[number]),
          eq(pendingPayouts.kind, 'emission'),
          sql`${pendingPayouts.compensatedAt} IS NULL`,
          sql`EXISTS (
            SELECT 1 FROM ${creditTransactions}
            WHERE ${creditTransactions.type} = 'withdrawal'
              AND ${creditTransactions.referenceType} = 'payout'
              AND ${creditTransactions.referenceId} = ${pendingPayouts.id}::text
          )`,
        ),
      )
      .limit(1);
    if (failedUncompensated.length > 0) {
      return { ok: false, blockedBy: 'failed_uncompensated_withdrawals' };
    }

    // Block: orders mid-fulfilment. ADR 010 transitions are
    // pending_payment → paid → procuring → fulfilled / failed.
    // Anonymising during procurement could drop the email the CTX
    // proxy flow relies on for order-attribution.
    const blockingOrders = await tx
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

    // PLAT-30-03: block on any non-zero user_credits balance, in any
    // currency (a user can hold rows in more than one currency after a
    // home-currency change) — see DsrDeleteBlockReason's docs for why
    // the three preconditions above don't catch a never-linked-wallet
    // user's cashback.
    const nonZeroBalances = await tx
      .select({ currency: userCredits.currency })
      .from(userCredits)
      .where(and(eq(userCredits.userId, userId), ne(userCredits.balanceMinor, 0n)))
      .limit(1);
    if (nonZeroBalances.length > 0) {
      return { ok: false, blockedBy: 'non_zero_credit_balance' };
    }

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

    // A4-123: terminal payout rows (state IN ('confirmed', 'failed'))
    // retain `to_address` — the user's Stellar destination — by
    // default. The privacy policy promises identifier removal where
    // retention isn't legally required; an on-chain wallet address is
    // identifying and linkable, and we keep `tx_hash` + the totals
    // for accounting reconciliation, so scrubbing the address alone
    // preserves the ledger trail without continuing to advertise the
    // user's wallet.
    //
    // The schema's `pending_payouts_to_address_format` CHECK pins
    // `to_address` to `^G[A-Z2-7]{55}$`, so we replace with a
    // synthetic well-formed sentinel rather than NULL or empty. The
    // sentinel doesn't decode to a real account; combined with the
    // user-row email scrub above, the row no longer links a real
    // person to a real Stellar address.
    //
    // Pending/submitted rows are blocked above so they cannot reach
    // this scrub; we only ever clear addresses on rows that are
    // already terminal.
    await tx
      .update(pendingPayouts)
      .set({ toAddress: SCRUBBED_TO_ADDRESS })
      .where(
        and(
          eq(pendingPayouts.userId, userId),
          inArray(pendingPayouts.state, [
            'confirmed',
            'failed',
          ] satisfies (typeof PAYOUT_STATES)[number][]),
        ),
      );

    return { ok: true };
  });

  // Any block short-circuits here — the transaction committed with no
  // writes (an empty, lock-only txn) and we surface the reason.
  if (!txnResult.ok) {
    return txnResult;
  }

  // Sessions: revoke after the txn so a partial failure doesn't
  // leave the user logged-out without their data anonymised. The
  // refresh-token revoke is idempotent.
  //
  // A4-086: surface a revoke failure loudly. The anonymisation
  // already committed, so we cannot roll back; but a stale
  // refresh token against an anonymised row is a privacy
  // regression we want operators to know about and remediate
  // (running revokeAllRefreshTokensForUser manually). Without
  // this log line, a transient DB blip during the revoke would
  // silently leave the row anonymised but sessions live.
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
