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
import { PageHeader } from '~/components/ui/PageHeader';
import { Spinner } from '~/components/ui/Spinner';
import { Button } from '~/components/ui/Button';
import { PurchaseComplete } from '~/components/features/purchase/PurchaseComplete';
import { formatMoney } from '~/utils/money';
import { friendlyError } from '~/utils/error-messages';
import { openWebView } from '~/native/webview';
import { buildChallengeBarScript } from '~/utils/redeem-challenge-bar';

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
    <>
      {!isNative && <Navbar />}
      <PageHeader title="Order" fallbackHref="/orders" />

      {/* Native only needs to clear the PageHeader row height
          (`h-14` = 3.5rem); NativeShell already adds `var(--safe-top)`
          padding. Web: `pt-20` clears the fixed Navbar. The tight
          native top-pad (`pt-14`) keeps the order summary flush up
          to the header rather than floating in its own white band. */}
      <main className={`max-w-2xl mx-auto px-4 ${isNative ? 'pt-14 pb-4' : 'pt-20 pb-8'}`}>
        {/* Web keeps the inline "All orders" breadcrumb since the
            native back chevron lives in PageHeader instead. */}
        {!isNative && (
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
        )}

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
    </>
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
      {/* Tight header — merchant + date on the left, amount on the
          right. Status only surfaces when it's not 'completed'
          (completed is implicit once we render the gift-card card
          below, so repeating it as a badge is noise). */}
      <div className="flex items-start justify-between gap-3 py-3 mb-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-gray-900 dark:text-white truncate">
            {order.merchantName}
          </h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{createdLabel}</p>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">
            {formatMoney(order.amount, order.currency)}
          </div>
          {order.status !== 'completed' && (
            <div className="mt-1">
              <StatusBadge status={order.status} />
            </div>
          )}
        </div>
      </div>

      {order.status === 'completed' && order.giftCardCode !== undefined && (
        <PurchaseComplete
          merchantName={order.merchantName}
          code={order.giftCardCode}
          pin={order.giftCardPin}
          barcodeImageUrl={order.barcodeImageUrl}
        />
      )}

      {order.status === 'completed' &&
        order.giftCardCode === undefined &&
        order.redeemUrl !== undefined && (
          <RedemptionBlock redeemUrl={order.redeemUrl} challengeCode={order.redeemChallengeCode} />
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

/**
 * Redeem-URL order presentation. Shows the challenge code (if any)
 * with a copy affordance, and a button that opens the merchant's
 * redemption page inside the in-app WebView with the challenge-code
 * bar pre-injected — same behaviour as the in-purchase RedeemFlow
 * so revisiting an old URL-redeem order doesn't regress to a bare
 * `<a target="_blank">`.
 *
 * Kept local to this route module since it's not reused elsewhere;
 * RedeemFlow owns the mid-purchase path with its own state (manual
 * entry, postMessage capture, etc.) — here the order already
 * exists and we're just re-opening the redemption page.
 */
function RedemptionBlock({
  redeemUrl,
  challengeCode,
}: {
  redeemUrl: string;
  challengeCode?: string | undefined;
}): React.JSX.Element {
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const handleOpen = async (): Promise<void> => {
    setOpening(true);
    setOpenError(null);
    try {
      // Only inject the bar when we actually have a challenge code —
      // some URL-redeem merchants don't use one, and injecting an
      // empty "CODE" bar would be confusing.
      const scripts =
        challengeCode !== undefined && challengeCode.length > 0
          ? [buildChallengeBarScript(challengeCode)]
          : [];
      await openWebView({ url: redeemUrl, scripts });
    } catch (err) {
      setOpenError(
        err instanceof Error && err.message.length > 0
          ? err.message
          : 'We could not open the redemption page.',
      );
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
        This gift card is redeemed on the merchant&apos;s site. Open the page below and, if
        prompted, paste the challenge code.
      </p>
      {challengeCode !== undefined && challengeCode.length > 0 && (
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 mb-4">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Challenge code</p>
          <p className="font-mono text-sm text-gray-900 dark:text-gray-100">{challengeCode}</p>
        </div>
      )}
      {openError !== null && (
        <p className="text-sm text-red-600 dark:text-red-400 mb-3" role="alert">
          {openError}
        </p>
      )}
      <Button className="w-full" onClick={() => void handleOpen()} disabled={opening}>
        {opening ? 'Opening\u2026' : 'Open redemption page'}
      </Button>
    </div>
  );
}
