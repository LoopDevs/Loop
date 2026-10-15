import { useEffect, useRef, useState } from 'react';
import { Button } from '~/components/ui/Button';
import { isNativePlatform } from '~/native/platform';
import { fetchStellarTransaction, submitStellarTransaction } from '~/services/orders-loop';
import {
  connectedWalletAddress,
  mountWalletButton,
  signWithWallet,
  subscribeWalletAddress,
} from '~/services/stellar-wallet';

export interface StellarWalletPayProps {
  orderId: string;
  /** Shown on the pay button, e.g. "10.0000000 XLM". */
  amountLabel: string;
}

type Phase = 'idle' | 'paying' | 'sent';

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.length > 0 ? err.message : fallback;
}

/**
 * Connected-wallet payment: the kit's connect button picks a wallet,
 * CTX builds the unsigned payment for that account, the wallet signs it,
 * and CTX verifies + submits. The surrounding poll notices the payment
 * the same way it does for a deep-link or QR payment.
 */
export function StellarWalletPay({
  orderId,
  amountLabel,
}: StellarWalletPayProps): React.JSX.Element {
  const buttonRef = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isNativePlatform()) return;
    const container = buttonRef.current;
    if (container === null) return;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void (async () => {
      try {
        await mountWalletButton(container);
        unsubscribe = await subscribeWalletAddress((next) => {
          if (!cancelled) setAddress(next);
        });
        const current = await connectedWalletAddress();
        if (!cancelled && current !== null) setAddress(current);
      } catch (err) {
        if (!cancelled) setError(messageOf(err, 'Wallet connection is unavailable'));
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const pay = async (): Promise<void> => {
    if (address === null) return;
    setPhase('paying');
    setError(null);
    try {
      const tx = await fetchStellarTransaction(orderId, { source: address });
      const signedXdr = await signWithWallet(tx.xdr, tx.networkPassphrase, address);
      await submitStellarTransaction(orderId, { source: address, signedXdr });
      setPhase('sent');
    } catch (err) {
      setError(messageOf(err, 'The payment was not sent'));
      setPhase('idle');
    }
  };

  return (
    <div className="space-y-3">
      <div ref={buttonRef} className="flex justify-center" />
      {address !== null && phase !== 'sent' ? (
        <Button
          type="button"
          className="w-full"
          disabled={phase === 'paying'}
          onClick={() => void pay()}
        >
          {phase === 'paying' ? 'Confirm in your wallet…' : `Pay ${amountLabel} from wallet`}
        </Button>
      ) : null}
      {phase === 'sent' ? (
        <p role="status" className="text-sm text-center text-green-700 dark:text-green-300">
          Payment sent. Waiting for the network to confirm.
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-sm text-center text-red-600 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
