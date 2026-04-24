import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useAllMerchants } from '~/hooks/use-merchants';
import { getOperatorMerchantMix, type OperatorMerchantMixRow } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { ADMIN_LOCALE } from '~/utils/locale';

const WINDOW_HOURS = 24;

function successPct(row: OperatorMerchantMixRow): string {
  if (row.orderCount <= 0) return '—';
  const pct = (row.fulfilledCount / row.orderCount) * 100;
  if (!Number.isFinite(pct)) return '—';
  return `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Per-operator merchant-mix card for
 * `/admin/operators/:operatorId` (ADR 013 / 022). Shows which
 * merchants this CTX operator is carrying over the last 24h —
 * the capacity-review view ("op-alpha-01 is pulling 40% of its
 * volume from a single merchant — concentration-risk?").
 *
 * Row merchant-name drills into the per-merchant admin drill;
 * row failed-count link pre-scopes /admin/orders to (operator,
 * merchant, state=failed) for direct triage. Merchant display
 * name is resolved from the catalog when available; otherwise
 * the raw id renders (evicted merchants leave no catalog row).
 */
export function OperatorMerchantMixCard({ operatorId }: { operatorId: string }): React.JSX.Element {
  const { merchants } = useAllMerchants();
  const nameById = new Map(merchants.map((m) => [m.id, m.name] as const));

  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const query = useQuery({
    queryKey: ['admin-operator-merchant-mix', operatorId, WINDOW_HOURS],
    queryFn: () => getOperatorMerchantMix(operatorId, { since }),
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

  if (query.isError) {
    return (
      <p className="py-4 text-sm text-red-600 dark:text-red-400">
        Failed to load merchant mix for this operator.
      </p>
    );
  }

  if (query.data.rows.length === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        This operator hasn&rsquo;t carried any orders in the last {WINDOW_HOURS} hours.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            {['Merchant', 'Orders', 'Fulfilled', 'Failed', 'Success', 'Last order'].map((h) => (
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
          {query.data.rows.map((r) => {
            const name = nameById.get(r.merchantId);
            return (
              <tr key={r.merchantId}>
                <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                  <Link
                    to={`/admin/merchants/${encodeURIComponent(r.merchantId)}`}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                    aria-label={`Open merchant detail for ${name ?? r.merchantId}`}
                  >
                    {name ?? r.merchantId}
                  </Link>
                  {name !== undefined ? (
                    <span className="ml-2 text-[10px] font-mono text-gray-400 dark:text-gray-500">
                      {r.merchantId}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                  {r.orderCount.toLocaleString(ADMIN_LOCALE)}
                </td>
                <td className="px-3 py-2 tabular-nums text-green-700 dark:text-green-400">
                  {r.fulfilledCount.toLocaleString(ADMIN_LOCALE)}
                </td>
                <td
                  className={`px-3 py-2 tabular-nums ${
                    r.failedCount > 0
                      ? 'text-red-700 dark:text-red-400 font-medium'
                      : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {r.failedCount > 0 ? (
                    <Link
                      to={`/admin/orders?state=failed&merchantId=${encodeURIComponent(r.merchantId)}&ctxOperatorId=${encodeURIComponent(operatorId)}`}
                      className="hover:underline"
                      aria-label={`Review ${r.failedCount} failed orders on ${r.merchantId} carried by this operator`}
                    >
                      {r.failedCount.toLocaleString(ADMIN_LOCALE)}
                    </Link>
                  ) : (
                    r.failedCount.toLocaleString(ADMIN_LOCALE)
                  )}
                </td>
                <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                  {successPct(r)}
                </td>
                <td
                  className="px-3 py-2 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400"
                  title={r.lastOrderAt}
                >
                  {fmtRelative(r.lastOrderAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
