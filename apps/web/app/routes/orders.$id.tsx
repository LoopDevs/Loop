import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type { Order } from '@loop/shared';
import type { Route } from './+types/orders.$id';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { useAuth } from '~/hooks/use-auth';
import { fetchOrder } from '~/services/orders';
import { shouldRetry } from '~/hooks/query-retry';
import { Navbar } from '~/components/features/Navbar';
import { Spinner } from '~/components/ui/Spinner';
import { Button } from '~/components/ui/Button';
import { PurchaseComplete } from '~/components/features/purchase/PurchaseComplete';
import { formatMoney } from '~/utils/money';
import { friendlyError } from '~/utils/error-messages';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Order — Loop' }];
}

export function ErrorBoundary(): React.JSX.Element {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
          Something went wrong
        </h1>
        <Link to="/orders" className="text-blue-600 underline">
          Back to orders
        </Link>
      </div>
    </div>
  );
}

/**
 * `/orders/:id` — standalone detail view for a single placed order.
 * Refetches `/api/orders/:id` on mount so the user sees live data —
 * particularly for barcode-type cards, where the code/pin/barcodeUrl
 * are only populated by the backend once CTX reports fulfilled. Lets
 * users revisit their gift card any time without us persisting the
 * code locally (refresh token is enough to re-authenticate).
 */
export default function OrderDetailRoute(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const { isAuthenticated } = useAuth();
  const { isNative } = useNativePlatform();
  const navigate = useNavigate();

  const { data, isLoading, error, refetch } = useQuery<{ order: Order }, Error>({
    queryKey: ['order', id],
    queryFn: () => fetchOrder(id),
    enabled: isAuthenticated && id.length > 0,
    retry: shouldRetry,
  });

  const order = data?.order;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Pulse the clock every 30s so "x minutes ago" stays fresh
    // without each render computing it from stale state.
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const errText =
    error !== null && error !== undefined
      ? error instanceof ApiException && error.status === 401
        ? 'Please sign in to view this order.'
        : friendlyError(error, 'Failed to load order.')
      : null;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {!isNative && <Navbar />}

      <main className="max-w-2xl mx-auto px-4 py-8 pt-20">
        <button
          type="button"
          onClick={() => {
            if (window.history.length > 1) void navigate(-1);
            else void navigate('/orders');
          }}
          className="text-sm text-blue-600 dark:text-blue-400 mb-4 inline-flex items-center gap-1"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path d="M15 18 9 12l6-6" />
          </svg>
          All orders
        </button>

        {!isAuthenticated && (
          <p className="text-center text-gray-500 dark:text-gray-400 py-12">
            Sign in to view this order.
          </p>
        )}

        {isAuthenticated && isLoading && (
          <div className="flex items-center justify-center py-16">
            <Spinner />
          </div>
        )}

        {errText !== null && (
          <div className="text-center py-12">
            <p className="text-red-500 mb-4">{errText}</p>
            <Button variant="secondary" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        )}

        {order !== undefined && <OrderDetailBody order={order} now={now} />}
      </main>
    </div>
  );
}

function OrderDetailBody({ order, now }: { order: Order; now: number }): React.JSX.Element {
  const created = new Date(order.createdAt);
  const createdLabel = Number.isNaN(created.getTime())
    ? order.createdAt
    : created.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
  void now;

  return (
    <>
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 mb-6">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white mb-1">
          {order.merchantName}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{createdLabel}</p>
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">Amount</span>
          <span className="font-semibold text-gray-900 dark:text-white">
            {formatMoney(order.amount, order.currency)}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm mt-2">
          <span className="text-gray-500 dark:text-gray-400">Status</span>
          <StatusBadge status={order.status} />
        </div>
      </div>

      {order.status === 'completed' && order.giftCardCode !== undefined && (
        <PurchaseComplete
          merchantName={order.merchantName}
          code={order.giftCardCode}
          pin={order.giftCardPin}
          barcodeImageUrl={order.barcodeImageUrl}
          onDone={() => {
            /* no-op: user is on the orders-detail page, no purchase
               flow to reset */
          }}
        />
      )}

      {order.status === 'completed' &&
        order.giftCardCode === undefined &&
        order.redeemUrl !== undefined && (
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
              This gift card is redeemed on the merchant's site. Use the link below and, if
              prompted, paste the challenge code.
            </p>
            {order.redeemChallengeCode !== undefined && (
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 mb-4">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Challenge code</p>
                <p className="font-mono text-sm text-gray-900 dark:text-gray-100">
                  {order.redeemChallengeCode}
                </p>
              </div>
            )}
            <a
              href={order.redeemUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full text-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold"
            >
              Open redemption page
            </a>
          </div>
        )}

      {order.status === 'pending' && (
        <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
          This order is still awaiting payment confirmation.
        </p>
      )}

      {(order.status === 'failed' || order.status === 'expired') && (
        <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
          This order {order.status}. The XLM you sent (if any) should refund automatically.
        </p>
      )}
    </>
  );
}

function StatusBadge({ status }: { status: Order['status'] }): React.JSX.Element {
  const map: Record<Order['status'], { label: string; className: string }> = {
    pending: {
      label: 'Pending',
      className: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
    },
    completed: {
      label: 'Completed',
      className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    },
    failed: {
      label: 'Failed',
      className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    },
    expired: {
      label: 'Expired',
      className: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300',
    },
  };
  const cfg = map[status];
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}
