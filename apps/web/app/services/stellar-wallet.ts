/**
 * Stellar Wallets Kit v2 integration — STUB pending ADR + npm install.
 *
 * Per CLAUDE.md "new dependency" rule, adding
 * `@creit.tech/stellar-wallets-kit` and `@stellar/stellar-sdk` to
 * apps/web's package.json requires an ADR justifying the addition.
 * This file is the integration shape the team will fill in once that
 * ADR is accepted; checking it in keeps the design intent visible to
 * reviewers without committing the install.
 *
 * Why we want this:
 *   - Web users with Freighter / xBull / Lobstr extension / Hana extension
 *     can already use the SEP-7 "Open in wallet" button rendered in
 *     `LoopPaymentStep.tsx`. That works because those extensions
 *     register the `web+stellar:` URL scheme.
 *   - Browsers without a registered handler (most desktop users without
 *     a wallet extension installed; some mobile webview contexts)
 *     can't follow the SEP-7 link. SWK gives a vendor-neutral
 *     "Connect wallet" modal that builds + signs + submits the tx
 *     entirely in-app.
 *
 * Adoption plan:
 *   1. Write ADR: "Stellar Wallets Kit for web payment UX"
 *      - Decision: vendor-neutral wallet selection on web
 *      - Rejected alternative: shipping our own per-wallet integration
 *        (Freighter API + xBull API + ...) — combinatorial mess
 *      - Bundle-size cost: ~80kb gzipped (acceptable; lazy-loaded only
 *        on the payment step)
 *   2. `npm install @creit.tech/stellar-wallets-kit @stellar/stellar-sdk -w @loop/web`
 *   3. Replace the body of this module with the real implementation
 *   4. Wire `connectAndPay` into `StellarPaymentBody` web variant
 *
 * Until then: every export below is a stub that throws if called.
 * The current `LoopPaymentStep.tsx` web flow uses the SEP-7
 * `paymentUri` "Open in wallet" anchor — no SWK calls yet.
 */

export interface ConnectedWallet {
  address: string;
  walletName: string;
}

export interface PayParams {
  /** Stellar deposit address from `CreateLoopOrderResponse.payment.stellarAddress`. */
  destination: string;
  /** Memo (text) — `CreateLoopOrderResponse.payment.memo`. */
  memo: string;
  /** Asset-native amount as 7-decimal string — `CreateLoopOrderResponse.payment.assetAmount`. */
  amount: string;
  /** Native XLM, USDC, or a LOOP-asset code. */
  assetCode: 'XLM' | 'USDC' | 'USDLOOP' | 'GBPLOOP' | 'EURLOOP';
  /** Required for non-native assets. Empty string for XLM. */
  assetIssuer: string;
}

/**
 * Opens the SWK modal so the user picks a wallet (Freighter / xBull /
 * Lobstr / Hana / Albedo / etc), then returns the connected address +
 * wallet name. Caller stores this and reuses for `signAndSubmit`.
 *
 * STUB — calls into a not-yet-installed dep. Throws on invocation.
 */
export async function connectWallet(): Promise<ConnectedWallet> {
  throw new Error(
    'stellar-wallets-kit not yet installed — see ADR-pending and the SWK adoption plan in this file',
  );
}

/**
 * Builds a Stellar payment transaction and asks the connected wallet
 * to sign + submit. Returns the Horizon-confirmed tx hash on success.
 *
 * STUB — calls into a not-yet-installed dep. Throws on invocation.
 */
export async function signAndSubmit(
  _wallet: ConnectedWallet,
  _payment: PayParams,
): Promise<{ txHash: string }> {
  throw new Error(
    'stellar-wallets-kit not yet installed — see ADR-pending and the SWK adoption plan in this file',
  );
}
