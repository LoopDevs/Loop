/**
 * Admin order re-drive lever (A5-1 / readiness-backlog §Tier 5).
 *
 * `POST /api/admin/orders/:orderId/redrive` — the operator action for
 * a `paid` or `procuring` order that's stuck with no other lever
 * today (no requeue/reprocure/manual-fulfill; resolution otherwise
 * relies on the worker eventually retrying, else raw SQL / a kill
 * switch). Re-runs the SAME procurement path the worker itself uses
 * (`procureOne`) rather than a parallel money path, so every existing
 * idempotency guard (the `markOrderProcuring` CAS, the `ctx_settlements`
 * durable settlement record) still holds for a re-drive.
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

/**
 * Outcome label from the underlying `procureOne` call (or `'not_run'`
 * when the order was reverted `procuring` → `paid` but the DB CAS lost
 * a race before `procureOne` could claim it — see the handler for the
 * exact condition).
 */
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
