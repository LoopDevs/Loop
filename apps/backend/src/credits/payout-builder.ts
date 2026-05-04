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
import { randomBytes } from 'node:crypto';
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
  /**
   * Optional test-only memo override. Production leaves this
   * undefined and the builder generates a fresh 20-char base32
   * random memo via `generatePayoutMemo` (A2-605). Persist whatever
   * memo comes out into `pending_payouts.memo_text` so the submit
   * worker's idempotency pre-check (findOutboundPaymentByMemo)
   * can find the prior landed payment on retry.
   */
  memoText?: string;
}

/**
 * A2-605: generates a fresh 20-char base32 payout memo with 100 bits
 * of entropy. Earlier versions used `orderId.slice(0, 28)`, which is
 * a UUID prefix — ~94 bits of effective entropy after factoring out
 * the fixed variant/version bits, with a ~2^-47 birthday-collision
 * ceiling that's fine in theory but treats the memo as a derived
 * identifier rather than one that's engineered for uniqueness. A
 * dedicated generator keeps the memo independent of the order id's
 * shape so future order-id changes can't narrow collision resistance.
 *
 * Mirrors `generatePaymentMemo` in orders/repo.ts for consistency:
 * same alphabet, same 20-char width, same entropy budget. Both write
 * through a text memo (Stellar memo_text, 28 bytes max).
 */
export function generatePayoutMemo(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const buf = new Uint8Array(20);
  // node:crypto.randomBytes — cryptographic-grade CSPRNG, safe for
  // generating identifiers at scale.
  const bytes = randomBytes(20);
  for (let i = 0; i < 20; i++) buf[i] = bytes[i]!;
  let out = '';
  for (const byte of buf) {
    out += alphabet[byte % alphabet.length];
  }
  return out;
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
 *
 * A4-029: the 100_000 ratio assumes the LOOP-asset 7-decimal layout
 * pegged 1 unit-of-asset = 1 unit-of-fiat. If a future asset code
 * drifts (e.g. a non-7-decimal LOOP, or a USDC variant), the
 * on-chain amount sent is 100x off in either direction. Lock this
 * invariant to the LOOP-asset code set; any other code is a bug
 * upstream that we'd rather loud-fail on than silently mis-convert.
 */
const LOOP_ASSET_STROOPS_PER_MINOR = 100_000n;
const LOOP_ASSET_CODES = new Set(['USDLOOP', 'GBPLOOP', 'EURLOOP']);

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
  if (!LOOP_ASSET_CODES.has(asset.code)) {
    // A4-029: fail-loud invariant. The 100_000 multiplier is the
    // LOOP-asset 7-decimal ÷ 2-decimal-fiat ratio; a future
    // non-LOOP asset would silently send 100x off without this
    // guard.
    throw new Error(
      `payout-builder: unsupported asset code '${asset.code}' — stroops/minor ratio assumes LOOP-asset 7-decimal layout`,
    );
  }
  return {
    kind: 'pay',
    intent: {
      to: args.stellarAddress,
      assetCode: asset.code,
      assetIssuer: asset.issuer,
      amountStroops: args.userCashbackMinor * LOOP_ASSET_STROOPS_PER_MINOR,
      memoText: args.memoText ?? generatePayoutMemo(),
    },
  };
}
