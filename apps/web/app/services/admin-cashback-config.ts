/**
 * A2-1165 (slice 20): admin cashback-config surface extracted
 * from `services/admin.ts`. Four endpoints around the per-
 * merchant cashback-split config (ADR 011 / 017). The split is
 * the central knob the admin panel exists to turn:
 * `wholesale_pct + user_cashback_pct + loop_margin_pct = 100`.
 *
 * - `GET /api/admin/merchant-cashback-configs` — fleet list.
 * - `PUT /api/admin/merchant-cashback-configs/:merchantId` —
 *   ADR 017 admin write. Caller supplies the split + a 2..500
 *   char reason; the service generates a per-click
 *   `Idempotency-Key` so a double-submit of the form can't
 *   apply the edit twice. Response is the `{ result, audit }`
 *   envelope from slice 16.
 * - `GET /api/admin/merchant-cashback-configs/:merchantId/history`
 *   — per-merchant history. Drives the audit-trail card on the
 *   merchant-detail page.
 * - `GET /api/admin/merchant-cashback-configs/history` —
 *   newest-first fleet-wide feed. Drives the "recent config
 *   changes" card on the admin dashboard. Each row carries
 *   `merchantName` because the backend joins against the catalog
 *   so the UI doesn't re-fetch every merchant to render the
 *   strip.
 *
 * The 4 inline shapes (`MerchantCashbackConfig`,
 * `MerchantCashbackConfigHistoryEntry`, `AdminConfigHistoryEntry`,
 * `AdminConfigHistoryResponse`) move with the functions — no
 * other consumers, so promoting them to `@loop/shared` would
 * just add indirection. `services/admin.ts` keeps a barrel
 * re-export so existing consumers (`MerchantConfigEditor.tsx`,
 * `ConfigHistoryStrip.tsx`, `routes/admin.merchants.$merchantId.tsx`,
 * paired tests) don't have to re-target imports.
 */
import type { AdminWriteEnvelope } from './admin-write-envelope';
import { authenticatedRequest } from './api-client';

export interface MerchantCashbackConfig {
  merchantId: string;
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  active: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface MerchantCashbackConfigHistoryEntry {
  id: string;
  merchantId: string;
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  active: boolean;
  changedBy: string;
  changedAt: string;
}

/**
 * One row from the fleet-wide config-history feed. Extends the
 * per-merchant history row with a resolved display name — the
 * backend joins against the catalog so the admin UI doesn't
 * re-fetch every merchant to render the strip.
 */
export interface AdminConfigHistoryEntry {
  id: string;
  merchantId: string;
  merchantName: string;
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  active: boolean;
  changedBy: string;
  changedAt: string;
}

export interface AdminConfigHistoryResponse {
  history: AdminConfigHistoryEntry[];
}

/** `GET /api/admin/merchant-cashback-configs` — fleet list. */
export async function listCashbackConfigs(): Promise<{ configs: MerchantCashbackConfig[] }> {
  return authenticatedRequest<{ configs: MerchantCashbackConfig[] }>(
    '/api/admin/merchant-cashback-configs',
  );
}

/**
 * `PUT /api/admin/merchant-cashback-configs/:merchantId` — ADR 017
 * admin write. Service generates a per-click `Idempotency-Key` so
 * a double-submit of the form can't apply the edit twice; response
 * is the standard `{ result, audit }` envelope.
 */
export async function upsertCashbackConfig(
  merchantId: string,
  body: {
    wholesalePct: number;
    userCashbackPct: number;
    loopMarginPct: number;
    active?: boolean;
    reason: string;
  },
): Promise<AdminWriteEnvelope<MerchantCashbackConfig>> {
  const idempotencyKey =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return authenticatedRequest<AdminWriteEnvelope<MerchantCashbackConfig>>(
    `/api/admin/merchant-cashback-configs/${encodeURIComponent(merchantId)}`,
    {
      method: 'PUT',
      headers: { 'Idempotency-Key': idempotencyKey },
      body,
    },
  );
}

/** `GET /api/admin/merchant-cashback-configs/:merchantId/history` — per-merchant audit-trail. */
export async function cashbackConfigHistory(
  merchantId: string,
): Promise<{ history: MerchantCashbackConfigHistoryEntry[] }> {
  return authenticatedRequest<{ history: MerchantCashbackConfigHistoryEntry[] }>(
    `/api/admin/merchant-cashback-configs/${encodeURIComponent(merchantId)}/history`,
  );
}

/**
 * `GET /api/admin/merchant-cashback-configs/history` — newest-first
 * fleet-wide feed of cashback-config edits. Drives the "recent config
 * changes" card on the admin dashboard; complements the per-merchant
 * `cashbackConfigHistory(merchantId)` drill.
 */
export async function getAdminConfigsHistory(
  opts: { limit?: number } = {},
): Promise<AdminConfigHistoryResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<AdminConfigHistoryResponse>(
    `/api/admin/merchant-cashback-configs/history${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
