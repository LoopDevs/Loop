import { useQuery } from '@tanstack/react-query';
import { getOrdersActivity } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Sparkline } from './Sparkline';
import { ADMIN_LOCALE } from '~/utils/locale';

const WINDOW_DAYS = 14;

/**
 * Orders-activity sparkline at the top of /admin/orders. Thin wrapper
 * around the generic `<Sparkline>` primitive — owns the fetch + the
 * orders-specific copy, delegates chrome.
 */
export function OrdersSparkline(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-orders-activity', WINDOW_DAYS],
    queryFn: () => getOrdersActivity(WINDOW_DAYS),
    retry: shouldRetry,
    staleTime: 60_000,
  });

  const days = query.data?.days ?? [];
  const createdSeries = days.map((d) => d.created);
  const fulfilledSeries = days.map((d) => d.fulfilled);
  const totalCreated = createdSeries.reduce((a, b) => a + b, 0);
  const totalFulfilled = fulfilledSeries.reduce((a, b) => a + b, 0);

  return (
    <Sparkline
      title={`Orders activity (${WINDOW_DAYS}d)`}
      subtitle={`${totalCreated.toLocaleString(ADMIN_LOCALE)} created · ${totalFulfilled.toLocaleString(ADMIN_LOCALE)} fulfilled`}
      ariaLabel={`Orders activity over the last ${WINDOW_DAYS} days: ${totalCreated} created, ${totalFulfilled} fulfilled`}
      isPending={query.isPending}
      isError={query.isError}
      errorMessage="Failed to load orders activity."
      series={[
        {
          label: 'Created',
          values: createdSeries,
          colorClass: 'text-blue-500/80 dark:text-blue-400/80',
          swatchClass: 'bg-blue-500/80',
        },
        {
          label: 'Fulfilled',
          values: fulfilledSeries,
          colorClass: 'text-green-500/70 dark:text-green-400/70',
          swatchClass: 'bg-green-500/70',
        },
      ]}
    />
  );
}

// Re-export for the existing test import.
export { toPoints } from './Sparkline';
