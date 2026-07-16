/**
 * NS-08 — the REAL, table-backed `AccountFreezeService` (migration 0073).
 *
 * Reads/writes the append-only `account_holds` ledger and keeps the
 * denormalized `users.frozen_at` / `users.frozen_scope` hot-path MIRROR
 * in sync INSIDE the same transaction as every place/release write (the
 * ledger is the authority; the mirror is a cache the debit gate reads —
 * design doc §3). The admin freeze/unfreeze/list API goes through the
 * module-level singleton `accountFreezeService` exported at the bottom.
 *
 * Mirror recompute (the one invariant this file owns): after any
 * place/release, `frozen_at` = MIN(placed_at) over the user's LIVE holds
 * and `frozen_scope` = the most restrictive live scope ('full' beats
 * 'debits_only'); both NULL when no live hold remains. Computed in JS
 * (freeze writes are rare admin actions, not a hot path) so the empty
 * case sets BOTH columns null together, satisfying the
 * `users_frozen_mirror_shape` CHECK.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { DB } from '../db/client.js';
import { accountHolds, users } from '../db/schema.js';
import {
  type AccountFreezeService,
  type AccountFreezeState,
  type AccountHold,
  type AccountHoldReasonCode,
  type AccountHoldScope,
  type PlaceAccountHoldArgs,
  type ReleaseAccountHoldArgs,
  isAccountHoldReasonCode,
  isAccountHoldScope,
} from './account-freeze.js';

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
type Row = typeof accountHolds.$inferSelect;

/** Thrown by `releaseHold` when no `account_holds` row matches the id. */
export class AccountHoldNotFoundError extends Error {
  readonly holdId: string;
  constructor(holdId: string) {
    super(`account_holds row ${holdId} not found`);
    this.name = 'AccountHoldNotFoundError';
    this.holdId = holdId;
  }
}

/** Thrown by `releaseHold` when the hold exists but is already released. */
export class AccountHoldAlreadyReleasedError extends Error {
  readonly holdId: string;
  constructor(holdId: string) {
    super(`account_holds row ${holdId} is already released`);
    this.name = 'AccountHoldAlreadyReleasedError';
    this.holdId = holdId;
  }
}

function rowToHold(row: Row): AccountHold {
  // The DB CHECKs guarantee the enum shape; narrow defensively (a
  // hand-edited row falls back to the most restrictive / 'other').
  const scope: AccountHoldScope = isAccountHoldScope(row.scope) ? row.scope : 'full';
  const reasonCode: AccountHoldReasonCode = isAccountHoldReasonCode(row.reasonCode)
    ? row.reasonCode
    : 'other';
  return {
    id: row.id,
    userId: row.userId,
    scope,
    reasonCode,
    reason: row.reason,
    placedByUserId: row.placedByUserId,
    placedAt: row.placedAt,
    releasedAt: row.releasedAt,
    releasedByUserId: row.releasedByUserId,
    releaseReason: row.releaseReason,
  };
}

export class DbAccountFreezeService implements AccountFreezeService {
  /**
   * Recompute the `users.frozen_at` / `frozen_scope` mirror from the
   * user's LIVE holds. Runs inside the caller's transaction so the
   * ledger write and the mirror update commit together.
   */
  private async recomputeMirror(tx: Tx, userId: string): Promise<void> {
    const live = await tx
      .select({ placedAt: accountHolds.placedAt, scope: accountHolds.scope })
      .from(accountHolds)
      .where(and(eq(accountHolds.userId, userId), isNull(accountHolds.releasedAt)));
    if (live.length === 0) {
      // No live hold → both mirror columns null (mirror-shape CHECK).
      await tx.update(users).set({ frozenAt: null, frozenScope: null }).where(eq(users.id, userId));
      return;
    }
    let minPlaced = live[0]!.placedAt;
    let anyFull = false;
    for (const h of live) {
      if (h.placedAt < minPlaced) minPlaced = h.placedAt;
      if (h.scope === 'full') anyFull = true;
    }
    await tx
      .update(users)
      .set({ frozenAt: minPlaced, frozenScope: anyFull ? 'full' : 'debits_only' })
      .where(eq(users.id, userId));
  }

