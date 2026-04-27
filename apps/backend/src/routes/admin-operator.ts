/**
 * `/api/admin/*` operator + supplier-spend route mounts
 * (ADR 013 / 015 / 018 / 022).
 *
 * Lifted out of `apps/backend/src/routes/admin.ts`. Seven routes
 * that back the operator-fleet + supplier-spend cluster. Mirrors
 * the openapi splits across `./openapi/admin-supplier-spend.ts`
 * (#1173) for the supplier snapshot + activity, and
 * `./openapi/admin-operator-fleet.ts` (#1172) for the four
 * operator endpoints.
 *
 * Routes:
 *   - GET /api/admin/supplier-spend                        (snapshot)
 *   - GET /api/admin/supplier-spend/activity               (sparkline)
 *   - GET /api/admin/operators/:operatorId/supplier-spend  (per-op)
 *   - GET /api/admin/operators/:operatorId/activity        (per-op series)
 *   - GET /api/admin/operators/:operatorId/merchant-mix    (per-op mix)
 *   - GET /api/admin/operator-stats                        (fleet stats)
 *   - GET /api/admin/operators/latency                     (fleet p50/95/99)
 *
 * Mount-order discipline: the literal `/operators/latency` (2 path
 * segments) and the `/operators/:operatorId/*` routes (3 segments)
 * are both kept, the segment-count difference means they don\'t
 * conflict so the original mount order is preserved verbatim.
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this
 * factory MUST be called AFTER the 4-piece middleware stack
 * (cache-control / requireAuth / requireAdmin / audit middleware)
 * is in place; that\'s the parent factory\'s responsibility.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { adminSupplierSpendHandler } from '../admin/supplier-spend.js';
import { adminSupplierSpendActivityHandler } from '../admin/supplier-spend-activity.js';
import { adminOperatorSupplierSpendHandler } from '../admin/operator-supplier-spend.js';
import { adminOperatorActivityHandler } from '../admin/operator-activity.js';
import { adminOperatorMerchantMixHandler } from '../admin/operator-merchant-mix.js';
import { adminOperatorStatsHandler } from '../admin/operator-stats.js';
import { adminOperatorLatencyHandler } from '../admin/operator-latency.js';

/**
 * Mounts the operator + supplier-spend routes on the supplied
 * Hono app. Called once from `mountAdminRoutes` after the admin
 * middleware stack is in place.
 */
export function mountAdminOperatorRoutes(app: Hono): void {
  // Supplier-spend snapshot (ADR 013 / 015): per-currency aggregate of
  // what Loop paid CTX across fulfilled orders in the window. Admin UI
  // renders this on the treasury page as the "supplier" card next to
  // outstanding liabilities.
  app.get('/api/admin/supplier-spend', rateLimit(60, 60_000), adminSupplierSpendHandler);
  // Supplier-spend activity time-series (ADR 013 / 015) — per-day
  // per-currency wholesale/face/cashback/margin paid to CTX. The
  // time-axis of the supplier-spend snapshot. Together with
  // credit-flow (ledger in) and payouts-activity (chain out) this
  // completes the three treasury-velocity feeds ops watches to
  // know money moved as expected today.
  app.get(
    '/api/admin/supplier-spend/activity',
    rateLimit(60, 60_000),
    adminSupplierSpendActivityHandler,
  );
  // Per-operator supplier-spend (#674) — per-currency aggregate
  // scoped to one CTX operator. Answers "which operator drove the
  // supplier spend?" — the ADR-022 per-operator axis of the fleet-
  // wide supplier-spend. Ops uses this to spot load-balancing
  // drift: one operator suddenly carrying 80% of spend is a
  // scheduler / circuit-breaker signal.
  app.get(
    '/api/admin/operators/:operatorId/supplier-spend',
    rateLimit(120, 60_000),
    adminOperatorSupplierSpendHandler,
  );
  // Per-operator daily activity time-series (ADR 013 / 022) —
  // completes the operator-drill quartet alongside operator-stats
  // (fleet snapshot), operators/latency (fleet percentiles) and
  // operators/:id/supplier-spend (per-operator cost). Answers "is
  // this operator degrading?" — a rising `failed` line or a
  // dropping fulfilled/created ratio is a scheduler-tuning /
  // CTX-escalation signal before the circuit breaker trips.
  app.get(
    '/api/admin/operators/:operatorId/activity',
    rateLimit(120, 60_000),
    adminOperatorActivityHandler,
  );
  // Per-operator merchant mix (ADR 013 / 022) — dual of the
  // /merchants/:id/operator-mix endpoint. Answers "which merchants
  // is THIS operator carrying?" for CTX relationship capacity
  // reviews ("op-alpha is pulling 40% of its volume from a single
  // merchant — concentration-risk or SLA lever?").
  app.get(
    '/api/admin/operators/:operatorId/merchant-mix',
    rateLimit(120, 60_000),
    adminOperatorMerchantMixHandler,
  );
  // Per-operator breakdown of which CTX service account carried which
  // orders (ADR 013). Complements supplier-spend: spend is *what* Loop
  // paid CTX per currency, operator-stats is *which operator* carried
  // the traffic — the two answer different questions during an
  // incident so they live side-by-side on the treasury page.
  app.get('/api/admin/operator-stats', rateLimit(60, 60_000), adminOperatorStatsHandler);
  // Per-operator fulfilment latency (ADR 013 / 022): p50/p95/p99 of
  // `fulfilledAt - paidAt` per operator in the window. Operator-stats
  // above tells ops *which* operator is busy; this tells them *which
  // is slow*. A busy operator with rising p95 is the early signal
  // before the circuit breaker trips.
  app.get('/api/admin/operators/latency', rateLimit(60, 60_000), adminOperatorLatencyHandler);
}
