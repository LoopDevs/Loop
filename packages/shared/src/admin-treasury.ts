/**
 * Admin treasury response shapes (A2-1506 slice).
 *
 * The treasury endpoint (`GET /api/admin/treasury`) is the
 * CTX-as-supplier overview for ops: outstanding user credit liability,
 * LOOP-asset circulation vs on-chain reserves, in-flight cashback
 * payouts per state, and the fulfilled-order wholesale/cashback/margin
 * split per charge currency (ADR 015).
 *
 * These types lived in two places:
 *   - `apps/backend/src/admin/treasury.ts` — authoritative handler
 *     build + openapi registration source
 *   - `apps/web/app/services/admin.ts` — web consumer re-declaration
 *
 * Consolidated here so a rename on either side fails the OTHER side's
 * typecheck immediately. A2-1506 catalogue:
 *   - LoopLiability
 *   - TreasuryHolding
 *   - TreasuryOrderFlow
 *   - TreasurySnapshot
 *
 * Re-exported from both the backend's `treasury.ts` and the web's
 * `services/admin.ts` via `export type { ... }` so existing call sites
 * don't learn the shared path.
 */
import type { LoopAssetCode } from './loop-asset.js';
import type { PayoutState } from './payout-state.js';

/**
 * One LOOP-stablecoin liability row. `outstandingMinor` is in the
 * matching fiat's minor units (pence / cents); `issuer` is the Stellar
 * G-account that mints the asset, or `null` if the operator hasn't
 * configured an issuer yet.
 */
export interface LoopLiability {
  outstandingMinor: string;
  issuer: string | null;
}

/**
 * One operator-held asset balance. `stroops` is the live on-chain
 * balance from Horizon `/accounts`, or `null` when Loop doesn't query
 * that asset today (the handler returns null rather than `"0"` so the
 * UI distinguishes "not queried" from "empty").
 */
export interface TreasuryHolding {
  stroops: string | null;
}

/**
 * Per charge-currency economics of fulfilled orders (ADR 015 — ADR 010
 * gift-card procurement flow). Sums — in the key's currency — how much
 * Loop paid CTX (`wholesaleMinor`), credited users (`userCashbackMinor`),
 * kept (`loopMarginMinor`), and the face value paid to the merchant
 * (`faceValueMinor`). All amounts are bigint-string minor units;
 * `count` is the number of fulfilled orders in the bucket.
 */
export interface TreasuryOrderFlow {
  count: string;
  faceValueMinor: string;
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
}

/**
 * Full response shape for `GET /api/admin/treasury`.
 */
export interface TreasurySnapshot {
  /** Outstanding credit (what Loop owes users), keyed by currency. Minor units, string. */
  outstanding: Record<string, string>;
  /** Ledger-by-type totals, keyed `[currency][type]`. Minor units, string. */
  totals: Record<string, Record<string, string>>;
  /** ADR 015 — per LOOP asset, outstanding + configured issuer. */
  liabilities: Record<LoopAssetCode, LoopLiability>;
  /** ADR 015 — Loop's yield-earning pile (USDC + XLM operator holdings). */
  assets: {
    USDC: TreasuryHolding;
    XLM: TreasuryHolding;
  };
  /**
   * ADR 015 — outbound Stellar cashback payouts at each state.
   * Admin UI renders this as a health card: any non-zero `failed`
   * count should page ops; a growing `submitted` without matching
   * `confirmed` means the Horizon confirmation watcher is lagging.
   */
  payouts: Record<PayoutState, string>;
  /**
   * ADR 015 — fulfilled-order flow per charge currency. Renders as
   * the "Supplier flow" card on `/admin/treasury` so ops can see the
   * CTX-as-supplier split at a glance (what Loop paid CTX, what it
   * credited users, what it kept).
   */
  orderFlows: Record<string, TreasuryOrderFlow>;
  /** CTX operator pool snapshot — ADR 013. */
  operatorPool: {
    size: number;
    operators: Array<{ id: string; state: string }>;
  };
}
