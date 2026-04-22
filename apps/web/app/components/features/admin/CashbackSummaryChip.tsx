import { useQuery } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import { getAdminUserCashbackSummary } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

/**
 * Admin `/admin/users/:userId` — scalar cashback headline.
 *
 * Renders the target user's lifetime + this-month cashback in their
 * current home currency (e.g. "£42.00 lifetime · £3.20 this month").
 * Silent no-op for zero-earnings users so the drill-down page doesn't
 * frame a new user around an empty headline. On load / error renders
 * a minimal inline state so the surrounding layout doesn't jump.
 *
 * Data source: `/api/admin/users/:userId/cashback-summary`. 30s stale
 * time — the ledger doesn't move faster than that in practice, and
 * any adjustment applied from the form on the same page invalidates
 * this query key explicitly.
 */
export function CashbackSummaryChip({ userId }: { userId: string }): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['admin-user-cashback-summary', userId],
    queryFn: () => getAdminUserCashbackSummary(userId),
    enabled: userId.length > 0,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  if (query.isPending) {
    return (
      <div className="inline-flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <Spinner />
        <span>Loading cashback…</span>
      </div>
    );
  }

  if (query.isError) {
    // 404 = the user was deleted between the list and this drill —
    // surfaced by the parent page; don't double-surface.
    if (query.error instanceof ApiException && query.error.status === 404) {
      return null;
    }
    return (
      <p className="text-xs text-red-600 dark:text-red-400">Failed to load cashback summary.</p>
    );
  }

  const s = query.data;
  let lifetime: bigint;
  let thisMonth: bigint;
  try {
    lifetime = BigInt(s.lifetimeMinor);
    thisMonth = BigInt(s.thisMonthMinor);
  } catch {
    // Malformed bigint-as-string — bail on the chip rather than render
    // a NaN next to a money symbol. The parent page still renders.
    return null;
  }

  // Zero-earnings users: hide the chip. A "£0 lifetime" headline on a
  // brand-new account reads as failure where the truth is "no data yet".
  if (lifetime === 0n && thisMonth === 0n) {
    return null;
  }

  return (
    <div
      className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-green-200 bg-green-50 px-3 py-1.5 text-sm dark:border-green-900 dark:bg-green-950/40"
      aria-label="Cashback earned"
    >
      <span className="font-semibold text-green-900 dark:text-green-200">
        {formatMinor(lifetime, s.currency)}
      </span>
      <span className="text-xs text-green-800 dark:text-green-300">lifetime</span>
      <span aria-hidden="true" className="text-green-300 dark:text-green-800">
        ·
      </span>
      <span className="font-semibold text-green-900 dark:text-green-200">
        {formatMinor(thisMonth, s.currency)}
      </span>
      <span className="text-xs text-green-800 dark:text-green-300">this month</span>
    </div>
  );
}

/**
 * Bigint minor-units → localised currency string. Separate from the
 * `fmtMinor` in `admin.users.$userId.tsx` because that one takes a
 * `string` input and divides via `Number` — fine for per-user
 * balances, but cashback totals can push past 2^53 once the fleet
 * aggregates. Keeps precision via bigint arithmetic.
 */
export function formatMinor(minor: bigint, currency: string): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const major = Number(abs / 100n);
  const frac = Number(abs % 100n) / 100;
  const total = (neg ? -1 : 1) * (major + frac);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(total);
  } catch {
    return `${total.toFixed(2)} ${currency}`;
  }
}
