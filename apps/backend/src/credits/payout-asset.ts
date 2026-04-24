/**
 * Cashback payout-asset mapping (ADR 015).
 *
 * A user's home currency decides which LOOP-branded Stellar asset
 * their cashback is paid in:
 *
 *   USD → USDLOOP
 *   GBP → GBPLOOP
 *   EUR → EURLOOP
 *
 * The map is static and 1:1 with the HomeCurrency union; anything
 * new currencies-wise (JPYLOOP later, say) is a schema update
 * alongside the `users.home_currency` CHECK constraint — TypeScript
 * will refuse to compile until this module is updated in lockstep.
 *
 * Each asset is identified on Stellar by its 4-12 char code plus its
 * issuer public key. Issuers come from env at boot; absent → the
 * asset is considered "not configured" and callers (the payout
 * worker) MUST gracefully degrade to off-chain-only cashback rather
 * than throw, so a partially-configured deployment can still
 * fulfill orders for users whose currency IS configured.
 */
import { env } from '../env.js';
import {
  HOME_CURRENCIES,
  LOOP_ASSET_CODES,
  loopAssetForCurrency,
  type HomeCurrency,
  type LoopAssetCode,
} from '@loop/shared';

// Re-export the type + codes so existing backend imports (`from
// '../credits/payout-asset.js'`) keep resolving. Shared module is
// the new source of truth.
export { LOOP_ASSET_CODES, type LoopAssetCode };

/**
 * Resolved payout asset — the code is always present (the map is
 * exhaustive), the issuer is present iff the operator has
 * configured the matching `LOOP_STELLAR_{code}_ISSUER` env var.
 */
export interface PayoutAsset {
  code: LoopAssetCode;
  issuer: string | null;
}

/**
 * Resolves the user's payout asset. Pure — no I/O beyond the env
 * read that already happened at boot. Callers use `issuer === null`
 * as the "skip the Stellar-side payout" signal.
 */
export function payoutAssetFor(homeCurrency: HomeCurrency): PayoutAsset {
  // A2-812: prefer the shared helper over the direct map access so
  // the backend tracks any future logic `loopAssetForCurrency` picks
  // up (e.g. promo-asset overrides, per-region mapping).
  const code = loopAssetForCurrency(homeCurrency);
  const issuer = issuerFor(code);
  return { code, issuer };
}

function issuerFor(code: LoopAssetCode): string | null {
  switch (code) {
    case 'USDLOOP':
      return env.LOOP_STELLAR_USDLOOP_ISSUER ?? null;
    case 'GBPLOOP':
      return env.LOOP_STELLAR_GBPLOOP_ISSUER ?? null;
    case 'EURLOOP':
      return env.LOOP_STELLAR_EURLOOP_ISSUER ?? null;
  }
}

/**
 * Watcher allowlist helper (ADR 015): the full set of `{code, issuer}`
 * pairs the payment watcher should accept as an inbound-from-user
 * payment. Skips entries whose issuer isn't configured because we
 * can't sanely asset-match a LOOP asset without pinning its issuer —
 * an attacker could issue a fake "USDLOOP" asset from a different
 * account otherwise.
 */
export function configuredLoopPayableAssets(): ReadonlyArray<{
  code: LoopAssetCode;
  issuer: string;
}> {
  const out: { code: LoopAssetCode; issuer: string }[] = [];
  for (const currency of HOME_CURRENCIES) {
    const resolved = payoutAssetFor(currency);
    if (resolved.issuer !== null) {
      out.push({ code: resolved.code, issuer: resolved.issuer });
    }
  }
  return out;
}
