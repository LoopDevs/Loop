import { useEffect, useState } from 'react';
import { fetchOrder } from '~/services/orders';
import { usePurchaseStore } from '~/stores/purchase.store';
import { Button } from '~/components/ui/Button';
import { Spinner } from '~/components/ui/Spinner';

interface PaymentStepProps {
  merchantName: string;
  paymentAddress: string;
  xlmAmount: string;
  orderId: string;
}

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 100;

/**
 * Shows the XLM payment address and polls the order status until it's
 * completed or failed.
 */
export function PaymentStep({ merchantName, paymentAddress, xlmAmount, orderId }: PaymentStepProps): React.JSX.Element {
  const store = usePurchaseStore();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [pollingError, setPollingError] = useState<string | null>(null);

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

  // Poll order status
  useEffect(() => {
    if (pollCount >= MAX_POLLS) {
      setPollingError('Payment window expired. Please try again.');
      return;
    }

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const { order } = await fetchOrder(orderId);
          if (order.status === 'completed') {
            if (!order.giftCardCode) {
              store.setError('Order completed but gift card code is unavailable. Please contact support.');
            } else {
              store.setComplete(order.giftCardCode, order.giftCardPin);
            }
          } else if (order.status === 'failed' || order.status === 'expired') {
            store.setError(`Order ${order.status}. Please try again.`);
          } else {
            setPollCount((c) => c + 1);
          }
        } catch {
          setPollCount((c) => c + 1);
        }
      })();
    }, POLL_INTERVAL_MS);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, pollCount]);

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-6">
      <div className="text-center mb-6">
        <Spinner size="sm" />
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
          Waiting for payment — your {merchantName} gift card will be sent once payment is confirmed.
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

      {pollingError !== null && (
        <div className="text-center">
          <p className="text-red-500 text-sm mb-3">{pollingError}</p>
          <Button variant="secondary" onClick={store.reset}>Start over</Button>
        </div>
      )}
    </div>
  );
}
