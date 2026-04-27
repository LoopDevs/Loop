/**
 * Public merchant-cashback-rate handlers (ADR 011 / 015).
 *
 * Lifted out of `./handler.ts` so the merchants module separates
 * two distinct concerns:
 *
 *   - `handler.ts` — upstream-CTX catalog surface (list / all /
 *     by-slug / detail). All reads come from the in-memory sync
 *     cache, with the detail handler optionally enriching via a
 *     `GET /merchants/{id}` upstream proxy.
 *   - `cashback-rate-handlers.ts` — Loop-internal cashback config
 *     reads from `merchant_cashback_configs`. ADR-020 never-500
 *     surface: a DB outage degrades to "no cashback" (empty map /
 *     null rate) rather than 500-ing the public catalog page.
 *
 * Two handlers in this slice:
 *   - `GET /api/merchants/cashback-rates` → `merchantsCashbackRatesHandler`
 *   - `GET /api/merchants/{merchantId}/cashback-rate` → `merchantCashbackRateHandler`
 *
 * Re-exported from `./handler.ts` so `routes/merchants.ts` and the
 * existing test suite keep importing from the historical path.
 */
import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { merchantCashbackConfigs } from '../db/schema.js';
import { logger } from '../logger.js';
import { getMerchants } from './sync.js';

const log = logger.child({ handler: 'merchants' });

/**
 * `GET /api/merchants/cashback-rates` — public bulk map of
 * `{ merchantId → userCashbackPct }` for every active config
 * (ADR 011 / 015). Lets catalog / list / map views render a
 * cashback badge on each card without N+1-ing the per-merchant
 * endpoint. Merchants without an active config are omitted (the
 * client should treat a missing key as "no cashback" and hide the
 * badge). Values are `numeric(5,2)` strings, same as the per-
 * merchant endpoint.
 *
 * 5-minute public Cache-Control matches the merchant-catalog
 * endpoints — admin cashback edits are rare and the stale window
 * is acceptable.
 */
export async function merchantsCashbackRatesHandler(c: Context): Promise<Response> {
  // A2-664 / A2-1006 — ADR-020 never-500. A DB outage here previously
  // bubbled out as an uncaught 500, breaking every merchant-list card
  // on the client. Soft-fail to an empty `{ rates: {} }` (clients treat
  // missing keys as "no cashback") with a shorter cache window so we
  // don't pin the degraded answer for long.
  let rows: Array<{ merchantId: string; userCashbackPct: string }>;
  try {
    rows = await db
      .select({
        merchantId: merchantCashbackConfigs.merchantId,
        userCashbackPct: merchantCashbackConfigs.userCashbackPct,
      })
      .from(merchantCashbackConfigs)
      .where(eq(merchantCashbackConfigs.active, true));
  } catch (err) {
    log.warn({ err }, 'merchant-cashback-rates DB read failed — serving empty');
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ rates: {} });
  }

  // Map-shaped response — the frontend converts to a `Map` once
  // and does O(1) lookups per merchant card. Plain object (not
  // a tuple array) so the JSON is human-readable in devtools.
  const rates: Record<string, string> = {};
  for (const row of rows) {
    rates[row.merchantId] = row.userCashbackPct;
  }

  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ rates });
}

/**
 * `GET /api/merchants/:merchantId/cashback-rate` — public surface
 * for rendering "Earn X% cashback" on the gift-card detail page
 * before checkout (ADR 011 / 015). Reads the active `user_cashback_pct`
 * from `merchant_cashback_configs`; when the merchant has no config
 * (admin hasn't configured it) or the config is inactive, returns
 * `{ userCashbackPct: null }` so the client can hide the badge rather
 * than show an implausible "0% cashback" message.
 *
 * The response is safe to cache publicly (5 min) — admins rarely
 * change cashback rates, and the stale window here is the same as
 * the merchant list endpoint.
 */
export async function merchantCashbackRateHandler(c: Context): Promise<Response> {
  const id = c.req.param('merchantId') ?? '';
  // Tight character class — matches the detail handler's input
  // validation. CTX merchant IDs are slug-shaped; anything else is a
  // scan attempt.
  if (!/^[\w-]+$/.test(id)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid merchant ID' }, 400);
  }

  // Merchant-catalog guard: keep the endpoint honest — a caller can't
  // enumerate configs for ids that don't correspond to a real merchant.
  const { merchantsById } = getMerchants();
  if (!merchantsById.has(id)) {
    return c.json({ code: 'NOT_FOUND', message: 'Merchant not found' }, 404);
  }

  // A2-665 — ADR-020 never-500. DB outage ⇒ `{ userCashbackPct: null }`
  // (same shape the no-active-config branch returns); client hides the
  // badge rather than showing a 500 on a public, CDN-cached path.
  let row: { userCashbackPct: string } | undefined;
  try {
    row = await db.query.merchantCashbackConfigs.findFirst({
      where: and(
        eq(merchantCashbackConfigs.merchantId, id),
        eq(merchantCashbackConfigs.active, true),
      ),
    });
  } catch (err) {
    log.warn({ err, merchantId: id }, 'merchant-cashback-rate DB read failed — serving null');
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ merchantId: id, userCashbackPct: null });
  }

  c.header('Cache-Control', 'public, max-age=300');
  return c.json({
    merchantId: id,
    userCashbackPct: row?.userCashbackPct ?? null,
  });
}
