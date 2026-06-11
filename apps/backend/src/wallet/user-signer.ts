/**
 * User-wallet signer bridge (ADR 030, Phase B).
 *
 * Takes a built `@stellar/stellar-sdk` Transaction whose source (or
 * relevant operation) is the user's embedded-wallet account, has the
 * wallet provider raw-sign the transaction hash, and attaches the
 * resulting decorated signature. Submission reuses the ADR-016
 * submit + classify machinery (`submitPreSignedTransaction` in
 * payments/payout-submit.ts) so user-signed and operator-signed
 * transactions share one Horizon error taxonomy.
 *
 * Safety property: the provider's signature is verified locally with
 * `Keypair.fromPublicKey(address).verify(hash, sig)` BEFORE it is
 * attached. A malformed or wrong-key provider response therefore
 * fails loudly here — as a terminal `WalletProviderError` — rather
 * than surfacing later as an opaque `tx_bad_auth` from Horizon.
 */
import { Keypair, type Transaction } from '@stellar/stellar-sdk';
import { WalletProviderError, type WalletProvider } from './provider.js';
import { submitPreSignedTransaction, type PayoutSubmitResult } from '../payments/payout-submit.js';

export interface UserSignArgs {
  provider: WalletProvider;
  /** Provider-side wallet id (`users.wallet_id`). */
  walletId: string;
  /** The wallet's Stellar public key (`G...`) — the expected signer. */
  address: string;
  /** Built (and not yet signed-by-user) transaction. Mutated in place. */
  tx: Transaction;
}

/**
 * Raw-signs `tx.hash()` via the provider and attaches the verified
 * signature to the transaction. Mutates `tx` (same contract as the
 * SDK's own `tx.sign(keypair)`).
 */
export async function attachUserWalletSignature(args: UserSignArgs): Promise<void> {
  const hash = args.tx.hash();
  const signatureHex = await args.provider.rawSign(args.walletId, hash.toString('hex'));

  const normalized = signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex;
  if (!/^[0-9a-fA-F]{128}$/.test(normalized)) {
    throw new WalletProviderError(
      'terminal_provider',
      `Wallet provider returned a malformed signature (${normalized.length} hex chars; expected 128)`,
    );
  }
  const signature = Buffer.from(normalized, 'hex');

  // Verify before attaching. `tx.addSignature` also validates, but
  // doing it explicitly (a) names the failure precisely and (b)
  // guarantees no unverified provider material is ever handed to
  // the SDK's signature plumbing.
  let verified: boolean;
  try {
    verified = Keypair.fromPublicKey(args.address).verify(hash, signature);
  } catch (err) {
    throw new WalletProviderError(
      'terminal_provider',
      err instanceof Error ? err.message : 'Signature verification threw',
    );
  }
  if (!verified) {
    throw new WalletProviderError(
      'terminal_provider',
      `Wallet provider signature does not verify against ${args.address} for this transaction hash`,
    );
  }

  // addSignature expects the signature base64-encoded; it re-derives
  // the hash and re-verifies internally, which now cannot fail given
  // the explicit check above.
  args.tx.addSignature(args.address, signature.toString('base64'));
}

export interface UserSignAndSubmitArgs extends UserSignArgs {
  horizonUrl: string;
}

/**
 * Sign-and-submit composition: attach the user-wallet signature,
 * then hand off to the existing ADR-016 submit + classify path. On
 * failure callers receive the same `PayoutSubmitError` kinds the
 * payout worker already branches on.
 */
export async function signAndSubmitUserTransaction(
  args: UserSignAndSubmitArgs,
): Promise<PayoutSubmitResult> {
  await attachUserWalletSignature(args);
  return submitPreSignedTransaction({ horizonUrl: args.horizonUrl, tx: args.tx });
}
