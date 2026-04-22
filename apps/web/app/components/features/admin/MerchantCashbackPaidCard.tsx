import { useQuery } from '@tanstack/react-query';
import { ApiException, formatMinorCurrency, pctBigint } from '@loop/shared';
import { getAdminMerchantCashbackSummary } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

/**
 * Admin `/admin/merchants/:merchantId` — lifetime cashback paid
 * out to users on this merchant's fulfilled orders (#625).
 *
 * Per-currency rows instead of one total. Per-merchant volume can
 * span multiple user home_currencies, so mixing them into one
 * number has no coherent denomination. One row per charge
 * currency; each row shows the count, the cashback total formatted
 * in its currency, and "cashback as % of spend" for context.
 *
 * Zero-volume merchants render a neutral "no fulfilled orders"
 * line rather than the table — the card deliberately doesn't
 * silent-hide (ops needs to see "we haven't paid out anything
 * here" vs. a crashed component).
 *
 * 404 → silent no-op (merchant evicted between list and drill).
 */
export function MerchantCashbackPaidCard({
  merchantId,
}: {
  merchantId: string;
}): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['admin-merchant-cashback-summary', merchantId],
    queryFn: () => getAdminMerchantCashbackSummary(merchantId),
    enabled: merchantId.length > 0,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  return (
    <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">Cashback paid out</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Sum of <code>user_cashback_minor</code> on fulfilled orders at this merchant, grouped by
          the currency the user was charged in. Sourced from the pinned per-order values, not the
          ledger — so the number never drifts from the cashback-config audit trail.
        </p>
      </header>
      <div className="p-6">
        <Body query={query} />
      </div>
    </section>
  );
}

function Body({
  query,
}: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getAdminMerchantCashbackSummary>>>>;
}): React.JSX.Element | null {
  if (query.isPending) return <Spinner />;

  if (query.isError) {
    if (query.error instanceof ApiException && query.error.status === 404) {
      return null;
    }
    return (
      <p className="text-sm text-red-600 dark:text-red-400">Failed to load cashback summary.</p>
    );
  }

  const stats = query.data;

  if (stats.totalFulfilledCount === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        No fulfilled orders yet — no cashback has been paid out for this merchant.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead>
          <tr className="text-left text-xs font-medium text-gray-500 dark:text-gray-400">
            <th className="px-3 py-2">Currency</th>
            <th className="px-3 py-2">Fulfilled</th>
            <th className="px-3 py-2">Cashback paid out</th>
            <th className="px-3 py-2">% of spend</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-900">
          {stats.currencies.map((bucket) => {
            let cashback: bigint;
            let charge: bigint;
            try {
              cashback = BigInt(bucket.lifetimeCashbackMinor);
              charge = BigInt(bucket.lifetimeChargeMinor);
            } catch {
              // Skip malformed rows rather than tear the whole table down.
              return null;
            }
            const pct = pctBigint(cashback, charge);
            return (
              <tr key={bucket.currency}>
                <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">
                  {bucket.currency}
                </td>
                <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                  {bucket.fulfilledCount.toLocaleString('en-US')}
                </td>
                <td className="px-3 py-2 tabular-nums font-semibold text-green-700 dark:text-green-300">
                  {formatMinorCurrency(cashback, bucket.currency)}
                </td>
                <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                  {pct ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
