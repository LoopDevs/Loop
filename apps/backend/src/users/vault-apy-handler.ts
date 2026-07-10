/**
 * `GET /api/me/vault-apy` — past-30-day / past-90-day APY surface for
 * the three LOOP-branded yield assets (ADR 031 §Detailed design D8 /
 * §User-facing display, V5b).
 *
 * All computation is delegated to `credits/vaults/vault-apy.ts`
 * (pure DB reads + math, no Soroban call at request time — the vault
 * APY snapshot cron does the only Soroban read in this path,
 * ahead of time). This handler's job is narrow: resolve the caller,
 * decide WHICH assets this deployment can actually pay APY on right
 * now, and assemble the response.
 *
 * ⚠️ ADR 031 §User-facing display: "No yield-source / strategy
 * disclosure to users." Nothing this handler emits — including every
 * error path — may ever mention the vault mechanism (DeFindex / Blend
 * / Soroban / "vault" / "strategy"). The response carries only asset
 * codes (LOOPUSD/LOOPEUR/GBPLOOP — Loop-branded product names, not
 * mechanism names), numbers, and a disclaimer i18n key.
 */
import type { Context } from 'hono';
import { env } from '../env.js';
import { logger } from '../logger.js';
import type { VaultApyAsset, VaultApyResponse } from '@loop/shared';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { configuredLoopPayableAssets } from '../credits/payout-asset.js';
import { ONCHAIN_MINT_ELIGIBLE_ASSETS } from '../credits/interest-mint.js';
import { computeGbploopApy, listVaultApyAssets } from '../credits/vaults/vault-apy.js';

const log = logger.child({ handler: 'me-vault-apy' });

/** i18n lookup key for the always-visible disclaimer (ADR 031 §User-facing display) — text lives client-side, never here. */
const APY_DISCLAIMER_KEY = 'wallet.apyDisclaimer';

export async function getVaultApyHandler(c: Context): Promise<Response> {
  let user;
  try {
    user = await resolveLoopAuthenticatedUser(c);
  } catch (err) {
    log.error({ err }, 'Failed to resolve calling user');
    return c.json({ code: 'SERVICE_UNAVAILABLE', message: 'Wallet temporarily unavailable' }, 503);
  }
  if (user === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  try {
    const assets: VaultApyAsset[] = [];

    // LOOPUSD / LOOPEUR — empty when LOOP_VAULTS_ENABLED is false or
    // no vault is registered active on the live network
    // (`listVaultApyAssets` already gates on `vaultsEnabled()`).
    for (const v of await listVaultApyAssets()) {
      assets.push({
        assetCode: v.assetCode,
        past30dApy: v.apy.past30dApy,
        past90dRange: v.apy.past90dRange,
      });
    }

    // GBPLOOP — same truthfulness gate `wallet-handler.ts` uses for
    // `interestApyBps`: only advertise it when the on-chain mint path
    // is actually live for THIS deployment's configured assets.
    const payableAssets = configuredLoopPayableAssets();
    const hasEligibleGbploop = payableAssets.some((a) => ONCHAIN_MINT_ELIGIBLE_ASSETS.has(a.code));
    if (env.LOOP_INTEREST_ONCHAIN_ENABLED && hasEligibleGbploop) {
      const apy = await computeGbploopApy();
      assets.push({
        assetCode: 'GBPLOOP',
        past30dApy: apy.past30dApy,
        past90dRange: apy.past90dRange,
      });
    }

    return c.json<VaultApyResponse>({ assets, disclaimerKey: APY_DISCLAIMER_KEY });
  } catch (err) {
    log.error({ err, userId: user.id }, 'Failed to compute vault APY');
    return c.json({ code: 'SERVICE_UNAVAILABLE', message: 'APY temporarily unavailable' }, 503);
  }
}
