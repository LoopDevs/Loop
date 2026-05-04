/**
 * `/api/public/*` route mounts. Pulled out of `app.ts` as the
 * first per-domain route module — small (6 reads), no auth, no
 * cross-namespace mount-order dependencies, so a clean probe for
 * the larger route-module split.
 *
 * Every endpoint here follows the ADR 020 "public surface"
 * discipline:
 * - Unauthenticated — backs landing pages + pre-signup widgets
 *   that have no user context yet.
 * - Never-500 — the handlers fall back to a stale snapshot or a
 *   safe-empty payload rather than 5xx, so a backend hiccup
 *   doesn't blank the marketing page.
 * - Cache-Control set on the handler — the matching CDN respects
 *   the per-handler TTL so origin load stays low.
 * - 60/min per-IP rate limit on every endpoint — generous for a
 *   landing-page widget that renders once per visit.
 *
 * The `Hono` instance is passed in so the mount factory can be
 * called from `app.ts` at the right point in the middleware
 * chain (after global middleware, before authenticated routes).
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { publicCashbackStatsHandler } from '../public/cashback-stats.js';
import { publicCashbackPreviewHandler } from '../public/cashback-preview.js';
import { publicFlywheelStatsHandler } from '../public/flywheel-stats.js';
import { publicLoopAssetsHandler } from '../public/loop-assets.js';
import { publicMerchantHandler } from '../public/merchant.js';
import { publicTopCashbackMerchantsHandler } from '../public/top-cashback-merchants.js';

/**
 * Mounts all `/api/public/*` routes on the supplied Hono app.
 * Idempotent on a fresh app, but mounting twice on the same app
 * would double-register — caller is expected to invoke once.
 */
export function mountPublicRoutes(app: Hono): void {
  // Public, unauthenticated, marketing-facing cashback totals.
  // 60/min per IP is generous for a landing-page widget that
  // renders once per visit; edge-cache respects the handler's
  // Cache-Control so real origin load will be much lower.
  app.get(
    '/api/public/cashback-stats',
    rateLimit('GET /api/public/cashback-stats', 60, 60_000),
    publicCashbackStatsHandler,
  );

  // Public, unauthenticated, CDN-friendly "best cashback" list for
  // the landing page. Same never-500 + Cache-Control discipline as
  // the cashback-stats endpoint (ADR 020).
  app.get(
    '/api/public/top-cashback-merchants',
    rateLimit('GET /api/public/top-cashback-merchants', 60, 60_000),
    publicTopCashbackMerchantsHandler,
  );

  // Per-merchant unauthenticated detail (#647) — backs the SEO
  // landing pages at /cashback/:merchant-slug. Accepts merchant
  // id OR slug so SSR can pass whichever form is on the URL.
  // Same never-500 / cache-control discipline as the other
  // public endpoints (ADR 020).
  app.get(
    '/api/public/merchants/:id',
    rateLimit('GET /api/public/merchants/:id', 60, 60_000),
    publicMerchantHandler,
  );

  // Pre-signup "calculate your cashback" preview. Same never-500 +
  // Cache-Control discipline as the other public endpoints (ADR
  // 020). Accepts ?merchantId (id or slug) + ?amountMinor (integer
  // minor units) and returns the projected cashback amount using
  // the same floor-rounded math as the order-insert path, so the
  // preview never promises more than the user will actually earn.
  app.get(
    '/api/public/cashback-preview',
    rateLimit('GET /api/public/cashback-preview', 60, 60_000),
    publicCashbackPreviewHandler,
  );

  // LOOP-asset transparency surface (ADR 015 / 020). Public list
  // of configured (code, issuer) pairs so third-party wallets +
  // users can add trustlines to the verified issuer accounts
  // without guessing from on-chain traffic.
  app.get(
    '/api/public/loop-assets',
    rateLimit('GET /api/public/loop-assets', 60, 60_000),
    publicLoopAssetsHandler,
  );

  // Marketing flywheel scalar — % of fulfilled orders in the last
  // 30 days paid via LOOP-asset cashback. Complement to
  // /api/public/cashback-stats (emission) with the recycle side
  // of the story. Never-500; 300s cache on happy path, 60s on
  // fallback.
  app.get(
    '/api/public/flywheel-stats',
    rateLimit('GET /api/public/flywheel-stats', 60, 60_000),
    publicFlywheelStatsHandler,
  );
}
