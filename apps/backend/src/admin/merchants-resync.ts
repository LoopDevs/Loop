/**
 * Admin manual merchant-catalog resync (ADR 011).
 *
 * `POST /api/admin/merchants/resync` — forces an immediate sweep of
 * the upstream CTX catalog so ops can apply a merchant change (new
 * store, denomination tweak, disabled flag flip) within seconds
 * instead of waiting for the 6h scheduled refresh. The in-memory
 * merchant cache is atomically swapped once the new snapshot is
 * fully built.
 *
 * Rate-limited tightly (2/min) because every hit goes to CTX —
 * this is a manual override, not a polled surface. Two admins
 * clicking the button simultaneously coalesce into a single
 * upstream sweep via the existing mutex inside `refreshMerchants`;
 * one sees `triggered: true`, the other `triggered: false` with
 * the same post-sync `loadedAt`.
 *
 * 502 on upstream failure, not 500 — it's a CTX problem, not a
 * backend bug. The cached snapshot is retained (not zeroed) on
 * failure so the `/api/merchants` surface keeps serving prior data.
 */
import type { Context } from 'hono';
import { forceRefreshMerchants, getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-merchants-resync' });

export interface AdminMerchantResyncResponse {
  /** Post-sync merchant count — snapshot-total, not delta vs. pre-sync. */
  merchantCount: number;
  /** ISO-8601 timestamp of the currently-loaded snapshot. */
  loadedAt: string;
  /** Whether THIS call advanced the store. `false` means another sweep was already in flight and this call coalesced. */
  triggered: boolean;
}

export async function adminMerchantsResyncHandler(c: Context): Promise<Response> {
  try {
    const outcome = await forceRefreshMerchants();
    const store = getMerchants();
    const body: AdminMerchantResyncResponse = {
      merchantCount: store.merchants.length,
      loadedAt: new Date(store.loadedAt).toISOString(),
      triggered: outcome.triggered,
    };
    return c.json(body);
  } catch (err) {
    log.error({ err }, 'Admin merchant-catalog resync failed');
    return c.json(
      {
        code: 'UPSTREAM_ERROR',
        message: 'Failed to refresh merchant catalog from upstream',
      },
      502,
    );
  }
}
