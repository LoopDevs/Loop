import { useQuery } from '@tanstack/react-query';
import { getCtxCommission } from '~/services/admin-ctx-commission';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { ADMIN_LOCALE } from '~/utils/locale';

/**
 * CTX operator-commission card for /admin/treasury (ctx-interop).
 *
 * CTX's record of what it owes Loop back for attributed orders: the
 * per-currency unsettled commission balance plus the most recent
 * settlements (each carrying the gift-card ids it covered, the
 * traceability link back to Loop orders via `operatorReference`).
 * Renders next to the supplier-spend card — Loop's own record of the
 * same traffic — so ops can eyeball the two against each other; a
 * drifting pair is the cross-company reconciliation alarm.
 *
 * `configured: false` (CTX API creds unset on the backend — the
 * company id itself is resolved from CTX `GET /me`, not configured)
 * renders a setup hint rather than an error.
 */
export function CtxCommissionCard(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-ctx-commission'],
    queryFn: getCtxCommission,
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
      <p className="py-4 text-sm text-red-600 dark:text-red-400">Failed to load CTX commission.</p>
    );
  }

  if (!query.data.configured) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        CTX commission is not configured — set the CTX API credentials (
        <code>GIFT_CARD_API_KEY</code> / <code>GIFT_CARD_API_SECRET</code>) on the backend to enable
        it.
      </p>
    );
  }

  const balances = query.data.balances ?? [];
  const settlements = query.data.settlements ?? [];

  return (
    <div className="space-y-4">
      {balances.length === 0 ? (
        <p className="py-2 text-sm text-gray-500 dark:text-gray-400">
          No unsettled commission at CTX.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                {['Currency', 'Unsettled balance', 'Entries'].map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-start font-medium text-gray-500 dark:text-gray-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800/60">
              {balances.map((row) => (
                <tr key={row.currency}>
                  <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100">
                    {row.currency}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-gray-900 dark:text-gray-100">
                    {row.amount}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-gray-500 dark:text-gray-400">
                    {row.entryCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
          Recent settlements
          {query.data.lastSettlementAt !== undefined && (
            <span className="ms-2 font-normal text-gray-500 dark:text-gray-400">
              (last:{' '}
              {new Date(query.data.lastSettlementAt).toLocaleString(ADMIN_LOCALE, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
              )
            </span>
          )}
        </h3>
        {settlements.length === 0 ? (
          <p className="py-2 text-sm text-gray-500 dark:text-gray-400">No settlements yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  {['Settled', 'Amount', 'Currency', 'Orders', 'Period'].map((h) => (
                    <th
                      key={h}
                      className="px-3 py-2 text-start font-medium text-gray-500 dark:text-gray-400"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800/60">
                {settlements.map((row) => (
                  <tr key={row.id}>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-900 dark:text-gray-100">
                      {new Date(row.created).toLocaleString(ADMIN_LOCALE, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-gray-900 dark:text-gray-100">
                      {row.amount}
                    </td>
                    <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{row.currency}</td>
                    <td className="px-3 py-2 tabular-nums text-gray-500 dark:text-gray-400">
                      {row.giftCardIds.length}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-500 dark:text-gray-400">
                      {new Date(row.periodStart).toLocaleDateString(ADMIN_LOCALE)} –{' '}
                      {new Date(row.periodEnd).toLocaleDateString(ADMIN_LOCALE)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
