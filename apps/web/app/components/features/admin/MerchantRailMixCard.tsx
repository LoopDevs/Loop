import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import {
  getAdminMerchantPaymentMethodShare,
  type AdminPaymentMethod,
  type PaymentMethodShareBucket,
} from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { fmtPct, fmtPctBigint } from './PaymentMethodShareCard';

/**
 * Admin `/admin/merchants/:merchantId` — per-rail share on the one
 * merchant (#627). Merchant-scoped mirror of the fleet-wide
 * `PaymentMethodShareCard` on `/admin/cashback`.
 *
 * Answers "at this merchant, how are users actually paying?" — a
 * rising `loop_asset` share means users are recycling LOOP-asset
 * cashback into more orders from this specific merchant, the
 * per-merchant version of the ADR 015 flywheel signal.
 *
 * Reuses `fmtPct` + `fmtPctBigint` exports from the fleet card
 * rather than duplicating the bigint arithmetic. Reuses the same
 * `METHOD_ORDER` and pill classes locally so the two cards look
 * identical at a glance — pill placement, colour semantics, rail
 * labels.
 *
 * Zero-volume merchants render a neutral "no fulfilled orders"
 * line instead of the table (same principle as the other cards on
 * this page — admin surfaces must distinguish "empty" from
 * "crashed").
 */
const METHOD_ORDER: readonly AdminPaymentMethod[] = [
  'loop_asset',
  'credit',
  'usdc',
  'xlm',
] as const;

const METHOD_LABELS: Record<AdminPaymentMethod, string> = {
  loop_asset: 'LOOP asset',
  credit: 'Credit balance',
  usdc: 'USDC',
  xlm: 'XLM',
};

const METHOD_CLASSES: Record<AdminPaymentMethod, string> = {
  loop_asset: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  credit: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  usdc: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  xlm: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

export function MerchantRailMixCard({
  merchantId,
}: {
  merchantId: string;
}): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['admin-merchant-payment-method-share', merchantId, 'fulfilled'],
    queryFn: () => getAdminMerchantPaymentMethodShare(merchantId, { state: 'fulfilled' }),
    enabled: merchantId.length > 0,
    retry: shouldRetry,
    staleTime: 60_000,
  });

  return (
    <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">Rail mix</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          How users are paying for fulfilled orders at this merchant. A rising{' '}
          <span className="font-medium">LOOP asset</span> share is the per-merchant flywheel signal
          — cashback earned here, spent here again.
        </p>
      </header>
      <div className="p-6">
        <Body query={query} merchantId={merchantId} />
      </div>
    </section>
  );
}

function Body({
  query,
  merchantId,
}: {
  query: ReturnType<
    typeof useQuery<Awaited<ReturnType<typeof getAdminMerchantPaymentMethodShare>>>
  >;
  merchantId: string;
}): React.JSX.Element | null {
  if (query.isPending) return <Spinner />;

  if (query.isError) {
    if (query.error instanceof ApiException && query.error.status === 404) {
      return null;
    }
    return <p className="text-sm text-red-600 dark:text-red-400">Failed to load rail mix.</p>;
  }

  const snapshot = query.data;
  if (snapshot.totalOrders === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        No fulfilled orders yet — the rail mix is only meaningful once orders have landed.
      </p>
    );
  }

  const totalCharge = sumCharge(snapshot.byMethod);

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead>
          <tr className="text-left text-xs font-medium text-gray-500 dark:text-gray-400">
            <th className="px-3 py-2">Rail</th>
            <th className="px-3 py-2">Orders</th>
            <th className="px-3 py-2">% orders</th>
            <th className="px-3 py-2">% charge</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-900">
          {METHOD_ORDER.map((m) => {
            const bucket = snapshot.byMethod[m];
            // Drill into orders filtered by this merchant +
            // paymentMethod + state=fulfilled, the same framing
            // the card is showing so the deep-link stays coherent.
            const drillHref = `/admin/orders?merchantId=${encodeURIComponent(
              merchantId,
            )}&paymentMethod=${encodeURIComponent(m)}&state=fulfilled`;
            return (
              <tr key={m}>
                <td className="px-3 py-2">
                  <Link
                    to={drillHref}
                    className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 ${METHOD_CLASSES[m]}`}
                    aria-label={`Filter this merchant's orders by ${METHOD_LABELS[m]}`}
                  >
                    {METHOD_LABELS[m]}
                  </Link>
                </td>
                <td className="px-3 py-2 tabular-nums text-gray-900 dark:text-white">
                  {bucket.orderCount.toLocaleString('en-US')}
                </td>
                <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                  {fmtPct(bucket.orderCount, snapshot.totalOrders)}
                </td>
                <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                  {fmtPctBigint(bucket.chargeMinor, totalCharge)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function sumCharge(byMethod: Record<AdminPaymentMethod, PaymentMethodShareBucket>): bigint {
  let total = 0n;
  for (const m of METHOD_ORDER) {
    try {
      total += BigInt(byMethod[m].chargeMinor);
    } catch {
      /* malformed — skip, but keep summing the rest */
    }
  }
  return total;
}
