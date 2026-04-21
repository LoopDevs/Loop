/**
 * Cashback payout-intent builder (ADR 015).
 *
 * Pure function that takes an order's resolved cashback amount +
 * user profile and returns either:
 *   - an "intent" describing the Stellar Payment that should go
 *     out (to, asset code, asset issuer, amount in stroops, memo),
 *     which a future payout worker (Stellar SDK) signs + submits.
 *   - a skip reason when no on-chain payment should fire (user
 *     hasn't linked an address, cashback is zero, or the
 *     operator hasn't configured the LOOP asset for the user's
 *     home currency).
 *
 * Separating the build-intent step from the sign-and-submit step
 * means the ledger + skip-policy logic is unit-testable in
 * isolation — the @stellar/stellar-sdk integration is just the
 * thin shim that converts an intent into a signed tx.
 */
import type { HomeCurrency } from '../db/schema.js';
import { payoutAssetFor, type LoopAssetCode } from './payout-asset.js';

export interface PayoutIntent {
  /** Stellar destination address (G...). */
  to: string;
  /** LOOP asset code to send. 1:1 backed by `homeCurrency` fiat. */
  assetCode: LoopAssetCode;
  /** Stellar issuer account for the asset. Pinned via env. */
  assetIssuer: string;
  /** Amount to send in stroops (7 decimals). */
  amountStroops: bigint;
  /** Memo text (28 bytes max). Tag the payment so ops can trace it to the order. */
  memoText: string;
}

export type PayoutSkipReason =
  /** User hasn't linked a Stellar wallet yet — off-chain accrual only. */
  | 'no_address'
  /** Order's cashback amount is 0 — nothing to pay. */
  | 'no_cashback'
  /** The LOOP-asset issuer env var isn't set for the user's home currency. */
  | 'no_issuer';

export type PayoutDecision =
  | { kind: 'pay'; intent: PayoutIntent }
  | { kind: 'skip'; reason: PayoutSkipReason };

export interface BuildPayoutArgs {
  /** User's linked Stellar address, or null when unlinked. */
  stellarAddress: string | null;
  /** User's home currency — picks the LOOP asset. */
  homeCurrency: HomeCurrency;
  /** Cashback owed to the user in minor units (pence / cents). */
  userCashbackMinor: bigint;
  /** Something uniquely identifying the order, used for the memo text. Capped at 28 chars. */
  memoSeed: string;
}

/**
 * Decides whether a Stellar payout should fire for this order.
 *
 * Pure — no I/O. The caller composes the decision with whatever
 * transactional machinery submits the payment; this function only
 * concerns itself with policy.
 *
 * 1:1 peg: LOOP assets denominate the matching fiat's minor unit
 * at 7 decimals. 1 pence = 100_000 GBPLOOP stroops, 1 cent =
 * 100_000 USDLOOP stroops. So `amountStroops = cashbackMinor * 1e5`.
 */
export function buildPayoutIntent(args: BuildPayoutArgs): PayoutDecision {
  if (args.userCashbackMinor <= 0n) {
    return { kind: 'skip', reason: 'no_cashback' };
  }
  if (args.stellarAddress === null) {
    return { kind: 'skip', reason: 'no_address' };
  }
  const asset = payoutAssetFor(args.homeCurrency);
  if (asset.issuer === null) {
    return { kind: 'skip', reason: 'no_issuer' };
  }
  return {
    kind: 'pay',
    intent: {
      to: args.stellarAddress,
      assetCode: asset.code,
      assetIssuer: asset.issuer,
      amountStroops: args.userCashbackMinor * 100_000n,
      memoText: args.memoSeed.slice(0, 28),
    },
  };
}
