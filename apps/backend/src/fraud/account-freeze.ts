/**
 * NS-08 — per-account freeze / AML-hold: types, service interface,
 * errors, scope semantics, and the hot-path enforcement read.
 *
 * ── What a freeze is (design doc §1) ─────────────────────────────────
 * A live hold on a single user's account blocks money LEAVING that
 * account — the enumerated debit / withdraw / spend paths (design doc
 * §5). A compromised, fraudulent, or AML-flagged account can be frozen
 * by an admin so debits/withdrawals are refused at every entry point
 * until the hold is cleared.
 *
 * ── Dual-layer (design doc §3) ───────────────────────────────────────
 * An append-only `account_holds` ledger (source of truth + reason /
 * actor / audit trail — `db/schema/fraud.ts`) PLUS a denormalized
 * `users.frozen_at` / `users.frozen_scope` MIRROR for the hot per-debit
 * read — exactly the `staff_roles` + `users.is_admin` and
 * `credit_transactions` + `user_credits` patterns already in the schema.
 * `getAccountFreezeState` is the hot column-scoped read (like
 * `getUserTokenVersion`); the `AccountFreezeService`
 * (`./account-freeze-service.ts`) writes the ledger and keeps the mirror
 * in sync in one transaction.
 *
 * ── Scope semantics (ASH's decision #1/#2 + strict-AML tiebreak) ──────
 * ANY live hold — `debits_only` OR `full` — blocks BOTH money OUT AND
 * money IN:
 *   • money OUT (spend / redeem / withdraw) — every user-initiated debit
 *     path is refused.
 *   • money IN (outbound cashback / interest / emission payouts) — PAUSED
 *     under either scope (ASH strict-AML tiebreak, 2026-07: a flagged
 *     account receives NOTHING until cleared; the payout worker defers +
 *     pays on unfreeze). This supersedes the earlier "only `full` pauses
 *     payouts" reading.
 * The `debits_only`/`full` two-tier survives on the ledger/API for the
 * audit record + future finer semantics; enforcement is currently uniform
 * across the two scopes.
 *
 * ── Safety posture (this is a MONEY app) ─────────────────────────────
 * The hot read FAILS CLOSED: if the mirror can't be read (DB blip,
 * missing user row), the account is treated as FROZEN (scope `full`) so
 * money stays put — mirrors the CFG-06 / A4-047 / NS-04 precedent (an
 * unreadable switch is treated as ENGAGED). A gated debit that cannot
 * prove the account is un-frozen must not proceed.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { DB } from '../db/client.js';
import { users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ area: 'account-freeze' });

/** A db handle or an open transaction — a freeze read runs on either. */
type FreezeExecutor = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

/**
 * What a hold blocks. `full` refuses every debit/withdraw path AND holds
 * outbound payouts (money in to the wallet); `debits_only` refuses
 * user-initiated spends/withdrawals but lets the system keep paying
 * already-earned cashback out. Dual-layer: the migration's CHECK and
 * this union agree from day one (design doc §3).
 */
export const ACCOUNT_HOLD_SCOPES = ['full', 'debits_only'] as const;
export type AccountHoldScope = (typeof ACCOUNT_HOLD_SCOPES)[number];

/**
 * AML / incident reason codes a hold can be placed under (ASH's decision
 * #3 — the 7 codes are the confirmed starting set; the DB CHECK is their
 * twin). Widening is a CHECK migration + an edit here, together.
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

export function isAccountHoldScope(v: unknown): v is AccountHoldScope {
  return typeof v === 'string' && (ACCOUNT_HOLD_SCOPES as readonly string[]).includes(v);
}
export function isAccountHoldReasonCode(v: unknown): v is AccountHoldReasonCode {
  return typeof v === 'string' && (ACCOUNT_HOLD_REASON_CODES as readonly string[]).includes(v);
}

/**
 * Relative restrictiveness — `full` (2) outranks `debits_only` (1). Used
 * to resolve the effective (most restrictive) mirror scope across a
 * user's live holds.
 */
export function scopeRank(scope: AccountHoldScope): number {
  return scope === 'full' ? 2 : 1;
}

