/**
 * `/api/merchants/*` route mounts. Pulled out of `app.ts` as the
 * third per-domain route module after `routes/public.ts` and
 * `routes/misc.ts`.
 *
 * The merchant catalog is mostly unauthenticated reads (catalog
 * listing, slug lookup, cashback-rate previews) plus one
 * authenticated detail endpoint that reaches upstream to CTX for
 * the long-form content. Hono's router resolves routes in
 * registration order, so the **mount order matters**:
 *
 * 1. Static literal paths (`/all`, `/cashback-rates`) BEFORE
 *    parameterised paths (`/:id`, `/:merchantId/...`) so Hono
 *    matches the literal instead of treating the constant as a
 *    path param.
 * 2. `/by-slug/:slug` before `/:id` for the same reason.
 * 3. `requireAuth` on `/:id` BEFORE the `/:id` GET handler so the
 *    upstream-CTX-enriched detail read is gated.
 *
 * Per-route rate-limit rationale (audit A2-650 / A2-1008) is
 * preserved in the comments next to each mount: 60/min for the
 * full-catalog `/all` (legitimate clients fetch once + cache),
 * 120/min for individual reads + cashback previews, 180/min for
 * paginated `/api/merchants` (filter/page-change burst).
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import {
  merchantListHandler,
  merchantAllHandler,
  merchantBySlugHandler,
  merchantCashbackRateHandler,
  merchantDetailHandler,
  merchantsCashbackRatesHandler,
} from '../merchants/handler.js';
import { requireAuth } from '../auth/handler.js';

/** Mounts all `/api/merchants/*` routes on the supplied Hono app. */
export function mountMerchantRoutes(app: Hono): void {
  // A2-650: the list + by-slug + /all reads were previously
  // unlimited — a crawler or misbehaved client could burst them
  // without ever hitting a 429. Per-IP limits sized for realistic
  // browse patterns: paginated list comfortably covers a fast
  // typist + rapid pagination at 180/min; full-catalog /all is
  // 60/min because legitimate clients fetch it once and cache;
  // by-slug at 120/min matches the sibling cashback-rate
  // endpoints.
  app.get('/api/merchants', rateLimit(180, 60_000), merchantListHandler);

  // /all must come BEFORE /:id so 'all' is not interpreted as an id.
  app.get('/api/merchants/all', rateLimit(60, 60_000), merchantAllHandler);
  // /by-slug/:slug before /:id for the same reason.
  app.get('/api/merchants/by-slug/:slug', rateLimit(120, 60_000), merchantBySlugHandler);

  // GET /api/merchants/cashback-rates — bulk map of active
  // cashback pcts across every merchant (ADR 011 / 015). Lets
  // catalog / list / map views render "X% cashback" badges
  // without N+1-ing the per-merchant endpoint. Static literal
  // path — must come BEFORE the `/:merchantId/cashback-rate`
  // route so Hono's router matches the literal instead of
  // treating "cashback-rates" as a path param.
  app.get('/api/merchants/cashback-rates', rateLimit(120, 60_000), merchantsCashbackRatesHandler);

  // GET /api/merchants/:merchantId/cashback-rate — public
  // cashback-rate preview for rendering "Earn X% cashback" on
  // the gift-card detail page (ADR 011 / 015). Registered BEFORE
  // the requireAuth gate on /:id so the checkout page can query
  // it without a bearer. 120/min matches the other merchant
  // reads.
  app.get(
    '/api/merchants/:merchantId/cashback-rate',
    rateLimit(120, 60_000),
    merchantCashbackRateHandler,
  );

  // Authenticated — the handler calls CTX /merchants/:id with the
  // user's bearer + X-Client-Id to enrich the cached merchant
  // with long-form content (description / longDescription /
  // terms / instructions). Unauthed callers still see the basic
  // cached merchant via by-slug.
  app.use('/api/merchants/:id', requireAuth);

  // A2-1008: the single authed merchant-detail route was the only
  // authed GET with no rate limit. The handler fires a CTX
  // upstream fetch on every call — a runaway client (or a
  // compromised bearer driving the endpoint in a loop) would pin
  // an upstream circuit + burn CTX quota without any local
  // backpressure. 120/min per IP matches the other merchant
  // reads and is well above a logged-in user's realistic browse
  // rate.
  app.get('/api/merchants/:id', rateLimit(120, 60_000), merchantDetailHandler);
}
