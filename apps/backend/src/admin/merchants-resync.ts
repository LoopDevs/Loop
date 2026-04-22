/**
 * Admin manual merchant-cache resync (ADR 011).
 *
 * `POST /api/admin/merchants/resync` — forces an immediate
 * `refreshMerchants()` against the upstream CTX catalog, replacing
 * the in-memory store. Background scheduling runs every
 * `REFRESH_INTERVAL_HOURS` (default 6h); this endpoint lets ops
 * push a catalog change to production within seconds when CTX has
 * added a merchant, changed denominations, or flipped a disabled
 * flag and we don't want to wait for the next tick.
 *
 * The underlying `refreshMerchants()` is mutex-guarded — concurrent
 * callers coalesce into a single upstream sweep. Two admins clicking
 * the button at the same second trigger one sync, not two. The
 * handler awaits the in-flight promise and reports the resulting
 * store snapshot either way.
 */
import type { Context } from 'hono';
import { getMerchants, refreshMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-merchants-resync' });

export interface AdminMerchantResyncResponse {
  /** Merchant count in the store after the resync completes. */
  merchantCount: number;
  /** ISO timestamp of when the store was last refreshed. */
  loadedAt: string;
  /** Whether the handler triggered a new sync or coalesced into one already in flight. */
  triggered: boolean;
}

/** POST /api/admin/merchants/resync */
export async function adminMerchantsResyncHandler(c: Context): Promise<Response> {
  const beforeLoadedAt = getMerchants().loadedAt;
  try {
    await refreshMerchants();
  } catch (err) {
    log.error({ err }, 'Admin-triggered merchant resync failed');
    return c.json(
      { code: 'UPSTREAM_ERROR', message: 'Merchant catalog refresh failed; check logs' },
      502,
    );
  }
  const store = getMerchants();
  // If `loadedAt` hasn't advanced, we coalesced with an already-running
  // sync (the mutex inside refreshMerchants() fast-returns). Tell the
  // caller so the admin UI can distinguish "fresh dump" vs "your click
  // joined the previous click's run".
  const triggered = store.loadedAt > beforeLoadedAt;
  log.info(
    { merchantCount: store.merchants.length, triggered, loadedAt: store.loadedAt },
    'Admin merchant resync completed',
  );
  return c.json<AdminMerchantResyncResponse>({
    merchantCount: store.merchants.length,
    loadedAt: new Date(store.loadedAt).toISOString(),
    triggered,
  });
}
