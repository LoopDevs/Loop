/**
 * Admin-mediated home-currency change (ADR 015 deferred § "self-serve
 * home-currency change — currently support-mediated").
 *
 * `users.home_currency` is the fiat denomination for every order the
 * user places and every cashback row credited to them. The schema
 * around it is multi-currency-ready — `user_credits` keys on
 * `(user_id, currency)`, `pending_payouts` pins `asset_code` per row,
 * and orders pin `charge_currency` at create-time — but the user
 * surface only ever reads one home_currency. Switching it is therefore
 * a write that is safe ONLY when there is no live state denominated
 * in the old currency. If we flipped a user from USD → GBP while their
 * `user_credits[USD]` row had a £4 balance, that balance would still
 * exist on the ledger but become invisible everywhere we filter on
 * `charge_currency = user.home_currency`.
 *
 * Pre-flight invariants (run inside the same txn as the UPDATE so a
 * concurrent credit-write or payout-claim can't race past them):
 *   1. The target row exists. Idempotency-guard already serialises
 *      same-key replays; this catches a key-typo'd userId.
 *   2. New currency ≠ current currency. A no-op write is rejected with
 *      `HOME_CURRENCY_UNCHANGED` so the audit log doesn't get peppered
 *      with no-ops from a misclick.
 *   3. No non-zero `user_credits` row in the OLD currency. Zeroing it
 *      out via a credit-adjustment is the operator's prerequisite —
 *      the resulting orphaning would otherwise be silent.
 *   4. No in-flight payouts (`state IN ('pending', 'submitted')`).
 *      Failed rows are fine — they're already off the worker's hot
 *      path and ops have to retry them explicitly.
 *
 * Each invariant maps to a typed error so the handler can return a
 * user-actionable message rather than a generic 409. The errors carry
 * the witnesses (currency / balance / payout count) so the operator
 * can see exactly what's blocking them and act.
 *
 * The mutation itself is a single `UPDATE users SET home_currency = $1,
 * updated_at = now() WHERE id = $2 AND home_currency = $3`. The third
 * predicate is belt-and-braces against a TOCTOU between the SELECT and
 * the UPDATE — if a concurrent admin write changed the value out from
 * under us, our update affects zero rows and we throw `ConcurrentChange`
 * rather than silently overwriting their write. The txn already holds
 * the FOR UPDATE row-lock so this should be unreachable, but the
 * paranoia is cheap.
 */
import { and, eq, ne, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, userCredits, pendingPayouts, type HomeCurrency } from '../db/schema.js';

export class UserNotFoundError extends Error {
  constructor(public readonly userId: string) {
    super('User not found');
    this.name = 'UserNotFoundError';
  }
}

export class HomeCurrencyUnchangedError extends Error {
  constructor(public readonly currency: HomeCurrency) {
    super('Home currency is already set to the requested value');
    this.name = 'HomeCurrencyUnchangedError';
  }
}

export class HomeCurrencyHasLiveBalanceError extends Error {
  constructor(
    public readonly currency: string,
    public readonly balanceMinor: bigint,
  ) {
    super('User has a non-zero credit balance in the current home currency');
    this.name = 'HomeCurrencyHasLiveBalanceError';
  }
}

export class HomeCurrencyHasInFlightPayoutsError extends Error {
  constructor(public readonly count: number) {
    super('User has in-flight payouts that must clear before the home currency can change');
    this.name = 'HomeCurrencyHasInFlightPayoutsError';
  }
}

export class HomeCurrencyConcurrentChangeError extends Error {
  constructor() {
    super('Home currency was changed by a concurrent write');
    this.name = 'HomeCurrencyConcurrentChangeError';
  }
}

export interface HomeCurrencyChange {
  userId: string;
  priorHomeCurrency: HomeCurrency;
  newHomeCurrency: HomeCurrency;
  updatedAt: Date;
}

export async function applyAdminHomeCurrencyChange(args: {
  userId: string;
  newHomeCurrency: HomeCurrency;
}): Promise<HomeCurrencyChange> {
  return db.transaction(async (tx) => {
    const lockedRows = await tx
      .select({ id: users.id, homeCurrency: users.homeCurrency })
      .from(users)
      .where(eq(users.id, args.userId))
      .for('update');
    const row = lockedRows[0];
    if (row === undefined) {
      throw new UserNotFoundError(args.userId);
    }
    const priorHomeCurrency = row.homeCurrency as HomeCurrency;
    if (priorHomeCurrency === args.newHomeCurrency) {
      throw new HomeCurrencyUnchangedError(priorHomeCurrency);
    }

    // Live balance in the OUTGOING currency would be silently orphaned
    // by the switch — the user's surfaces filter on
    // `charge_currency = user.home_currency`, so the row stays on the
    // ledger but becomes invisible. Reject and let ops zero it via a
    // credit-adjustment first.
    const liveBalances = await tx
      .select({
        currency: userCredits.currency,
        balanceMinor: userCredits.balanceMinor,
      })
      .from(userCredits)
      .where(and(eq(userCredits.userId, args.userId), eq(userCredits.currency, priorHomeCurrency)));
    const liveBalance = liveBalances[0];
    if (liveBalance !== undefined && liveBalance.balanceMinor !== 0n) {
      throw new HomeCurrencyHasLiveBalanceError(liveBalance.currency, liveBalance.balanceMinor);
    }

    // In-flight payouts are pinned to the OLD asset_code at write-time;
    // changing home_currency mid-flight would leave them targeting the
    // user's prior LOOP-asset (e.g. USDLOOP) while the user surfaces
    // expect the new one (e.g. GBPLOOP). Refuse until they settle.
    const inFlight = await tx
      .select({ count: sql<string>`count(*)::text` })
      .from(pendingPayouts)
      .where(
        and(
          eq(pendingPayouts.userId, args.userId),
          inArray(pendingPayouts.state, ['pending', 'submitted']),
        ),
      );
    const inFlightCount = Number(inFlight[0]?.count ?? '0');
    if (inFlightCount > 0) {
      throw new HomeCurrencyHasInFlightPayoutsError(inFlightCount);
    }

    const updated = await tx
      .update(users)
      .set({ homeCurrency: args.newHomeCurrency, updatedAt: new Date() })
      .where(and(eq(users.id, args.userId), ne(users.homeCurrency, args.newHomeCurrency)))
      .returning({
        id: users.id,
        homeCurrency: users.homeCurrency,
        updatedAt: users.updatedAt,
      });
    const updatedRow = updated[0];
    if (updatedRow === undefined) {
      throw new HomeCurrencyConcurrentChangeError();
    }

    return {
      userId: updatedRow.id,
      priorHomeCurrency,
      newHomeCurrency: updatedRow.homeCurrency as HomeCurrency,
      updatedAt: updatedRow.updatedAt,
    };
  });
}
