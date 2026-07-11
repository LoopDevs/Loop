import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LoopAssetCode, VaultApyAssetCode } from '@loop/shared';
import { useVaultApy } from '~/hooks/use-vault-apy';

/**
 * Maps the wallet-balance surface's legacy Stellar asset-code naming
 * (`USDLOOP` / `GBPLOOP` / `EURLOOP` — `LoopAssetCode`, the codes
 * `GET /api/me/wallet` actually returns today) to the vault-APY
 * endpoint's current LOOP-branded naming (`LOOPUSD` / `LOOPEUR` /
 * `GBPLOOP` — `VaultApyAssetCode`, `GET /api/me/vault-apy`).
 *
 * ADR 031 v7 renamed the USD/EUR vault-share assets from USDLOOP/
 * EURLOOP to LOOPUSD/LOOPEUR; the payout/wallet-balance path hasn't
 * been renamed yet (see `packages/shared/src/vault-apy.ts`'s file
 * header + `credits/interest-mint.ts`'s `ONCHAIN_MINT_ELIGIBLE_ASSETS`
 * comment on the backend). GBPLOOP is unchanged in both namings. This
 * is a display-only join between two independently-versioned wire
 * shapes, not a business-logic mapping — it stays local to the web
 * layer (not `@loop/shared`) and should be deleted once the backend
 * rename lands and both surfaces speak the same asset-code union.
 */
const WALLET_TO_VAULT_APY_CODE: Record<LoopAssetCode, VaultApyAssetCode> = {
  USDLOOP: 'LOOPUSD',
  GBPLOOP: 'GBPLOOP',
  EURLOOP: 'LOOPEUR',
};

/** Decimal fraction (`0.0312`) → trimmed percent string (`"3.12"`). */
export function fmtApyPercent(apy: number): string {
  return String(Number((apy * 100).toFixed(2)));
}

/**
 * Past-30-day APY line + one-tap detail for a single LOOP-branded
 * wallet balance row (ADR 031 §User-facing display, V6). Renders
 * directly under the balance amount `WalletCard` already shows for
 * this row — this component adds only the yield figures, never the
 * value itself (ADR 031: `share_balance × current_share_price`,
 * already reflected in the wallet balance this row is attached to).
 *
 * Self-gating, same discipline as `WalletCard` / `LinkWalletNudge`:
 * renders nothing while the vault-APY query hasn't resolved data yet,
 * on error, or (via `useVaultApy`'s own gate) while signed out or
 * `LOOP_PHASE_1_ONLY` is on — the whole vault-APY surface is dark in
 * Phase 1. Also renders nothing when this deployment has no APY entry
 * for this asset, or when there isn't yet 30 days of history
 * (`past30dApy === null`) — the balance above still shows; we never
 * fabricate a "0%" figure.
 *
 * ⚠️ ADR 031: never render the yield SOURCE (DeFindex / Blend /
 * Soroban / "vault" / "strategy") — only Loop-branded numbers and the
 * disclaimer. Nothing below may ever add that vocabulary.
 */
export function VaultApyRow({ assetCode }: { assetCode: LoopAssetCode }): React.JSX.Element | null {
  const { t } = useTranslation('wallet');
  const [expanded, setExpanded] = useState(false);
  const { vaultApy, isLoading, isError } = useVaultApy();

  if (isLoading || isError || vaultApy === undefined) return null;

  const vaultCode = WALLET_TO_VAULT_APY_CODE[assetCode];
  const entry = vaultApy.assets.find((a) => a.assetCode === vaultCode);
  if (entry === undefined || entry.past30dApy === null) return null;

  const apyPct = fmtApyPercent(entry.past30dApy);

  return (
    <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">
      <p>
        {t('apy.headline', { apy: apyPct })}{' '}
        <span className="text-gray-400 dark:text-gray-500">{t('apy.disclaimer')}</span>
      </p>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="mt-0.5 font-medium text-gray-500 underline decoration-dotted underline-offset-2 dark:text-gray-400"
      >
        {expanded ? t('apy.hideDetails') : t('apy.showDetails')}
      </button>
      {expanded ? (
        <p className="mt-1 text-gray-600 dark:text-gray-400">
          {entry.past90dRange !== null
            ? t('apy.detailWithRange', {
                apy: apyPct,
                min: fmtApyPercent(entry.past90dRange.minApy),
                max: fmtApyPercent(entry.past90dRange.maxApy),
              })
            : t('apy.detailNoRange', { apy: apyPct })}
        </p>
      ) : null}
    </div>
  );
}
