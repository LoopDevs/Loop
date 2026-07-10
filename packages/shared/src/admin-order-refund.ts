/**
 * Order-bound admin refund (A5-4 / readiness-backlog §Tier 5).
 *
 * `POST /api/admin/orders/:orderId/refund` — the operator-decided policy
 * (readiness-backlog A5-4, 2026-07-10): a `paid` / `procuring` / `failed`
 * order refunds directly, reusing the SAME primitives the existing
 * auto-refund path uses (`credits/refunds.ts` — `applyOrderAutoRefund` /
 * `applyAdminRefund`), dispatched by `orders.paymentMethod`:
 *
 *   - `xlm` / `usdc` → on-chain refund-to-sender (the A6 `refundDeposit`
 *     machinery).
 *   - `credit`       → mirror-credit refund (`applyAdminRefund`).
 *   - `loop_asset`   → FAILS CLOSED (409) — matches the existing R3-2
 *     posture until on-chain re-mint/re-credit semantics land.
 *
 * A `fulfilled` order (the user already received the gift-card code) IS
 * refundable, but ONLY with a required **code-unused attestation** — the
 * operator affirms the delivered code is unused/unusable. This is the
 * accepted compensating control for the double-spend risk (the user
 * could keep the code AND get refunded) that stands in for CTX
 * redemption-verification, which Loop doesn't have yet (see
 * `docs/threat-model.md`'s accepted-risk register). `pending_payment` /
 * `expired` orders (nothing to reverse) and already-refunded orders are
 * rejected.
 *
 * Admin-tier + step-up (ADR 028 `'order-refund'` scope) — same
 * classification as the sibling A5-1 `order-redrive` lever: this can
 * submit a real outbound Stellar payment, so it's a money write.
 *
 * Lives in `@loop/shared` per ADR 019: the backend emits this shape, the
 * admin order-detail page consumes it, and the shared-type-parity gate
 * holds both sides to one definition.
 */

/** How the refund was actually applied — which existing primitive fired. */
export type AdminOrderRefundMethod = 'onchain_deposit_refund' | 'mirror_credit';

/**
 * Required on a FULFILLED-order refund only. `codeUnused` must be the
 * literal `true` — the wire shape makes "yes, attested" the only value
 * that satisfies the schema, so a client can't accidentally submit a
 * falsy attestation and have it silently accepted.
 */
export interface AdminOrderRefundAttestation {
  codeUnused: true;
  /** 2-500 chars. Persisted (truncated) into the durable refund reason. */
  attestationNote: string;
}

/** Request body for `POST /api/admin/orders/:orderId/refund`. */
export interface AdminOrderRefundRequest {
  /** 2-500 chars. */
  reason: string;
  /** Required (and validated server-side) only when the order is `fulfilled`. */
  attestation?: AdminOrderRefundAttestation;
}

/** `result` half of `POST /api/admin/orders/:orderId/refund`. */
export interface AdminOrderRefundResult {
  orderId: string;
  paymentMethod: 'xlm' | 'usdc' | 'credit' | 'loop_asset';
  refundMethod: AdminOrderRefundMethod;
  /** The full order charge, in `currency` — refunds are always full-amount. */
  amountMinor: string;
  currency: string;
  /**
   * Order state AFTER the refund, re-read fresh. `paid` / `procuring`
   * orders are fenced to `failed` as part of the refund (so the
   * procurement worker / redrive lever can never later pay CTX for a
   * refunded order); `failed` / `fulfilled` orders keep their state — a
   * refund does not have its own terminal state, it's recorded on the
   * ledger (mirrors how `applyOrderAutoRefund` already works).
   */
  orderState: string;
  /** True when this was a fulfilled-order refund gated on the attestation. */
  attested: boolean;
  /** Set only for `paymentMethod IN ('xlm', 'usdc')`. */
  onChain: { txHash: string } | null;
  /** Set only for `paymentMethod = 'credit'`. */
  mirrorCredit: { newBalanceMinor: string } | null;
}
