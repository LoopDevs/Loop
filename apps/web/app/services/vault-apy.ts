/**
 * Vault-APY API (ADR 031 §Detailed design D8 / §User-facing display, V6).
 *
 * Thin wrapper over `GET /api/me/vault-apy` — the past-30-day realised
 * APY (+ past-90-day range) for whichever LOOP-branded yield assets
 * (`LOOPUSD` / `LOOPEUR` / `GBPLOOP`) this deployment can currently pay
 * APY on. Wire shape lives in `@loop/shared/vault-apy.ts` (ADR 019), one
 * definition shared with the backend handler.
 *
 * ⚠️ ADR 031 §User-facing display: "No yield-source / strategy
 * disclosure to users." Never add a field or log line here that
 * surfaces the yield mechanism (DeFindex / Blend / Soroban / "vault" /
 * "strategy") — the response is numbers + an i18n disclaimer key only.
 */
import type { VaultApyAsset, VaultApyAssetCode, VaultApyResponse } from '@loop/shared';
import { authenticatedRequest } from './api-client';

export type { VaultApyAsset, VaultApyAssetCode, VaultApyResponse };

/**
 * `GET /api/me/vault-apy` — past-30d/90d APY per LOOP-branded yield
 * asset this deployment can currently pay APY on. Auth required;
 * `useVaultApy` is the caller-facing seam (auth- and
 * `LOOP_PHASE_1_ONLY`-gated) — don't call this directly from a
 * component.
 */
export async function getVaultApy(): Promise<VaultApyResponse> {
  return authenticatedRequest<VaultApyResponse>('/api/me/vault-apy');
}