/** `true` for every scope: any live hold blocks money OUT of the account. */
export function scopeBlocksDebit(_scope: AccountHoldScope): boolean {
  return true;
}

/**
 * `true` for every scope (ASH strict-AML tiebreak, 2026-07): ANY live hold
 * — `debits_only` OR `full` — pauses money IN to the wallet (outbound
 * cashback / interest / emission payouts). A flagged account receives
 * NOTHING until the hold is cleared (deferred + paid on unfreeze), so
 * funds never land in a possibly-attacker-controlled wallet. This
 * supersedes the earlier "only `full` holds payouts" reading. The
 * two-tier scope survives for the audit record + future finer semantics;
 * enforcement is currently uniform across scopes (debit + payout both
 * blocked under either).
 */
export function scopeBlocksIncoming(_scope: AccountHoldScope): boolean {
  return true;
}

/**
 * One row of the append-only `account_holds` ledger. `releasedAt` null
 * ⇒ the hold is LIVE.
 */
export interface AccountHold {
  id: string;
  userId: string;
  scope: AccountHoldScope;
  reasonCode: AccountHoldReasonCode;
  /** Free-text operator rationale (2..500, mirrors credit-adjustment). */
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
 * The resolved freeze state of an account — what the enforcement helpers
 * return. `frozen` is the fast boolean the debit gate branches on;
 * `scope` narrows what is blocked.
 */
export interface AccountFreezeState {
  userId: string;
  frozen: boolean;
  /** Effective (most restrictive) scope across live holds; null when not frozen. */
  scope: AccountHoldScope | null;
  /** Timestamp of the earliest live hold; null when not frozen. Mirrors `users.frozen_at`. */
  frozenAt: Date | null;
}

/** Arguments to place a hold (design doc §4). */
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
 * The admin/AML control surface (design doc §4). Every write is
 * step-up-gated (`account-freeze` / `account-unfreeze`),
 * idempotency-keyed, reason-required, and Discord-audited — the same
 * envelope as `applyAdminCreditAdjustment`. The production implementation
 * is `DbAccountFreezeService` in `./account-freeze-service.ts`.
 */
export interface AccountFreezeService {
  /**
   * Places a hold: inserts an `account_holds` row and recomputes the
   * `users.frozen_at` / `frozen_scope` mirror in ONE transaction. A
   * repeat freeze at the same scope while one is already live is a no-op
   * that returns the existing live hold (the partial unique index makes
   * it a no-op, not a duplicate row). Returns the live hold.
   */
  placeHold(args: PlaceAccountHoldArgs): Promise<AccountHold>;

  /**
   * Releases a live hold: stamps `released_at` / `released_by` /
   * `release_reason` and recomputes the mirror (null iff no live holds
   * remain) in ONE transaction.
   */
  releaseHold(args: ReleaseAccountHoldArgs): Promise<AccountHold>;

  /** All holds for a user, newest first (admin user-detail surface). */
  listHolds(userId: string): Promise<AccountHold[]>;

  /** Live holds across all users, for the admin holds dashboard. */
  listActiveHolds(opts?: { limit?: number }): Promise<AccountHold[]>;

