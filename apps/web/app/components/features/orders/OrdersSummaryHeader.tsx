import { useQuery } from '@tanstack/react-query';
import { getUserOrdersSummary, type UserOrdersSummary } from '~/services/user';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';

/**
 * Compact 5-number header for `/orders`: total, fulfilled, pending,
 * failed, lifetime spent. Consumes the single-query
 * `GET /api/users/me/orders/summary` endpoint (#584) so the page
 * doesn't have to page the full list just to render totals.
 *
 * Self-hides on pending (no flash-then-render), error (the orders
 * list below still loads independently), and zero-activity users
 * (new users don't need a "0 orders / £0 spent" card before they've
 * bought their first gift card — that's demoralising, and the
 * CashbackEarningsHeadline above already covers "what have I
 * earned so far?").
 *
 * One-minute staleness: the /orders list refetches on navigation
 * too, so we share that cadence rather than re-firing on every
 * mount.
 */
export function OrdersSummaryHeader(): React.JSX.Element | null {
  // A2-1156: auth-gate so cold-start doesn't fire before session restore.
  const { isAuthenticated } = useAuth();
  const query = useQuery({
    queryKey: ['me', 'orders', 'summary'],
    queryFn: getUserOrdersSummary,
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 60_000,
  });

  if (query.isPending || query.isError) return null;
  const summary = query.data;
  // Hide for zero-activity users — the whole point of this card is
  // the "look at your activity" framing; rendering four zeros is
  // worse than nothing.
  if (summary.totalOrders === 0) return null;

  return (
    <section
      aria-label="Orders summary"
      className="grid grid-cols-2 sm:grid-cols-4 gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900"
    >
      <Stat label="Total" value={summary.totalOrders.toLocaleString('en-US')} />
      <Stat label="Fulfilled" value={summary.fulfilledCount.toLocaleString('en-US')} />
      <Stat
        label="In flight"
        value={summary.pendingCount.toLocaleString('en-US')}
        emphasis={summary.pendingCount > 0 ? 'yellow' : 'neutral'}
      />
      <Stat label="Spent" value={formatMinor(summary.totalSpentMinor, summary.currency)} />
    </section>
  );
}

function Stat({
  label,
  value,
  emphasis = 'neutral',
}: {
  label: string;
  value: string;
  emphasis?: 'neutral' | 'yellow';
}): React.JSX.Element {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div
        className={`mt-0.5 text-lg font-semibold tabular-nums ${
          emphasis === 'yellow'
            ? 'text-yellow-700 dark:text-yellow-400'
            : 'text-gray-900 dark:text-white'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Renders a minor-unit bigint-string as a localised currency total
 * with no decimals. Falls back to `"—"` on non-numeric input so a
 * malformed response doesn't tear the header down.
 */
export function formatMinor(minor: string, currency: string): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(n / 100);
  } catch {
    return `${(n / 100).toFixed(0)} ${currency}`;
  }
}

/**
 * Re-exported for tests + for prospective consumers on the mobile
 * home dashboard. Kept alongside the header so the formatter and
 * the primary consumer stay in the same file.
 */
export type { UserOrdersSummary };
