import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiException, assertNever } from '@loop/shared';
import { listLoopOrders, loopOrderStateLabel, type LoopOrderView } from '~/services/orders-loop';
import { useAllMerchants } from '~/hooks/use-merchants';
import { shouldRetry } from '~/hooks/query-retry';
import { Button } from '~/components/ui/Button';
import { OrderRowSkeleton } from '~/components/ui/Skeleton';
import { formatDateTime, formatMinorCurrency, useLocaleTag } from '~/i18n/format';
import { friendlyError } from '~/utils/error-messages';

/**
 * Loop-native orders list on the account/orders page. Fetches
 * `GET /api/orders/loop` and renders each order as a row linking to
 * `/orders/:id`, where the redemption payload lives.
 */
export function LoopOrdersList({ enabled }: { enabled: boolean }): React.JSX.Element | null {
  const { t } = useTranslation('orders');
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['loop-orders'],
    queryFn: () => listLoopOrders(),
    enabled,
    retry: shouldRetry,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  if (!enabled) return null;
  if (query.isPending) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <OrderRowSkeleton key={i} />
        ))}
      </div>
    );
  }
  if (query.isError) {
    const message =
      query.error instanceof ApiException && query.error.status === 401
        ? t('list.signInRequired')
        : friendlyError(query.error, t('list.loadErrorFallback'));
    return (
      <div className="text-center py-12">
        <p className="text-red-500 mb-4">{message}</p>
        <Button variant="secondary" onClick={() => void query.refetch()}>
          {t('list.retry')}
        </Button>
      </div>
    );
  }

  const orders = query.data.orders;
  if (orders.length === 0) {
    return (
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
    );
  }

  return (
    <section aria-label={t('list.ariaLabel')}>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
        {orders.map((order) => (
          <LoopOrderRow key={order.id} order={order} />
        ))}
      </ul>
    </section>
  );
}

function LoopOrderRow({ order }: { order: LoopOrderView }): React.JSX.Element {
  const { t } = useTranslation('orders');
  const { merchants } = useAllMerchants();
  const locale = useLocaleTag();
  const merchantName = merchants.find((m) => m.id === order.merchantId)?.name ?? order.merchantId;
  const amount = formatMinorCurrency(order.faceValueMinor, order.currency, locale);
  const date = formatDateTime(order.createdAt, locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const hasEarnedCashback = order.state === 'fulfilled' && order.userCashbackMinor !== '0';

  return (
    <li>
      <Link
        to={`/orders/${encodeURIComponent(order.id)}`}
        className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="font-medium text-gray-900 dark:text-white truncate">{merchantName}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{date}</div>
        </div>
        <div className="flex items-center gap-3 ms-4">
          <div className="text-end">
            <div className="text-sm font-semibold text-gray-900 dark:text-white tabular-nums">
              {amount}
            </div>
            {hasEarnedCashback ? (
              <div className="mt-0.5 text-[11px] font-medium text-green-700 dark:text-green-400 tabular-nums">
                {t('loopList.earnedCashback', {
                  amount: formatMinorCurrency(order.userCashbackMinor, order.currency, locale),
                })}
              </div>
            ) : null}
          </div>
          <LoopOrderStatePill state={order.state} />
        </div>
      </Link>
    </li>
  );
}

export function LoopOrderStatePill({
  state,
}: {
  state: LoopOrderView['state'];
}): React.JSX.Element {
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${stateColour(state)}`}>
      {loopOrderStateLabel(state)}
    </span>
  );
}

function stateColour(state: LoopOrderView['state']): string {
  switch (state) {
    case 'fulfilled':
      return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
    case 'rejected':
    case 'refunded':
      return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
    case 'expired':
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300';
    case 'unpaid':
    case 'paid':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
    default:
      return assertNever(state, 'OrderState');
  }
}
