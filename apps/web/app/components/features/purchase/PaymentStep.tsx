import { useEffect, useState, useCallback, useRef } from 'react';
import { ApiException } from '@loop/shared';
import { fetchOrder } from '~/services/orders';
import { usePurchaseStore } from '~/stores/purchase.store';
import { Button } from '~/components/ui/Button';
import { Spinner } from '~/components/ui/Spinner';

interface PaymentStepProps {
  merchantName: string;
  paymentAddress: string;
  xlmAmount: string;
  orderId: string;
  expiresAt: number;
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
}: PaymentStepProps): React.JSX.Element {
  const store = usePurchaseStore();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<string>('');
  const [expired, setExpired] = useState(false);
  const consecutiveErrors = useRef(0);

  // Generate QR code
  useEffect(() => {
    void (async () => {
      try {
        const QRCode = await import('qrcode');
        const url = await QRCode.toDataURL(paymentAddress, { width: 200, margin: 1 });
        setQrDataUrl(url);
      } catch {
        // QR code generation failed — address still shown as text
      }
    })();
  }, [paymentAddress]);

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

  // Poll order status
  useEffect(() => {
    if (expired) return;

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const { order } = await fetchOrder(orderId);
          if (order.status === 'completed') {
            if (!order.giftCardCode) {
              store.setError(
                'Order completed but gift card code is unavailable. Please contact support.',
              );
            } else {
              store.setComplete(order.giftCardCode, order.giftCardPin);
            }
            return;
          }
          if (order.status === 'failed' || order.status === 'expired') {
            store.setError(`Order ${order.status}. Please try again.`);
            return;
          }
          // Still pending — trigger next poll via state update
          consecutiveErrors.current = 0;
          setTimeLeft((prev) => prev); // force re-render to schedule next poll
        } catch (err) {
          consecutiveErrors.current++;
          // Permanent failure: auth expired or service down — stop polling
          if (err instanceof ApiException && (err.status === 401 || err.status === 503)) {
            store.setError(
              err.status === 401
                ? 'Your session has expired. Please sign in again.'
                : 'Service temporarily unavailable. Please try again later.',
            );
            return;
          }
          // After 5 consecutive transient errors, give up
          if (consecutiveErrors.current >= 5) {
            store.setError('Unable to check order status. Please try again later.');
            return;
          }
          // Otherwise retry on next poll cycle
        }
      })();
    }, POLL_INTERVAL_MS);

    return () => clearTimeout(timer);
    // Re-poll whenever timeLeft changes (every second) — effectively continuous polling
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, timeLeft, expired]);

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