  async placeHold(args: PlaceAccountHoldArgs): Promise<AccountHold> {
    return db.transaction(async (tx) => {
      // Idempotent at the (user, scope) live-hold grain: the partial
      // unique index `account_holds_one_live_per_user_scope` means a
      // second freeze at the same scope while one is already live is a
      // no-op — ON CONFLICT DO NOTHING absorbs it and we return the
      // existing live hold rather than a duplicate row.
      const inserted = await tx
        .insert(accountHolds)
        .values({
          userId: args.userId,
          scope: args.scope,
          reasonCode: args.reasonCode,
          reason: args.reason,
          placedByUserId: args.placedByUserId,
        })
        .onConflictDoNothing({
          // Partial unique index arbiter — `where` mirrors the index's
          // `WHERE released_at IS NULL` predicate so Postgres knows which
          // partial index arbitrates (`ON CONFLICT (cols) WHERE … DO
          // NOTHING`). Only LIVE rows collide; a new hold whose prior
          // same-scope hold is released inserts cleanly.
          target: [accountHolds.userId, accountHolds.scope],
          where: isNull(accountHolds.releasedAt),
        })
        .returning();

      let hold: Row;
      if (inserted[0] !== undefined) {
        hold = inserted[0];
      } else {
        // Conflict absorbed — a live hold at this scope already exists.
        const [existing] = await tx
          .select()
          .from(accountHolds)
          .where(
            and(
              eq(accountHolds.userId, args.userId),
              eq(accountHolds.scope, args.scope),
              isNull(accountHolds.releasedAt),
            ),
          );
        if (existing === undefined) {
          // Unreachable: the conflict proves a live row exists.
          throw new Error(
            `account_holds place: conflict for (${args.userId}, ${args.scope}) but no live row found`,
          );
        }
        hold = existing;
      }

      // Recompute the mirror from ALL live holds (a fresh 'full' hold
      // must upgrade a mirror already set to 'debits_only', etc.).
      await this.recomputeMirror(tx, args.userId);
      return rowToHold(hold);
    });
  }

  async releaseHold(args: ReleaseAccountHoldArgs): Promise<AccountHold> {
    return db.transaction(async (tx) => {
      // Lock the target row so a concurrent release can't double-stamp.
      const [existing] = await tx
        .select()
        .from(accountHolds)
        .where(eq(accountHolds.id, args.holdId))
        .for('update');
      if (existing === undefined) {
        throw new AccountHoldNotFoundError(args.holdId);
      }
      if (existing.releasedAt !== null) {
        throw new AccountHoldAlreadyReleasedError(args.holdId);
      }

      const [released] = await tx
        .update(accountHolds)
        .set({
          releasedAt: new Date(),
          releasedByUserId: args.releasedByUserId,
          releaseReason: args.releaseReason,
        })
        .where(and(eq(accountHolds.id, args.holdId), isNull(accountHolds.releasedAt)))
        .returning();
      if (released === undefined) {
        // Unreachable — the FOR UPDATE lock above proved a live row.
        throw new AccountHoldAlreadyReleasedError(args.holdId);
      }

      await this.recomputeMirror(tx, existing.userId);
      return rowToHold(released);
    });
  }

  async listHolds(userId: string): Promise<AccountHold[]> {
    const rows = await db
      .select()
      .from(accountHolds)
      .where(eq(accountHolds.userId, userId))
      .orderBy(desc(accountHolds.placedAt));
    return rows.map(rowToHold);
  }

  async listActiveHolds(opts?: { limit?: number }): Promise<AccountHold[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
    const rows = await db
      .select()
      .from(accountHolds)
      .where(isNull(accountHolds.releasedAt))
      .orderBy(desc(accountHolds.placedAt))
      .limit(limit);
    return rows.map(rowToHold);
  }

  /**
   * Source-of-truth freeze state for a user, computed from the LEDGER
   * (not the mirror) — the reconciliation/read view. The hot debit gate
   * uses `getAccountFreezeState` (the mirror read) instead.
   */
  async getFreezeState(userId: string): Promise<AccountFreezeState> {
    const live = await db
      .select({ placedAt: accountHolds.placedAt, scope: accountHolds.scope })
      .from(accountHolds)
      .where(and(eq(accountHolds.userId, userId), isNull(accountHolds.releasedAt)));
    if (live.length === 0) {
      return { userId, frozen: false, scope: null, frozenAt: null };
    }
    let minPlaced = live[0]!.placedAt;
    let anyFull = false;
    for (const h of live) {
      if (h.placedAt < minPlaced) minPlaced = h.placedAt;
      if (h.scope === 'full') anyFull = true;
    }
    return {
      userId,
      frozen: true,
      scope: anyFull ? 'full' : 'debits_only',
      frozenAt: minPlaced,
    };
  }
}

/**
 * Process-wide singleton the admin API + any service caller share. The
 * hot debit gate does NOT go through this — it calls the column-scoped
 * `getAccountFreezeState` / `assertAccountNotFrozen` mirror read in
 * `./account-freeze.ts` directly.
 */
export const accountFreezeService: AccountFreezeService = new DbAccountFreezeService();
