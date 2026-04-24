import { useQuery } from '@tanstack/react-query';
import { ApiException, pctBigint } from '@loop/shared';
import { getAdminMerchantFlywheelStats } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { ADMIN_LOCALE } from '~/utils/locale';

/**
 * Admin `/admin/merchants/:merchantId` — recycled-vs-total flywheel
 * chip (#624). Sibling of `AdminUserFlywheelChip` on the user drill,
 * scoped to a single merchant's 31-day fulfilled volume.
 *
 * Difference vs. the user-variant: no currency-denominated charge
 * total. Per-merchant volume can span multiple user home_currencies
 * so summing chargeMinor without a common denomination would be
 * misleading. The chip shows count + by-count percentage and a
 * by-charge percentage (unitless, so safe across currencies) — the
 * same rendering the `/admin/cashback` leaderboard row uses
 * (MerchantsFlywheelShareCard).
 *
 * Behaviour:
 *   - Doesn't self-hide on zero-volume merchants. Admins need to
 *     distinguish "catalog merchant with no orders yet" from
 *     "component crashed" on an ops surface.
 *   - Silent no-op on 404 (merchant deleted/evicted between list and
 *     drill — the page header already surfaces the evicted copy).
 *   - Red inline error on non-404 failure.
 */
export function MerchantFlywheelChip({
  merchantId,
}: {
  merchantId: string;
}): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['admin-merchant-flywheel-stats', merchantId],
    queryFn: () => getAdminMerchantFlywheelStats(merchantId),
    enabled: merchantId.length > 0,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  if (query.isPending) {
    return (
      <div className="inline-flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <Spinner />
        <span>Loading flywheel…</span>
      </div>
    );
  }

  if (query.isError) {
    if (query.error instanceof ApiException && query.error.status === 404) {
      return null;
    }
    return <p className="text-xs text-red-600 dark:text-red-400">Failed to load flywheel stats.</p>;
  }

  const stats = query.data;

  if (stats.totalFulfilledCount === 0) {
    return (
      <p
        className="text-xs text-gray-500 dark:text-gray-400"
        aria-label="Flywheel: no fulfilled orders yet"
      >
        No fulfilled orders in the last 31 days.
      </p>
    );
  }

  if (stats.recycledOrderCount === 0) {
    return (
      <p
        className="text-xs text-gray-500 dark:text-gray-400"
        aria-label="Flywheel: no recycled orders yet"
      >
        No recycled orders yet — {stats.totalFulfilledCount.toLocaleString(ADMIN_LOCALE)} fulfilled
        in the last 31 days, none paid with LOOP asset.
      </p>
    );
  }

  const pctOrders = `${((stats.recycledOrderCount / stats.totalFulfilledCount) * 100).toFixed(1)}%`;
  let pctCharge: string | null = null;
  try {
    pctCharge = pctBigint(BigInt(stats.recycledChargeMinor), BigInt(stats.totalChargeMinor));
  } catch {
    // Malformed bigint — show by-count only rather than tear the chip down.
    pctCharge = null;
  }

  return (
    <div
      className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-green-200 bg-green-50 px-3 py-1.5 text-sm dark:border-green-900 dark:bg-green-950/40"
      aria-label="Flywheel stats"
    >
      <span className="font-semibold text-green-900 dark:text-green-200">
        {stats.recycledOrderCount.toLocaleString(ADMIN_LOCALE)} recycled
      </span>
      <span className="text-xs text-green-800 dark:text-green-300">
        / {stats.totalFulfilledCount.toLocaleString(ADMIN_LOCALE)} fulfilled · {pctOrders} by count
      </span>
      {pctCharge !== null ? (
        <>
          <span aria-hidden="true" className="text-green-300 dark:text-green-800">
            ·
          </span>
          <span className="text-xs text-green-800 dark:text-green-300">{pctCharge} by charge</span>
        </>
      ) : null}
    </div>
  );
}
