/**
 * Admin operator-mix response shapes (A2-1506 slice).
 *
 * Three endpoints expose the CTX operator-pool health triplet — which
 * operator fulfilled which orders, drilled from three angles (ADR 013,
 * A2-1522 "mix-axis matrix" pattern):
 *
 *   - `GET /api/admin/merchants/:merchantId/operator-mix`
 *   - `GET /api/admin/operators/:operatorId/merchant-mix`
 *   - `GET /api/admin/users/:userId/operator-mix`
 *
 * Each row is the same column set (operator / merchant id + order
 * counts + lastOrderAt) — only the id-axis and filter differ. Shapes
 * were re-declared on both sides; consolidated here.
 */

/**
 * One row of the merchant → operator mix — per-operator order
 * breakdown for a given merchant in the window.
 */
export interface MerchantOperatorMixRow {
  operatorId: string;
  orderCount: number;
  fulfilledCount: number;
  failedCount: number;
  /** ISO-8601 UTC. */
  lastOrderAt: string;
}

export interface MerchantOperatorMixResponse {
  merchantId: string;
  /** ISO-8601 lower bound of the window (inclusive). */
  since: string;
  rows: MerchantOperatorMixRow[];
}

/**
 * One row of the operator → merchant mix — per-merchant order
 * breakdown for a given operator in the window.
 */
export interface OperatorMerchantMixRow {
  merchantId: string;
  orderCount: number;
  fulfilledCount: number;
  failedCount: number;
  /** ISO-8601 UTC. */
  lastOrderAt: string;
}

export interface OperatorMerchantMixResponse {
  operatorId: string;
  /** ISO-8601 lower bound of the window (inclusive). */
  since: string;
  rows: OperatorMerchantMixRow[];
}

/**
 * One row of the user → operator mix — per-operator order breakdown
 * for a given user in the window.
 */
export interface UserOperatorMixRow {
  operatorId: string;
  orderCount: number;
  fulfilledCount: number;
  failedCount: number;
  /** ISO-8601 UTC. */
  lastOrderAt: string;
}

export interface UserOperatorMixResponse {
  userId: string;
  /** ISO-8601 lower bound of the window (inclusive). */
  since: string;
  rows: UserOperatorMixRow[];
}
