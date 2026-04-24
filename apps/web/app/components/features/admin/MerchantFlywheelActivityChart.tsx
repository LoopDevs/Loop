import { useQuery } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import {
  getAdminMerchantFlywheelActivity,
  type MerchantFlywheelActivityDay,
} from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Sparkline } from './Sparkline';
import { ADMIN_LOCALE } from '~/utils/locale';

const WINDOW_DAYS = 30;

/**
 * Per-merchant flywheel-activity sparkline (#641). Mounted on
 * `/admin/merchants/:merchantId`. Time-axis companion to the
 * scalar `MerchantFlywheelChip` (#624): the chip says "over the
 * 31-day window, 12% of orders here were LOOP-asset"; this
 * sparkline says "and here's how that 12% got there, day by
 * day".
 *
 * Two lines: recycled count (green, LOOP-asset orders per day)
 * and total fulfilled count (neutral blue baseline). The ratio
 * between the lines is the flywheel share at that day; a
 * diverging green line chasing the blue line is the shape of
 * pivot success.
 *
 * Zero-volume merchants render a neutral empty-state line;
 * 404 silent-null (catalog evicted between list and drill).
 */
export function MerchantFlywheelActivityChart({
  merchantId,
}: {
  merchantId: string;
}): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['admin-merchant-flywheel-activity', merchantId, WINDOW_DAYS],
    queryFn: () => getAdminMerchantFlywheelActivity(merchantId, WINDOW_DAYS),
    enabled: merchantId.length > 0,
    retry: shouldRetry,
    staleTime: 5 * 60 * 1000,
  });

  if (query.isError && query.error instanceof ApiException && query.error.status === 404) {
    return null;
  }

  const rows = query.data?.rows ?? [];
  const recycled = rows.map((r) => r.recycledCount);
  const total = rows.map((r) => r.totalCount);
  const totalRecycled = recycled.reduce((a, b) => a + b, 0);
  const totalOrders = total.reduce((a, b) => a + b, 0);

  // Empty-volume case — the backend zero-fills every day, so
  // `rows.length === WINDOW_DAYS` even for a merchant with no
  // orders. Detect empty by summed count, not by rows.length.
  const isEmpty = !query.isPending && !query.isError && totalOrders === 0;

  if (isEmpty) {
    return (
      <p
        className="py-4 text-sm text-gray-500 dark:text-gray-400"
        aria-label="Flywheel activity: no fulfilled orders yet"
      >
        No fulfilled orders in the last {WINDOW_DAYS} days — flywheel activity needs volume before
        the trajectory is meaningful.
      </p>
    );
  }

  const sharePct = totalOrders === 0 ? 0 : (totalRecycled / totalOrders) * 100;
  const subtitle =
    totalOrders === 0
      ? `${WINDOW_DAYS}d`
      : `${totalRecycled.toLocaleString(ADMIN_LOCALE)} / ${totalOrders.toLocaleString(ADMIN_LOCALE)} recycled · ${sharePct.toFixed(1)}%`;

  return (
    <Sparkline
      title={`Flywheel activity (${WINDOW_DAYS}d)`}
      subtitle={subtitle}
      ariaLabel={`Flywheel activity over the last ${WINDOW_DAYS} days, ${totalRecycled} of ${totalOrders} fulfilled orders paid with LOOP asset`}
      isPending={query.isPending}
      isError={query.isError}
      errorMessage="Failed to load flywheel activity."
      series={[
        {
          label: 'Recycled (loop_asset)',
          values: recycled,
          colorClass: 'text-green-500/80 dark:text-green-400/80',
          swatchClass: 'bg-green-500/80',
        },
        {
          label: 'Total fulfilled',
          values: total,
          colorClass: 'text-blue-500/50 dark:text-blue-400/50',
          swatchClass: 'bg-blue-500/50',
          dashArray: '3 3',
          strokeWidth: 1,
        },
      ]}
    />
  );
}

// Re-export so tests can import from the component module.
export type { MerchantFlywheelActivityDay };
