import { useEffect, useState, useCallback, useRef } from 'react';
import { ApiException } from '@loop/shared';
import { fetchOrder } from '~/services/orders';
import { usePurchaseStore } from '~/stores/purchase.store';
import { Button } from '~/components/ui/Button';
import { Spinner } from '~/components/ui/Spinner';
import { copyToClipboard } from '~/native/clipboard';

interface PaymentStepProps {
  merchantName: string;
  paymentAddress: string;
  xlmAmount: string;
  orderId: string;
  expiresAt: number;
  memo: string;
}

const POLL_INTERVAL_MS = 3000;

/**
 * Shows the XLM payment address with a countdown timer and polls the
 * order status until completed, failed, or expired.
 */
export function PaymentStep({
  merchantName,
  paymentAddress,
  xlmAmount,
  orderId,
  expiresAt,
  memo,
}: PaymentStepProps): React.JSX.Element {
  const store = usePurchaseStore();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<string>('');
  const [expired, setExpired] = useState(false);
  const consecutiveErrors = useRef(0);
  const [copied, setCopied] = useState(false);
  const [connectionIssue, setConnectionIssue] = useState(false);

  const handleCopy = async (text: string): Promise<void> => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Build full Stellar URI for QR code — wallets can parse it directly
  const stellarUri = memo
    ? `web+stellar:pay?destination=${paymentAddress}&amount=${xlmAmount}&memo=${encodeURIComponent(memo)}`
    : paymentAddress;

  // Generate QR code
  useEffect(() => {
    void (async () => {
      try {
        const QRCode = await import('qrcode');
        const url = await QRCode.toDataURL(stellarUri, { width: 200, margin: 1 });
        setQrDataUrl(url);
      } catch {
        // QR code generation failed — address still shown as text
      }
    })();
  }, [stellarUri]);

  // Countdown timer
  const updateCountdown = useCallback((): boolean => {
    const remaining = expiresAt - Math.floor(Date.now() / 1000);
    if (remaining <= 0) {
      setTimeLeft('0:00');
      setExpired(true);
      return false;
    }
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    setTimeLeft(`${mins}:${secs.toString().padStart(2, '0')}`);
    return true;
  }, [expiresAt]);

  useEffect(() => {
    updateCountdown();
    const timer = setInterval(() => {
      if (!updateCountdown()) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [updateCountdown]);

  // Poll order status. Self-scheduling: after each fetch completes (success or
  // failure) we schedule the next one POLL_INTERVAL_MS later, guarded by a
  // `cancelled` flag so unmount / expiry / terminal status stops the loop.
  //
  // An earlier version kept `timeLeft` in the dep array and tried to re-trigger
  // polling by bumping state each tick; that reset the setTimeout every second
  // and polls never actually fired. Anyone waiting on a gift card status saw
  // the spinner spin forever until manual refresh.
  useEffect(() => {
    if (expired) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const { order } = await fetchOrder(orderId);
        if (cancelled) return;
        setConnectionIssue(false);
        consecutiveErrors.current = 0;
        if (order.status === 'completed') {
          if (order.redeemUrl && order.redeemChallengeCode) {
            store.setRedeemRequired({
              redeemUrl: order.redeemUrl,
              redeemChallengeCode: order.redeemChallengeCode,
              ...(order.redeemScripts ? { redeemScripts: order.redeemScripts } : {}),
            });
          } else if (order.giftCardCode) {
            // Currently unreachable via polling — the backend's GetOrder
            // handler doesn't populate giftCardCode. For barcode-type gift
            // cards the upstream /gift-cards/:id/barcode endpoint would
            // need a separate proxy (Phase 2). RedeemFlow still sets these
            // via WebView postMessage after the URL flow completes, so
            // Order.giftCardCode remains a live field elsewhere.
            store.setComplete(order.giftCardCode, order.giftCardPin);
          } else {
            store.setError(
              'Order completed but gift card details are unavailable. Please contact support.',
            );
          }
          return; // terminal — no reschedule
        }
        if (order.status === 'failed' || order.status === 'expired') {
          store.setError(`Order ${order.status}. Please try again.`);
          return; // terminal — no reschedule
        }
      } catch (err) {
        if (cancelled) return;
        consecutiveErrors.current++;
        setConnectionIssue(true);
        if (err instanceof ApiException && err.status === 401) {
          store.setError('Your session has expired. Please sign in again.');
          return; // terminal — no reschedule
        }
        if (err instanceof ApiException && err.status === 503) {
          consecutiveErrors.current--;
        }
        // Other transient errors fall through to reschedule.
      }
      if (!cancelled) {
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };

    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
    // `store` identity changes on each render but its setter methods are stable;
    // re-running the effect just to re-bind them would restart polling needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, expired]);

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-6">
      <div className="text-center mb-6">
        <Spinner size="sm" />
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
          Waiting for payment — your {merchantName} gift card will be sent once payment is
          confirmed.
        </p>
      </div>

      <div className="text-center mb-4">
        <p className="text-lg font-bold text-gray-900 dark:text-white mb-1">{xlmAmount} XLM</p>
        <p className="text-xs text-gray-500">Send exactly this amount to:</p>
      </div>

      {qrDataUrl !== null && (
        <div className="flex justify-center mb-4">
          <img src={qrDataUrl} alt="Payment QR code" className="rounded-lg" />
        </div>
      )}

      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center break-all font-mono text-sm text-gray-700 dark:text-gray-300 mb-4">
        {paymentAddress}
      </div>

      <div className="text-center mb-4">
        <button
          type="button"
          onClick={() => {
            void handleCopy(paymentAddress);
          }}
          className="text-xs text-blue-600 dark:text-blue-400 mt-1"
        >
          {copied ? 'Copied!' : 'Copy address'}
        </button>
      </div>

      {memo && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-3 text-center mb-4">
          <p className="text-xs text-yellow-700 dark:text-yellow-300 mb-1 font-medium">
            Required memo
          </p>
          <p className="font-mono text-sm font-bold text-yellow-800 dark:text-yellow-200 break-all">
            {memo}
          </p>
          <button
            type="button"
            onClick={() => {
              void handleCopy(memo);
            }}
            className="text-xs text-blue-600 dark:text-blue-400 mt-1"
          >
            {copied ? 'Copied!' : 'Copy memo'}
          </button>
        </div>
      )}

      {connectionIssue && !expired && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-3 text-center text-sm text-yellow-700 dark:text-yellow-300 mb-4">
          Connection issue — still checking for your payment...
        </div>
      )}

      <div className="text-center mb-4">
        <p
          className={`text-sm font-medium ${expired ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}`}
        >
          {expired ? 'Payment window expired' : `Time remaining: ${timeLeft}`}
        </p>
      </div>

      {expired && (
        <div className="text-center">
          <p className="text-red-500 text-sm mb-3">Payment window expired. Please try again.</p>
          <Button variant="secondary" onClick={store.reset}>
            Start over
          </Button>
        </div>
      )}
    </div>
  );
}
