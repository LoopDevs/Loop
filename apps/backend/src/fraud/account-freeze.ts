/**
 * NS-08 — per-account freeze / AML-hold (DESIGN SCAFFOLD ONLY).
 *
 * ⚠️  NOT WIRED INTO ANY LIVE DEBIT PATH. This module is the
 *     type + service-interface + fail-closed-stub scaffold for the
 *     account-freeze capability designed in
 *     `docs/audit/audit-2026-07/ns-08-account-freeze-design.md`.
 *     It deliberately does NOT touch the database, because the
 *     `account_holds` table and the `users.frozen_at` mirror column it
 *     needs DO NOT EXIST YET — they land in migration 0071+ (applied
 *     later, serialized, per the NS-08 task). Until that migration is
 *     applied AND the policy questions in the design doc are answered
 *     by a human, the enforcement helpers below THROW rather than
 *     silently allow a debit, so a premature wire-in fails CLOSED (no
 *     money moves) instead of fail-open (freeze silently bypassed).
 *
 * ── What a freeze is (see design doc §1) ─────────────────────────────
 * A live hold on a single user's account blocks money LEAVING that
 * account — the enumerated debit / withdraw / spend paths in the
 * design doc §"Enforcement points". A compromised, fraudulent, or
 * AML-flagged account can be frozen by an admin so debits/withdrawals
 * are refused at every entry point until the hold is cleared.
 *
 * ── Why this mirrors the codebase's existing dual-layer pattern ──────
 * The design (doc §Schema) is an append-only `account_holds` ledger
 * (source of truth + reason/actor/audit trail) PLUS a denormalized
 * `users.frozen_at` mirror for the hot per-debit read — exactly the
 * `staff_roles` + `users.is_admin` shim and `credit_transactions` +
 * `user_credits` materialized-balance patterns already in the schema.
 * `isAccountFrozen` is the hot column-scoped read (like
 * `getUserTokenVersion`); `AccountFreezeService` writes the ledger and
 * keeps the mirror in sync in one transaction.
 */

/**
 * What a hold blocks. A `full` hold refuses every debit/withdraw path
 * AND (per the still-open policy question) may hold outbound payouts;
 * `debits_only` refuses user-initiated spends/withdrawals but lets the
 * system keep paying already-earned cashback out. The concrete
 * semantics are a POLICY QUESTION for the human (design doc §Policy) —
 * the enum exists so the migration's CHECK and the TypeScript union
 * agree from day one (the schema's dual-layer convention).
 */
export const ACCOUNT_HOLD_SCOPES = ['full', 'debits_only'] as const;
export type AccountHoldScope = (typeof ACCOUNT_HOLD_SCOPES)[number];

/**
 * AML / incident reason codes a hold can be placed under. DRAFT — the
 * canonical list is a compliance decision (design doc §Policy: "AML
 * reason codes"); these are placeholders so the shape compiles. Pin
 * the final set in the migration CHECK and here together.
 */
export const ACCOUNT_HOLD_REASON_CODES = [
  'aml_review',
  'sanctions_screening',
  'suspected_fraud',
  'account_compromise',
  'law_enforcement_request',
  'chargeback_investigation',
  'other',
] as const;
export type AccountHoldReasonCode = (typeof ACCOUNT_HOLD_REASON_CODES)[number];

/**
 * One row of the append-only `account_holds` ledger. `releasedAt` null
 * ⇒ the hold is LIVE. A user is frozen iff they have ≥1 live hold; the
 * `users.frozen_at` mirror is the min(placedAt) of their live holds
 * (or null when none), kept in sync by the service writes.
 */
export interface AccountHold {
  id: string;
  userId: string;
  scope: AccountHoldScope;
  reasonCode: AccountHoldReasonCode;
  /** Free-text operator rationale (design doc §Admin surface — required, 2..500, mirrors credit-adjustment). */
  reason: string;
  /** Admin userId who placed the hold (actor attribution, ADR 017). */
  placedByUserId: string;
  placedAt: Date;
  /** Null while live; set when an admin clears the hold. */
  releasedAt: Date | null;
  /** Admin userId who released the hold; null while live. */
  releasedByUserId: string | null;
  /** Operator rationale for the release; null while live. */
  releaseReason: string | null;
}

/**
 * The resolved freeze state of an account, as the enforcement helpers
 * would return it once wired. `frozen` is the fast boolean the debit
 * gate branches on; `scope` narrows what is blocked when frozen.
 */
export interface AccountFreezeState {
  userId: string;
  frozen: boolean;
  /** The effective (most restrictive) scope across live holds; null when not frozen. */
  scope: AccountHoldScope | null;
  /** Timestamp of the earliest live hold; null when not frozen. Mirrors `users.frozen_at`. */
  frozenAt: Date | null;
}

/** Arguments to place a hold (design doc §Admin surface). */
export interface PlaceAccountHoldArgs {
  userId: string;
  scope: AccountHoldScope;
  reasonCode: AccountHoldReasonCode;
  reason: string;
  /** Admin actor from the request context (`c.get('user')`), NEVER the request body. */
  placedByUserId: string;
}

