/**
 * Stellar Wallets Kit bridge for the "Connect wallet" pay path.
 *
 * The kit is browser-only and heavy, so it is imported on first use and
 * never on the server or inside the native shell. CTX builds and submits
 * the transaction (via the Loop backend); the kit only supplies the
 * connected account and the signature.
 */
import type { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk';
import type { Networks } from '@creit.tech/stellar-wallets-kit/types';

type Kit = typeof StellarWalletsKit;

let kitPromise: Promise<Kit> | null = null;

async function loadKit(): Promise<Kit> {
  kitPromise ??= Promise.all([
    import('@creit.tech/stellar-wallets-kit/sdk'),
    import('@creit.tech/stellar-wallets-kit/modules/utils'),
  ]).then(([sdk, modules]) => {
    sdk.StellarWalletsKit.init({ modules: modules.defaultModules() });
    return sdk.StellarWalletsKit;
  });
  return kitPromise;
}

/** Renders the kit's own connect / profile button into `container`. */
export async function mountWalletButton(container: HTMLElement): Promise<void> {
  const kit = await loadKit();
  await kit.createButton(container);
}

/** The account the kit currently holds, or null when no wallet is connected. */
export async function connectedWalletAddress(): Promise<string | null> {
  const kit = await loadKit();
  try {
    return (await kit.getAddress()).address;
  } catch {
    return null;
  }
}

/** Calls `onChange` whenever the connected account changes; returns the unsubscribe. */
export async function subscribeWalletAddress(
  onChange: (address: string | null) => void,
): Promise<() => void> {
  const [kit, { KitEventType }] = await Promise.all([
    loadKit(),
    import('@creit.tech/stellar-wallets-kit/types'),
  ]);
  const offState = kit.on(KitEventType.STATE_UPDATED, (event) => {
    onChange(event.payload.address ?? null);
  });
  const offDisconnect = kit.on(KitEventType.DISCONNECT, () => onChange(null));
  return () => {
    offState();
    offDisconnect();
  };
}

/** Asks the connected wallet to sign `xdr` for the network CTX named. */
export async function signWithWallet(
  xdr: string,
  networkPassphrase: string,
  address: string,
): Promise<string> {
  const kit = await loadKit();
  kit.setNetwork(networkPassphrase as Networks);
  const { signedTxXdr } = await kit.signTransaction(xdr, { networkPassphrase, address });
  return signedTxXdr;
}
