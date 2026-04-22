import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getAdminMerchantsFlywheelShare, type MerchantFlywheelShareRow } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { pctBigint } from '~/components/features/cashback/FlywheelChip';
import { Spinner } from '~/components/ui/Spinner';

/**
 * `/admin/cashback` — per-merchant flywheel leaderboard (#602).
 *
 * Ranks merchants by how many of their fulfilled orders came through
 * the LOOP-asset rail (recycled cashback). The merchant-axis cousin
 * of `PaymentMethodShareCard` (fleet snapshot) and
 * `PaymentMethodActivityChart` (time-series) — together they tell
 * the ADR-015 flywheel story across the three axes that matter
 * (rail, time, merchant).
 *
 * Self-hides on error / empty — ops reads this list alongside the
 * merchant-stats table above it, which already covers the general
 * merchant landscape. A leaderboard full of "no data yet" errors
 * would just be noise.
 *
 * Each row deep-links to `/admin/orders?merchantId=<slug>&paymentMethod=
 * loop_asset&state=fulfilled` so the ranking is two clicks from the
 * underlying orders — consistent with the per-rail drill-in on the
 * share card above.
 */
export function MerchantsFlywheelShareCard(): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['admin-merchants-flywheel-share'],
    queryFn: () => getAdminMerchantsFlywheelShare({ limit: 25 }),
    retry: shouldRetry,
    staleTime: 60_000,
  });

  if (query.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  if (query.isError) return null;

  const rows = query.data.rows;
  if (rows.length === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No merchants with recycled-cashback orders in the last 31 days yet — the leaderboard lights
        up once LOOP-asset paid orders start landing.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            {['Merchant', 'Recycled', 'Total', '% orders', '% charge'].map((h) => (
              <th
                key={h}
                className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-900 bg-white dark:bg-gray-900">
          {rows.map((r) => (
            <FlywheelRow key={r.merchantId} row={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FlywheelRow({ row }: { row: MerchantFlywheelShareRow }): React.JSX.Element {
  const pctOrders =
    row.totalFulfilledCount > 0
      ? `${((row.recycledOrderCount / row.totalFulfilledCount) * 100).toFixed(1)}%`
      : '—';
  let pctCharge: string;
  try {
    const recycled = BigInt(row.recycledChargeMinor);
    const total = BigInt(row.totalChargeMinor);
    pctCharge = pctBigint(recycled, total) ?? '—';
  } catch {
    // Malformed bigint from server — render em-dash rather than
    // tear the whole row down.
    pctCharge = '—';
  }
  const drillHref = `/admin/orders?merchantId=${encodeURIComponent(row.merchantId)}&paymentMethod=loop_asset&state=fulfilled`;

  return (
    <tr>
      <td className="px-3 py-2">
        <Link
          to={drillHref}
          className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
          title={row.merchantId}
          aria-label={`Drill into recycled orders for ${row.merchantId}`}
        >
          {row.merchantId}
        </Link>
      </td>
      <td className="px-3 py-2 tabular-nums text-gray-900 dark:text-white">
        {row.recycledOrderCount.toLocaleString('en-US')}
      </td>
      <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
        {row.totalFulfilledCount.toLocaleString('en-US')}
      </td>
      <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">{pctOrders}</td>
      <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">{pctCharge}</td>
    </tr>
  );
}
