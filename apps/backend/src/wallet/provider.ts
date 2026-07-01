/**
 * Provider-agnostic embedded-wallet layer (ADR 030, Phase B).
 *
 * This is the substrate the Phase-C flows (wallet provisioning at
 * signup, user-signed Soroban/classic transactions) wire into.
 * Nothing user-facing consumes it yet — the whole layer is OFF by
 * default behind `LOOP_WALLET_PROVIDER` ('' → `getWalletProvider()`
 * returns null and no Privy code path is reachable).
 *
 * Why an interface and not direct Privy imports everywhere: ADR 030
 * names dfns as the documented fallback if Privy fails Soroban DD,
 * and pins the migration-cost containment to "vendor-specific code
 * is isolated". Callers depend on `WalletProvider`; only
 * `wallet/privy.ts` knows Privy's REST shapes.
 */
import { env } from '../env.js';
import { createPrivyWalletProvider } from './privy.js';

export interface WalletProvider {
  readonly name: 'privy';
  /**
   * Provisions (or returns the existing) provider-side Stellar
   * wallet for a Loop user. MUST be idempotent per user — calling
   * it twice for the same `userId` returns the same wallet. See the
   * adapter for how each vendor achieves that.
   *
   * `walletId` is the provider-side identifier persisted to
   * `users.wallet_id`; `address` is the Stellar `G...` account.
   */
  createWallet(userId: string): Promise<{ walletId: string; address: string }>;
  /**
   * Raw ed25519 signature over a pre-computed 32-byte Stellar
   * transaction hash. `hashHex` is the 64-char hex of `tx.hash()`;
   * the return value is the 128-char hex of the 64-byte signature
   * (no `0x` prefix). Callers MUST verify the signature against the
   * wallet's public key before attaching it to a transaction — see
   * `wallet/user-signer.ts`.
   */
  rawSign(walletId: string, hashHex: string): Promise<string>;
}

/**
 * Error classification for the worker/flow retry policies. Mirrors
 * the `PayoutSubmitError` kind taxonomy (ADR 016): `transient_*` is
 * safe to retry on a later tick, `terminal_*` needs code or operator
 * intervention.
 *
 *   - 5xx / 429 / network failure / timeout → `transient_provider`
 *   - any other 4xx, response-shape drift (Zod reject), malformed
 *     signature material → `terminal_provider`
 */
export type WalletProviderErrorKind = 'transient_provider' | 'terminal_provider';

export class WalletProviderError extends Error {
  readonly kind: WalletProviderErrorKind;
  /** HTTP status from the provider, when one was received. */
  readonly status: number | null;

  constructor(kind: WalletProviderErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'WalletProviderError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Factory keyed on `LOOP_WALLET_PROVIDER`. Returns null when the
 * wallet layer is disabled ('' — the default), so call sites read as
 * `const provider = getWalletProvider(); if (provider === null) …`.
 *
 * `parseEnv` already enforces that PRIVY_APP_ID / PRIVY_APP_SECRET
 * are present when the provider is 'privy'; the throw below is a
 * defence-in-depth tripwire for test environments that mock `env.js`
 * inconsistently.
 */
export function getWalletProvider(): WalletProvider | null {
  if (env.LOOP_WALLET_PROVIDER !== 'privy') {
    return null;
  }
  const appId = env.PRIVY_APP_ID;
  const appSecret = env.PRIVY_APP_SECRET;
  if (appId === undefined || appSecret === undefined) {
    throw new WalletProviderError(
      'terminal_provider',
      'LOOP_WALLET_PROVIDER=privy requires PRIVY_APP_ID and PRIVY_APP_SECRET to be set',
    );
  }
  return createPrivyWalletProvider({ appId, appSecret });
}
