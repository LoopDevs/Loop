/**
 * Admin order re-drive lever (A5-1 / readiness-backlog §Tier 5).
 *
 * `POST /api/admin/orders/:orderId/redrive` — the operator action for
 * a `paid` order the procurement worker never drained (no requeue /
 * manual-reprocure today; the recovery sweep only touches `procuring`
 * rows, never `paid`, so a `paid` order stranded by a downed worker
 * sits forever and the only lever is raw SQL / a kill switch).
 * Re-runs the SAME procurement path the worker itself uses
 * (`procureOne`) rather than a parallel money path, so the existing
 * single-flight guard (`markOrderProcuring`'s `WHERE state='paid'`
 * CAS) makes concurrent redrives / a live worker safe: exactly one
 * caller claims the order, the rest report `'skipped'`.
 *
 * Scope: `paid` orders only. `procuring` orders are refused with
 * `ORDER_REDRIVE_IN_PROGRESS` — force-re-procuring an in-flight order
 * is a genuine double-pay / stranding risk (money-review 2026-07-09),
 * and stuck `procuring` orders already have the automatic recovery
 * sweep. Cancel-and-refund is a separate item (A5-4).
 *
 * Admin-tier + step-up (ADR 028 `'order-redrive'` scope) — unlike the
 * ADR 037 support-tier delivery-unsticking actions (refetch-redemption,
 * wallet-reprovision, watcher-skip-reopen), a re-drive can submit a
 * real outbound Stellar payment to CTX, so it's a money write.
 *
 * Lives in `@loop/shared` per ADR 019: the backend emits this shape,
 * the admin order-detail page consumes it, and the shared-type-parity
 * gate holds both sides to one definition.
 */

/** Outcome label from the underlying `procureOne` call. */
export type AdminOrderRedriveOutcome = 'fulfilled' | 'failed' | 'skipped';

/** `result` half of `POST /api/admin/orders/:orderId/redrive`. */
export interface AdminOrderRedriveResult {
  orderId: string;
  /** What `procureOne` reported for this attempt. */
  outcome: AdminOrderRedriveOutcome;
  /**
   * The order's state AFTER the re-drive attempt, re-read fresh from
   * the DB (not inferred from `outcome` — a `'skipped'` result can mean
   * several different post-states depending on which guard tripped).
   */
  state: string;
}
