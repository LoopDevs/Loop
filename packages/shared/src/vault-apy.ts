/**
 * `GET /api/me/vault-apy` wire shapes (ADR 031 §Detailed design D8 /
 * §User-facing display, V5b).
 *
 * The three LOOP-branded yield assets, one response shape each:
 * LOOPUSD/LOOPEUR (DeFindex vault shares — APY from
 * `vault_share_price_snapshots` history) and GBPLOOP (classic
 * 1:1-backed asset — APY realised from `interest_mint_snapshots` mint
 * history). Deliberately its own asset-code union rather than reusing
 * `LoopAssetCode` from `./loop-asset.js`: that union still carries the
 * pre-ADR-031-v7 `USDLOOP`/`EURLOOP` names (the payout/interest-mint
 * code hasn't been renamed yet — see `credits/interest-mint.ts`'s
 * `ONCHAIN_MINT_ELIGIBLE_ASSETS` comment), while the vault registry
 * (migration 0060) already uses the current `LOOPUSD`/`LOOPEUR` names.
 * This endpoint is vault-APY-specific and always speaks the current
 * names.
 *
 * ADR 031 §User-facing display: "No yield-source / strategy disclosure
 * to users." This shape is intentionally numbers + a disclaimer key
 * only — nothing here, and nothing any handler building this response
 * emits (including error paths), may ever mention the vault mechanism
 * (DeFindex / Blend / Soroban / "vault" / "strategy").
 */

/** The three LOOP-branded yield assets (ADR 031 §Decision) — current naming. */
export type VaultApyAssetCode = 'LOOPUSD' | 'LOOPEUR' | 'GBPLOOP';

/**
 * One asset's APY figures. Both fields are `null` — never a fabricated
 * or divide-by-zero number — when there isn't yet enough snapshot/mint
 * history to compute a meaningful figure (ADR 031 §D8: fewer than two
 * samples, or the oldest sample is under the window's minimum age).
 */
export interface VaultApyAsset {
  assetCode: VaultApyAssetCode;
  /**
   * Past-30-day realised APY as a decimal fraction (e.g. `0.0312` =
   * 3.12%). `null` when there isn't at least 30 days of history yet.
   */
  past30dApy: number | null;
  /**
   * Min/max of the realised APY observed over the past 90 days, same
   * decimal-fraction convention as `past30dApy`. `null` under the same
   * insufficient-history rule.
   */
  past90dRange: { minApy: number; maxApy: number } | null;
}

/** `GET /api/me/vault-apy` */
export interface VaultApyResponse {
  /**
   * One entry per asset this deployment can actually pay APY on right
   * now (an active vault registered for LOOPUSD/LOOPEUR; a configured
   * on-chain-mint-eligible GBPLOOP issuer) — never a placeholder entry
   * for an asset this deployment doesn't have. Empty when the vault
   * subsystem is disabled and no on-chain GBPLOOP interest path is
   * configured either.
   */
  assets: VaultApyAsset[];
  /**
   * i18n lookup key for the always-visible "past performance doesn't
   * guarantee future returns" disclaimer (ADR 031 §User-facing
   * display) — never the disclaimer text itself, so a copy change
   * doesn't need a backend deploy.
   */
  disclaimerKey: string;
}
