/**
 * Per-asset issuer signing keys (ADR 031 / ADR 036 Phase D).
 *
 * On Stellar, a payment FROM an asset's issuer account is a native
 * mint — there is no separate "mint" operation. The nightly
 * interest-mint worker therefore enqueues `pending_payouts` rows
 * with `kind='interest_mint'` whose source must be the ISSUER
 * account, not the operator account every other payout kind signs
 * with. This module resolves the configured
 * `LOOP_STELLAR_<ASSET>_ISSUER_SECRET` env vars into a map the
 * payout worker threads through `payOne` for per-row keypair
 * selection.
 *
 * Validation discipline: `parseEnv` already boot-fails when a
 * secret is set without its issuer address or when the derived
 * public key mismatches the configured `LOOP_STELLAR_<ASSET>_ISSUER`
 * (signing a "mint" with a non-issuer key would be a transfer from
 * an unrelated account). The derivation here re-asserts the same
 * invariant as defence-in-depth for test environments that mock
 * `env.js` inconsistently — a mismatch throws rather than returning
 * a poisoned signer.
 *
 * Resolution is cached per process (env is boot-pinned); tests can
 * reset via `__resetIssuerSignersForTests`.
 */
import { Keypair } from '@stellar/stellar-sdk';
import { env } from '../env.js';
import type { LoopAssetCode } from '@loop/shared';

export interface IssuerSigner {
  /** The asset's issuer secret key (`S...`). Never logged. */
  secret: string;
  /**
   * The issuer account public key derived from `secret` — by
   * construction equal to the configured
   * `LOOP_STELLAR_<ASSET>_ISSUER`. Used both for signing-source
   * selection and the Horizon idempotency pre-check (the prior-mint
   * scan must run against the account that signs).
   */
  account: string;
}

let cached: ReadonlyMap<LoopAssetCode, IssuerSigner> | null = null;

/** Test seam: forces re-derivation after a test mutates the env mock. */
export function __resetIssuerSignersForTests(): void {
  cached = null;
}

function entryFor(
  code: LoopAssetCode,
  issuerAddress: string | undefined,
  issuerSecret: string | undefined,
): IssuerSigner | null {
  if (issuerSecret === undefined) return null;
  if (issuerAddress === undefined) {
    throw new Error(
      `LOOP_STELLAR_${code}_ISSUER_SECRET is set without LOOP_STELLAR_${code}_ISSUER — ` +
        `cannot validate the issuer keypair (ADR 031)`,
    );
  }
  const account = Keypair.fromSecret(issuerSecret).publicKey();
  if (account !== issuerAddress) {
    throw new Error(
      `LOOP_STELLAR_${code}_ISSUER_SECRET derives ${account}, which does not match ` +
        `LOOP_STELLAR_${code}_ISSUER (${issuerAddress}) — refusing to build an issuer signer (ADR 031)`,
    );
  }
  return { secret: issuerSecret, account };
}

/**
 * Resolves every configured issuer signer, keyed by LOOP asset code.
 * Empty map when no issuer secrets are configured — the interest-mint
 * worker treats that as "on-chain minting not yet wired" and the
 * payout worker leaves any `interest_mint` rows pending.
 */
export function resolveIssuerSigners(): ReadonlyMap<LoopAssetCode, IssuerSigner> {
  if (cached !== null) return cached;
  const out = new Map<LoopAssetCode, IssuerSigner>();
  const usd = entryFor(
    'USDLOOP',
    env.LOOP_STELLAR_USDLOOP_ISSUER,
    env.LOOP_STELLAR_USDLOOP_ISSUER_SECRET,
  );
  if (usd !== null) out.set('USDLOOP', usd);
  const gbp = entryFor(
    'GBPLOOP',
    env.LOOP_STELLAR_GBPLOOP_ISSUER,
    env.LOOP_STELLAR_GBPLOOP_ISSUER_SECRET,
  );
  if (gbp !== null) out.set('GBPLOOP', gbp);
  const eur = entryFor(
    'EURLOOP',
    env.LOOP_STELLAR_EURLOOP_ISSUER,
    env.LOOP_STELLAR_EURLOOP_ISSUER_SECRET,
  );
  if (eur !== null) out.set('EURLOOP', eur);
  cached = out;
  return cached;
}