  /** Resolved freeze state for one user (source-of-truth read). */
  getFreezeState(userId: string): Promise<AccountFreezeState>;
}

/**
 * Thrown by the enforcement helpers when a live hold blocks an action.
 * The HTTP layer maps this to `403 ACCOUNT_FROZEN` on user-initiated
 * surfaces (order create / redeem / …); the admin emission surface maps
 * it to `409 ACCOUNT_FROZEN` (an admin route cannot 403 — openapi-parity
 * `admin-403`). `code` is the shared `ApiErrorCode.ACCOUNT_FROZEN`.
 */
export class AccountFrozenError extends Error {
  readonly userId: string;
  readonly scope: AccountHoldScope | null;
  readonly code = 'ACCOUNT_FROZEN' as const;
  constructor(userId: string, scope: AccountHoldScope | null) {
    super(`Account ${userId} is frozen (scope=${scope ?? 'unknown'}) — action refused`);
    this.name = 'AccountFrozenError';
    this.userId = userId;
    this.scope = scope;
  }
}

/**
 * The intent of a value-moving action. Under the strict-AML tiebreak both
 * intents are blocked by ANY live hold; the discriminator is retained so
 * the policy stays legible and a future finer scope split (e.g. a hold
 * that lets earned payouts through) is a one-line change in the scope
 * helpers, not a re-wiring of every call site.
 *   - `user_spend` / `user_withdrawal` — money OUT of the account.
 *   - `system_payout` — money IN to the wallet (outbound cashback /
 *     interest / emission). PAUSED under either scope (strict-AML).
 */
export type FreezeIntent = 'user_spend' | 'user_withdrawal' | 'system_payout';

/**
 * HOT-PATH READ. Resolves a user's freeze state from the denormalized
 * `users.frozen_at` / `users.frozen_scope` mirror — one column-scoped
 * lookup, exactly like `getUserTokenVersion`. Accepts an open
 * transaction so a debit primitive can read the freeze under the same
 * txn (and row lock) as the debit it guards (design doc §5 defence-in-
 * depth).
 *
 * FAILS CLOSED: a DB read error (or a missing user row) is treated as
 * FROZEN with scope `full` — money stays put when the freeze state can't
 * be proven. Never throws.
 */
export async function getAccountFreezeState(
  userId: string,
  executor: FreezeExecutor = db,
): Promise<AccountFreezeState> {
  try {
    const [row] = await executor
      .select({ frozenAt: users.frozenAt, frozenScope: users.frozenScope })
      .from(users)
      .where(eq(users.id, userId));
    if (row === undefined) {
      // No such user row — a debit for a user we can't find must not
      // proceed. Fail closed (treat as fully frozen).
      log.error(
        { userId },
        'account-freeze read: no user row — failing CLOSED (treated as frozen)',
      );
      return { userId, frozen: true, scope: 'full', frozenAt: new Date(0) };
    }
    if (row.frozenAt === null || row.frozenScope === null) {
      return { userId, frozen: false, scope: null, frozenAt: null };
    }
    const scope: AccountHoldScope = isAccountHoldScope(row.frozenScope) ? row.frozenScope : 'full';
    return { userId, frozen: true, scope, frozenAt: row.frozenAt };
  } catch (err) {
    // FAIL CLOSED — an unreadable mirror is treated as FROZEN (scope
    // full) so a DB outage can't silently let a debit through.
    log.error(
      { err, userId },
      'account-freeze mirror read failed — failing CLOSED (account treated as frozen)',
    );
    return { userId, frozen: true, scope: 'full', frozenAt: new Date(0) };
  }
}

/**
 * `true` iff the given intent is blocked for `userId` right now (hot
 * read + scope resolution). Fail-closed (an unreadable mirror blocks).
 */
export async function isFrozenForIntent(
  userId: string,
  intent: FreezeIntent,
  executor: FreezeExecutor = db,
): Promise<boolean> {
  const state = await getAccountFreezeState(userId, executor);
  if (!state.frozen || state.scope === null) return false;
  return intent === 'system_payout'
    ? scopeBlocksIncoming(state.scope)
    : scopeBlocksDebit(state.scope);
}

/**
 * Enforcement assertion each gated path calls BEFORE moving money.
 * Throws `AccountFrozenError` (→ 403 / 409 ACCOUNT_FROZEN) when a live
 * hold blocks the action for the given intent. Pass an open `executor`
 * to read the freeze inside the debit's transaction (defence-in-depth —
 * a freeze placed mid-flight can't be raced past a same-txn re-read).
 */
export async function assertAccountNotFrozen(
  userId: string,
  intent: FreezeIntent,
  executor: FreezeExecutor = db,
): Promise<void> {
  const state = await getAccountFreezeState(userId, executor);
  if (!state.frozen || state.scope === null) return;
  const blocked =
    intent === 'system_payout' ? scopeBlocksIncoming(state.scope) : scopeBlocksDebit(state.scope);
  if (blocked) {
    throw new AccountFrozenError(userId, state.scope);
  }
}
