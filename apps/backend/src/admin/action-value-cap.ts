/**
 * NS-05: per-ACTION value cap on the admin money-move levers.
 *
 * The admin retry / redrive / vault-redrive / operator-float-adjust
 * handlers each authorise a discrete outbound value move (an on-chain
 * payout, a CTX procurement, a vault deposit/collect, or a float
 * bookkeeping adjustment). Before this guard NONE of them bounded the
 * per-action value, so a fat-finger or a compromised admin session
 * could push an unbounded amount through a single click. This module
 * is the single chokepoint every one of those handlers calls BEFORE it
 * moves money.
 *
 * ── Cross-currency handling (deliberate; see NS-05 task) ────────────
 * The cap is a single scalar in MINOR units
 * (`LOOP_ADMIN_ACTION_VALUE_CAP_MINOR`, default 100_000 = 1,000 major
 * units). It is compared against each action's value expressed in ITS
 * OWN currency's minor units — there is NO FX conversion anywhere in
 * this file. So a $-action is bounded to $1,000, a £-action to £1,000,
 * a €-action to €1,000 (100_000 minor of each), exactly the task's
 * prescribed "100_000 minor in the action's own currency" rule. Because
 * no cross-currency arithmetic is ever performed, the cap structurally
 * cannot silently mis-compare one currency against another.
 *
 * A non-fiat asset (XLM, on the operator-float lever) has no fiat peg
 * and this module consults no price oracle, so its cap is 1,000 XLM in
 * the asset's own unit — NOT "$1,000 worth of XLM". This is the honest,
 * mis-compare-free choice: 1,000 units of the action's own denomination,
 * whatever that denomination is. Fiat-pegged LOOP assets (GBPLOOP /
 * USDLOOP …) and USDC are 1:1 with their fiat currency, so their caps
 * ARE £1,000 / $1,000 as intended.
 */
import { env } from '../env.js';

/**
 * Stroops per fiat minor unit. A Stellar asset carries 7 decimals
 * (1 asset unit = 10^7 stroops); a fiat minor unit is 1/100 of a major
 * unit (1 major unit = 100 minor). So 1 minor = 10^7 / 100 = 10^5
 * stroops. Same constant the payments / vault modules use to move
 * between the mirror (minor) and on-chain (stroops) representations.
 */
export const STROOPS_PER_MINOR = 100_000n;

/**
 * Floor-convert an on-chain stroop amount to fiat minor units. Floor
 * (not round/ceil) is conservative for a cap check: it can only make a
 * value look SMALLER, so a sub-minor residual never trips the cap on
 * its own — a genuine over-cap amount is over-cap by whole minor units.
 */
export function stroopsToMinorFloor(amountStroops: bigint): bigint {
  return amountStroops / STROOPS_PER_MINOR;
}

/**
 * Thrown by `assertAdminActionValueWithinCap` when an admin money-move
 * action's value exceeds the per-action cap. Handlers catch it and map
 * it to a 422 `ADMIN_ACTION_VALUE_CAP_EXCEEDED` envelope BEFORE any
 * money moves. When thrown from inside a `withIdempotencyGuard`
 * `doWrite`, the guard transaction rolls back (so any pre-move state
 * flip is undone) and NO idempotency snapshot is stored — a corrected,
 * within-cap retry with the same key is free to proceed.
 */
export class AdminActionValueCapExceededError extends Error {
  constructor(
    readonly valueMinor: bigint,
    readonly capMinor: bigint,
    readonly currency: string,
  ) {
    super(
      `Action value ${valueMinor} minor (${currency}) exceeds the per-action cap of ` +
        `${capMinor} minor (${capMinor / 100n} ${currency} major units). Split it into ` +
        `smaller actions, or raise LOOP_ADMIN_ACTION_VALUE_CAP_MINOR if this is legitimate.`,
    );
    this.name = 'AdminActionValueCapExceededError';
  }
}

/**
 * Reject an admin money-move whose value exceeds the per-action cap.
 * `valueMinor` MUST already be in `currency`'s own minor units (use
 * `stroopsToMinorFloor` for stroop-denominated actions). Reads the cap
 * live from `env` on every call so a test / operator override takes
 * effect without a re-import.
 */
export function assertAdminActionValueWithinCap(args: {
  valueMinor: bigint;
  currency: string;
}): void {
  const capMinor = env.LOOP_ADMIN_ACTION_VALUE_CAP_MINOR;
  if (args.valueMinor > capMinor) {
    throw new AdminActionValueCapExceededError(args.valueMinor, capMinor, args.currency);
  }
}
