/**
 * Support-dashboard route mounts (ADR 037 §4) — the watcher-skip
 * browser, the per-user wallet card, the redemption re-fetch, and
 * the reverse lookup. All SUPPORT-tier: these are exactly the
 * "find the customer, explain the state, unstick the delivery"
 * surfaces the support role exists for. The explicit
 * `requireStaff('support')` markers are functionally redundant with
 * the namespace blanket but make each mount's tier reviewable
 * in-place (and visible to staff-route-gating.test.ts).
 *
 * The three POST actions are idempotent re-drives of work the
 * customer already paid for; each carries the full ADR 017
 * envelope (Idempotency-Key, reason, Discord audit) even though
 * none of them moves money.
 *
 * Mount-order discipline: the literal `/watcher-skips` list
 * registers before `/watcher-skips/:paymentId`. The per-user and
 * per-order mounts are 4-segment paths and cannot collide with the
 * 3-segment `/users/:userId` / `/orders/:orderId` families.
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this
 * factory MUST be called AFTER the namespace middleware stack
 * (cache-control / requireAuth / requireStaff('support') blanket /
 * audit middleware) is in place; that's the parent factory's
 * responsibility.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireStaff } from '../auth/require-staff.js';
import {
  adminGetWatcherSkipHandler,
  adminListWatcherSkipsHandler,
  adminReopenWatcherSkipHandler,
} from '../admin/watcher-skips.js';
import { adminGetUserWalletHandler, adminWalletReprovisionHandler } from '../admin/user-wallet.js';
import { adminRefetchRedemptionHandler } from '../admin/order-refetch-redemption.js';
import { adminLookupHandler } from '../admin/lookup.js';

/**
 * Mounts the ADR 037 support-ops routes on the supplied Hono app.
 * Called once from `mountAdminRoutes` after the admin middleware
 * stack is in place.
 */
export function mountAdminSupportOpsRoutes(app: Hono): void {
  // Reverse lookup — order id / payment memo / Stellar address →
  // owning user. Index-backed only (migration 0042 indexes).
  app.get(
    '/api/admin/lookup',
    rateLimit('GET /api/admin/lookup', 60, 60_000),
    requireStaff('support'),
    adminLookupHandler,
  );
  // Watcher skip-row browser (payment_watcher_skips, migration
  // 0033). List before :paymentId so the literal path wins.
  app.get(
    '/api/admin/watcher-skips',
    rateLimit('GET /api/admin/watcher-skips', 60, 60_000),
    requireStaff('support'),
    adminListWatcherSkipsHandler,
  );
  app.get(
    '/api/admin/watcher-skips/:paymentId',
    rateLimit('GET /api/admin/watcher-skips/:paymentId', 120, 60_000),
    requireStaff('support'),
    adminGetWatcherSkipHandler,
  );
  // Support action: abandoned → pending with the attempt budget
  // reset (runbook: deposit-skip-abandoned.md).
  app.post(
    '/api/admin/watcher-skips/:paymentId/reopen',
    rateLimit('POST /api/admin/watcher-skips/:paymentId/reopen', 20, 60_000),
    requireStaff('support'),
    adminReopenWatcherSkipHandler,
  );
  // Per-user wallet card — provisioning state + provider linkage +
  // on-chain balances via the Horizon trustline reader.
  app.get(
    '/api/admin/users/:userId/wallet',
    rateLimit('GET /api/admin/users/:userId/wallet', 120, 60_000),
    requireStaff('support'),
    adminGetUserWalletHandler,
  );
  // Support action: reset the provisioning attempt budget +
  // re-enqueue the drive (runbook: wallet-provisioning-stuck.md).
  app.post(
    '/api/admin/users/:userId/wallet/reprovision',
    rateLimit('POST /api/admin/users/:userId/wallet/reprovision', 20, 60_000),
    requireStaff('support'),
    adminWalletReprovisionHandler,
  );
  // Support action: one-shot redemption re-fetch through the
  // backfill machinery (runbook: redemption-backfill-exhausted.md).
  // 10/min — every call is a CTX round-trip through the operator
  // pool.
  app.post(
    '/api/admin/orders/:orderId/refetch-redemption',
    rateLimit('POST /api/admin/orders/:orderId/refetch-redemption', 10, 60_000),
    requireStaff('support'),
    adminRefetchRedemptionHandler,
  );
}
