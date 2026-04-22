import { useQuery } from '@tanstack/react-query';
import {
  getPaymentMethodShare,
  type AdminPaymentMethod,
  type PaymentMethodShareBucket,
} from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

/**
 * Stable render order + copy for the four rails. Kept outside the
 * component so the UI layout is identical across renders (the
 * backend already zero-fills, but the order on the backend is
 * group-by arbitrary — we pin it here).
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

/**
 * Per-method pill colour. `loop_asset` gets the positive (green)
 * treatment because a rising share of this rail is the exact
 * signal ADR 010 / 015's cashback-flywheel strategy is working —
 * users are recycling on-ledger LOOP cashback into more orders.
 * Everything else is neutral.
 */
const METHOD_CLASSES: Record<AdminPaymentMethod, string> = {
  loop_asset: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  credit: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  usdc: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  xlm: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

/**
 * Admin treasury card — the cashback-flywheel indicator. Renders the
 * per-rail share across fulfilled orders: % of orders, % of charge
 * value, raw count. A rising `loop_asset` share is the ADR 015
 * success criterion — users earned cashback, then spent it on more
 * gift cards, closing the loop.
 *
 * Self-hides on loading (spinner) / error. Zero-total renders the
 * "no fulfilled orders yet" empty state rather than a card full of
 * NaN%.
 *
 * 60s staleness matches the siblings on /admin/treasury.
 */
export function PaymentMethodShareCard(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-payment-method-share', 'fulfilled'],
    queryFn: () => getPaymentMethodShare({ state: 'fulfilled' }),
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
        Failed to load payment-method share.
      </p>
    );
  }

  const snapshot = query.data;
  if (snapshot.totalOrders === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No fulfilled orders yet — the flywheel needs first-order volume before the mix is
        meaningful.
      </p>
    );
  }

  const totalCharge = sumCharge(snapshot.byMethod);

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            {['Rail', 'Orders', '% orders', '% charge'].map((h) => (
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
          {METHOD_ORDER.map((m) => {
            const bucket = snapshot.byMethod[m];
            return (
              <tr key={m}>
                <td className="px-3 py-2">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${METHOD_CLASSES[m]}`}
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
  );
}

/**
 * Integer-share formatter. `fmtPct(390, 448)` → `"87.1%"`. One
 * decimal place is the sweet spot for "how big is the flywheel"
 * at a glance without drowning the cell in digits.
 */
export function fmtPct(numerator: number, denominator: number): string {
  if (denominator <= 0) return '—';
  const pct = (numerator / denominator) * 100;
  if (!Number.isFinite(pct)) return '—';
  return `${pct.toFixed(1)}%`;
}

/**
 * BigInt-safe variant for the charge column — fleet-wide charge
 * totals can exceed `Number.MAX_SAFE_INTEGER` once the user base
 * is large enough. Does the division with BigInt arithmetic and
 * formats to one decimal.
 */
export function fmtPctBigint(valueMinor: string, totalMinor: bigint): string {
  if (totalMinor === 0n) return '—';
  let v: bigint;
  try {
    v = BigInt(valueMinor);
  } catch {
    return '—';
  }
  // value / total * 100 → basis-points (×100) to keep one decimal
  // after dividing by 1000.
  const pct = Number((v * 10000n) / totalMinor) / 100;
  return `${pct.toFixed(1)}%`;
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
