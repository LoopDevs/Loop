import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Route } from './+types/orders';
import type { Order } from '@loop/shared';
import { ApiException } from '@loop/shared';
import i18n from '~/i18n/i18next';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { useAuth } from '~/hooks/use-auth';
import { useOrders } from '~/hooks/use-orders';
import { useAppConfig } from '~/hooks/use-app-config';
import { shouldRetry } from '~/hooks/query-retry';
import { getUserPendingPayouts, type UserPendingPayoutState } from '~/services/user';
import { Navbar } from '~/components/features/Navbar';
import { PageHeader } from '~/components/ui/PageHeader';
import { OrderRowSkeleton } from '~/components/ui/Skeleton';
import { Button } from '~/components/ui/Button';
import { LoopOrdersList } from '~/components/features/orders/LoopOrdersList';
import { OrdersSummaryHeader } from '~/components/features/orders/OrdersSummaryHeader';
import { CashbackEarningsHeadline } from '~/components/features/cashback/CashbackEarningsHeadline';
import { FlywheelChip } from '~/components/features/cashback/FlywheelChip';
import { friendlyError } from '~/utils/error-messages';
import { formatMoney, useLocaleTag } from '~/i18n/format';

export function meta(): Route.MetaDescriptors {
  return [{ title: i18n.t('orders:list.meta.title') }];
}

export function ErrorBoundary(): React.JSX.Element {
  const { t } = useTranslation(['orders', 'common']);
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
          {t('common:errorBoundary.heading')}
        </h1>
        <a href="/orders" className="text-blue-600 underline">
          {t('orders:list.error.tryAgain')}
        </a>
      </div>
    </div>
  );
}

/**
 * Plain helper (not a component) — `t` threaded in from the caller's
 * `useTranslation('orders')`, same pattern as `routes/auth.tsx`'s
 * `ledgerLabel(t, type)` (docs/i18n.md #3).
 */
function statusLabel(t: TFunction, status: string): { label: string; color: string } {
  const labels: Record<string, { label: string; color: string }> = {
    pending: {
      label: t('status.pending'),
      color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
    },
    completed: {
      label: t('status.completed'),
      color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    },
    failed: {
      label: t('status.failed'),
      color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    },
    expired: {
      label: t('status.expired'),
      color: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300',
    },
  };
  return labels[status] ?? labels['pending']!;
}

/**
 * Per-row payout-state dot. Compact by design — the list renders a
 * lot of rows and competing with the order status pill would clutter
 * the line. A coloured dot + short label only when the user actually
 * has a payout for this order. Self-hides when `state === null`
 * (the order is pre-cashback, credit-only, or the user's payouts
 * list isn't cached yet).
 */
const PAYOUT_DOT_UI: Record<UserPendingPayoutState, { dot: string; classes: string }> = {
  pending: {
    dot: 'bg-gray-400',
    classes: 'text-gray-600 dark:text-gray-400',
  },
  submitted: {
    dot: 'bg-yellow-500',
    classes: 'text-yellow-700 dark:text-yellow-400',
  },
  confirmed: {
    dot: 'bg-green-500',
    classes: 'text-green-700 dark:text-green-400',
  },
  failed: {
    dot: 'bg-red-500',
    classes: 'text-red-700 dark:text-red-400',
  },
};

function PayoutDot({ state }: { state: UserPendingPayoutState }): React.JSX.Element {
  const { t } = useTranslation('orders');
  const ui = PAYOUT_DOT_UI[state];
  const label = t(`payoutState.${state}`);
  const ariaLabel = t('payoutAriaLabel', { label });
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium ${ui.classes}`}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${ui.dot}`} />
      {label}
    </span>
  );
}