/** Arguments to release a live hold. */
export interface ReleaseAccountHoldArgs {
  holdId: string;
  releaseReason: string;
  releasedByUserId: string;
}

/**
 * The admin/AML control surface (design doc §Admin surface). Every
 * write is step-up-gated (proposed scopes `'account-freeze'` /
 * `'account-unfreeze'`), idempotency-keyed, reason-required, and
 * Discord-audited — the same envelope as `applyAdminCreditAdjustment`.
 *
 * SCAFFOLD: interface only. The implementing class lands with the
 * migration; it is intentionally absent here so nothing can construct
 * a service that reads/writes tables that do not yet exist.
 */
export interface AccountFreezeService {
  /**
   * Places a hold: inserts an `account_holds` row and sets the
   * `users.frozen_at` mirror in ONE transaction. Idempotent on the
   * admin idempotency key. Returns the created hold.
   */
  placeHold(args: PlaceAccountHoldArgs): Promise<AccountHold>;

  /**
   * Releases a live hold: sets `released_at` / `released_by` /
   * `release_reason` and recomputes the `users.frozen_at` mirror
   * (null iff no live holds remain) in ONE transaction.
   */
  releaseHold(args: ReleaseAccountHoldArgs): Promise<AccountHold>;

  /** All holds for a user, newest first (admin user-detail surface). */
  listHolds(userId: string): Promise<AccountHold[]>;

  /** Live holds across all users, for the admin holds dashboard. */
  listActiveHolds(opts?: { limit?: number; before?: Date }): Promise<AccountHold[]>;

  /** Resolved freeze state for one user (source-of-truth read). */
  getFreezeState(userId: string): Promise<AccountFreezeState>;
}

/**
 * Thrown by the enforcement helpers, ONCE WIRED, when a live hold
 * blocks a debit. The HTTP layer maps this to `403 ACCOUNT_FROZEN`
 * (design doc §Enforcement). This class is real and reusable — it is
 * the stub helpers below that are placeholders, not this error.
 */
export class AccountFrozenError extends Error {
  readonly userId: string;
  readonly scope: AccountHoldScope | null;
  readonly code = 'ACCOUNT_FROZEN' as const;
  constructor(userId: string, scope: AccountHoldScope | null) {
    super(`Account ${userId} is frozen (scope=${scope ?? 'unknown'}) — debit refused`);
    this.name = 'AccountFrozenError';
    this.userId = userId;
    this.scope = scope;
  }
}

/**
 * Thrown by the stub enforcement helpers below. Its existence is the
 * fail-CLOSED guarantee: if anyone wires `assertAccountNotFrozen` /
 * `isAccountFrozen` into a live debit path BEFORE migration 0071+
 * ships and the real query replaces these stubs, every gated debit
 * throws (money stays put) instead of silently allowing the debit. A
 * money hole from a half-shipped freeze is thereby impossible.
 */
export class AccountFreezeNotImplementedError extends Error {
  constructor(context: string) {
    super(
      `NS-08 account-freeze enforcement is scaffold-only and NOT implemented (${context}). ` +
        'Do not wire this into a debit path until migration 0071+ adds the account_holds ' +
        'table + users.frozen_at mirror and the policy questions in ' +
        'docs/audit/audit-2026-07/ns-08-account-freeze-design.md are resolved.',
    );
    this.name = 'AccountFreezeNotImplementedError';
  }
}

/**
 * ENFORCEMENT HELPER — STUB. Once wired (post-migration), this becomes
 * a column-scoped read of `users.frozen_at` (the hot mirror, exactly
 * like `getUserTokenVersion`) resolving the effective scope, and the
 * debit gate at each enumerated enforcement point (design doc §
 * Enforcement points) calls `assertAccountNotFrozen` BEFORE moving
 * money — inside the same transaction as the debit where one exists,
 * so a freeze placed mid-flight can't be raced.
 *
 * TODO(NS-08, migration 0071+): replace the throw with:
 *   const row = await db.query.users.findFirst({
 *     columns: { frozenAt: true, ... }, where: eq(users.id, userId) });
 *   return { userId, frozen: row?.frozenAt != null, ... };
 */
export function isAccountFrozen(userId: string): Promise<AccountFreezeState> {
  // Fail closed: never return `{ frozen: false }` from a stub — that
  // would be a fail-OPEN default on a money gate.
  return Promise.reject(new AccountFreezeNotImplementedError(`isAccountFrozen(${userId})`));
}

/**
 * ENFORCEMENT HELPER — STUB. The assertion form each debit entry point
 * would call. Throws `AccountFrozenError` (→ 403 ACCOUNT_FROZEN) when a
 * live hold blocks the action, given the debit's `intent` (so a
 * `debits_only` hold can let a system-initiated payout through while
 * refusing a user-initiated spend — a POLICY QUESTION, see design doc).
 *
 * TODO(NS-08, migration 0071+): implement against `isAccountFrozen`
 * and the resolved policy for which intents each scope blocks.
 */
export function assertAccountNotFrozen(
  userId: string,
  intent: 'user_spend' | 'user_withdrawal' | 'system_payout',
): Promise<void> {
  return Promise.reject(
    new AccountFreezeNotImplementedError(`assertAccountNotFrozen(${userId}, ${intent})`),
  );
}
