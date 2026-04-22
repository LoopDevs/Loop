import { useQuery } from '@tanstack/react-query';
import {
  getUserPaymentMethodShare,
  type UserPaymentMethod,
  type UserPaymentMethodBucket,
} from '~/services/user';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { fmtPct, fmtPctBigint } from '~/components/features/admin/PaymentMethodShareCard';

/**
 * User-facing rail-mix card (#643) — self-view of the admin
 * rail-mix triplet already live on `/admin/cashback`,
 * `/admin/merchants/:id`, and `/admin/users/:id`.
 *
 * Answers the user's question: "how am I paying for gift cards?"
 * and points at the ADR 015 flywheel: a 0% LOOP-asset share is
 * the clearest app-facing nudge to pick LOOP at next checkout so
 * cashback compounds; a 60% LOOP share is positive reinforcement
 * that the strategy is working.
 *
 * Reuses `fmtPct` + `fmtPctBigint` exports from the admin card
 * rather than duplicating bigint percentage arithmetic — three
 * admin surfaces + this user surface share the same math.
 *
 * Self-hides on loading / error / zero-orders — /settings/cashback
 * is a user-facing surface where an empty or failed card is
 * worse than an absent card. The motivational framing on "you
 * haven't recycled anything yet" lives in `FlywheelChip`;
 * doubling up here would crowd the page.
 */
const METHOD_ORDER: readonly UserPaymentMethod[] = ['loop_asset', 'credit', 'usdc', 'xlm'] as const;

const METHOD_LABELS: Record<UserPaymentMethod, string> = {
  loop_asset: 'LOOP asset',
  credit: 'Credit balance',
  usdc: 'USDC',
  xlm: 'XLM',
};

const METHOD_CLASSES: Record<UserPaymentMethod, string> = {
  loop_asset: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  credit: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  usdc: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  xlm: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

export function RailMixCard(): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['me', 'payment-method-share', 'fulfilled'],
    queryFn: () => getUserPaymentMethodShare({ state: 'fulfilled' }),
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

  // Silent self-hide on error — user-facing, not dashboard.
  // FlywheelChip above carries the primary recycled-vs-total
  // signal, so a failed rail-mix card doesn't starve the page.
  if (query.isError) return null;

  const snapshot = query.data;
  if (snapshot.totalOrders === 0) return null;

  const totalCharge = sumCharge(snapshot.byMethod);

  return (
    <section
      className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
      aria-label="Your rail mix"
    >
      <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">Your rail mix</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          How you&rsquo;ve paid for fulfilled orders in {snapshot.currency}. Paying with{' '}
          <span className="font-medium text-green-700 dark:text-green-400">LOOP asset</span>{' '}
          recycles your earned cashback into more cashback — the more you use it, the more
          compounds.
        </p>
      </header>
      <div className="p-6 overflow-x-auto">
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
              return (
                <tr key={m}>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${METHOD_CLASSES[m]}`}
                    >
                      {METHOD_LABELS[m]}
                    </span>
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
    </section>
  );
}

function sumCharge(byMethod: Record<UserPaymentMethod, UserPaymentMethodBucket>): bigint {
  let total = 0n;
  for (const m of METHOD_ORDER) {
    try {
      total += BigInt(byMethod[m].chargeMinor);
    } catch {
      /* malformed — skip */
    }
  }
  return total;
}
