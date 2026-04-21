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
import { HOME_CURRENCIES, type HomeCurrency } from '../db/schema.js';

/**
 * The four-letter LOOP asset codes. Kept as a `const` union rather
 * than a Zod enum because Stellar's asset-code format is trivially
 * fixed (4-12 alphanumeric chars) and the three codes are exhaustive
 * — exported for tests and the watcher's asset-match allowlist.
 */
export const LOOP_ASSET_CODES = ['USDLOOP', 'GBPLOOP', 'EURLOOP'] as const;
export type LoopAssetCode = (typeof LOOP_ASSET_CODES)[number];

const CURRENCY_TO_ASSET_CODE: Record<HomeCurrency, LoopAssetCode> = {
  USD: 'USDLOOP',
  GBP: 'GBPLOOP',
  EUR: 'EURLOOP',
};

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
  const code = CURRENCY_TO_ASSET_CODE[homeCurrency];
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