function OrderRow({
  order,
  payoutState,
}: {
  order: Order;
  payoutState: UserPendingPayoutState | null;
}): React.JSX.Element {
  const { t } = useTranslation('orders');
  const locale = useLocaleTag();
  const status = statusLabel(t, order.status);
  // A malformed upstream createdAt would otherwise render "Invalid Date" in
  // the UI. Fall back to the raw string so the row is still informative.
  const parsed = new Date(order.createdAt);
  const date = Number.isNaN(parsed.getTime())
    ? order.createdAt
    : parsed.toLocaleDateString(locale, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });

  return (
    <Link
      to={`/orders/${encodeURIComponent(order.id)}`}
      className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
    >
      <div className="flex-1 min-w-0">
        <p className="font-medium text-gray-900 dark:text-white truncate">{order.merchantName}</p>
        <div className="mt-0.5 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <span>{date}</span>
          {payoutState !== null ? <PayoutDot state={payoutState} /> : null}
        </div>
      </div>
      <div className="flex items-center gap-3 ml-4">
        <span className="text-sm font-semibold text-gray-900 dark:text-white">
          {formatMoney(order.amount, order.currency, locale)}
        </span>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${status.color}`}>
          {status.label}
        </span>
      </div>
    </Link>
  );
}

function errorMessage(t: TFunction, err: Error | null): string | null {
  if (err === null) return null;
  // 401 is the only status with list-specific copy — every other class of
  // error (offline / 429 / 503 / 502 / 504 / timeout) has a better generic
  // message in friendlyError than our old "Failed to load orders." string.
  if (err instanceof ApiException && err.status === 401) {
    return t('list.signInRequired');
  }
  return friendlyError(err, t('list.loadErrorFallback'));
}

export default function OrdersRoute(): React.JSX.Element {
  const { t } = useTranslation('orders');
  const { isNative } = useNativePlatform();
  const { isAuthenticated } = useAuth();
  const { config } = useAppConfig();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);

  const {
    orders: allOrders,
    hasNext,
    hasPrev,
    isLoading,
    error,
    refetch,
  } = useOrders(page, isAuthenticated);
  // Pending orders are intentionally hidden from the list: for the
  // user they read as "something I haven't paid for yet" and surface
  // as blank-ish rows with no gift-card to redeem. They're still
  // reachable by direct `/orders/:id` URL (the purchase flow links
  // to the pending order mid-payment) — we just don't advertise them
  // on the overview.
  const orders = allOrders.filter((o) => o.status !== 'pending');
  const errorText = errorMessage(t, error);

  // Single fetch of the user's pending-payouts, mapped by orderId
  // so each OrderRow gets a cheap O(1) lookup for its settlement
  // state. 100-row cap is generous for any single /orders page;
  // fan-out per-row queries would be wasteful when this is a list
  // view. Re-uses the ['me', 'pending-payouts'] query key so the
  // `PendingPayoutsCard` on /settings/cashback and this list share
  // the same cache line. Silent degrade on error — the order-status
  // pill already carries the primary signal; missing the payout
  // dot is a minor loss, not a page-crasher.
  const payoutsQuery = useQuery({
    queryKey: ['me', 'pending-payouts'],
    queryFn: () => getUserPendingPayouts({ limit: 100 }),
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 30_000,
  });
  const payoutByOrderId = useMemo(() => {
    const map = new Map<string, UserPendingPayoutState>();
    for (const p of payoutsQuery.data?.payouts ?? []) {
      map.set(p.orderId, p.state);
    }
    return map;
  }, [payoutsQuery.data]);

  return (
    <>
      {!isNative && <Navbar />}
      <PageHeader title={t('list.pageTitle')} fallbackHref="/" />

      {/* Native: NativeShell's `native-safe-page` already pads by
          `var(--safe-top)`, so we only need to clear the PageHeader
          row height (`h-14` = 3.5rem) — adding another safe-top here
          would double-count and push content ~50px too far down.
          Web: `pt-20` clears the fixed Navbar. */}
      <main className={`max-w-2xl mx-auto px-4 ${isNative ? 'pt-16 pb-4' : 'pt-20 pb-8'}`}>
        {/* Lifetime cashback headline — silent no-op for zero-earnings
            users and for anyone who isn't signed in. Sits above the
            orders list so "earned with Loop" frames the content. */}
        {isAuthenticated ? (
          <div className="mb-4">
            <CashbackEarningsHeadline />
          </div>
        ) : null}

        {/* Personal flywheel chip (ADR 015). Self-hides for users
            with no recycled orders; sits below the lifetime headline
            because it depends on "you earned cashback + spent it
            again" — an intrinsically later milestone than "you
            earned cashback at all". */}
        {isAuthenticated ? (
          <div className="mb-4">
            <FlywheelChip />
          </div>
        ) : null}

        {/* 5-number orders summary (ADR 010 / 015 / #584). Complement
            to the cashback headline above: cashback answers "what did
            I get", this answers "what did I buy". Self-hides for
            zero-activity users so new accounts aren't framed around
            empty numbers. */}
        {isAuthenticated ? (
          <div className="mb-4">
            <OrdersSummaryHeader />
          </div>
        ) : null}

        {/* Loop-native orders (ADR 010). Rendered above the legacy
            CTX-proxy list when the flag is live in this deployment.
            Silent no-op when the flag is off or the user has no
            Loop-native orders yet. */}
        {isAuthenticated ? <LoopOrdersList enabled={config.loopOrdersEnabled} /> : null}

        {!isAuthenticated && (
          <div className="text-center py-12">
            <p className="text-gray-500 dark:text-gray-400 mb-4">{t('list.signedOut.body')}</p>
            <Button
              onClick={() => {
                void navigate('/auth');
              }}
            >
              {t('list.signedOut.cta')}
            </Button>
          </div>
        )}

        {isAuthenticated && isLoading && (
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
            {Array.from({ length: 5 }).map((_, i) => (
              <OrderRowSkeleton key={i} />
            ))}
          </div>
        )}

        {errorText !== null && (
          <div className="text-center py-12">
            <p className="text-red-500 mb-4">{errorText}</p>
            <Button
              variant="secondary"
              onClick={() => {
                // `setPage(1)` would no-op if we were already on page 1 —
                // the queryKey stays the same so TanStack Query serves the
                // cached error instead of refetching. Use `refetch()` so
                // Retry always triggers a fresh request regardless of page.
                refetch();
              }}
            >
              {t('list.retry')}
            </Button>
          </div>
        )}

        {isAuthenticated && !isLoading && errorText === null && orders.length === 0 && (
          <div className="text-center py-12">
            <p className="text-gray-500 dark:text-gray-400 mb-4">{t('list.empty')}</p>
            <Button
              onClick={() => {
                void navigate('/');
              }}
            >
              {t('list.browseGiftCards')}
            </Button>
          </div>
        )}

        {orders.length > 0 && (
          <>
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
              {orders.map((order) => (
                <OrderRow
                  key={order.id}
                  order={order}
                  payoutState={payoutByOrderId.get(order.id) ?? null}
                />
              ))}
            </div>

            <div className="flex justify-between mt-4">
              <Button
                variant="secondary"
                disabled={!hasPrev || isLoading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                {t('list.previous')}
              </Button>
              <Button
                variant="secondary"
                disabled={!hasNext || isLoading}
                onClick={() => setPage((p) => p + 1)}
              >
                {t('list.next')}
              </Button>
            </div>
          </>
        )}
      </main>
    </>
  );
}
