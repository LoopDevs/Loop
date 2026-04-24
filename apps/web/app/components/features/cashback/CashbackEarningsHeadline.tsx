import { useQuery } from '@tanstack/react-query';
import { getCashbackSummary, type UserCashbackSummary } from '~/services/user';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';

/**
 * Formats a minor-unit amount as localised currency, falling back to
 * "<value> <code>" if Intl rejects the currency. Shared shape with
 * `fmtBalance` on the balance card but inlined here to keep the
 * two surfaces independently refactorable.
 */
export function fmtEarnings(minor: string, currency: string): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n / 100);
  } catch {
    return `${(n / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * Compact "earnings" strip for the /orders page (and any surface
 * that wants the two-number headline from the ADR 015 cashback
 * summary). Distinct from `CashbackBalanceCard`, which shows the
 * current undrawn balance — this one shows all-time earnings vs
 * this-month so the user sees their cashback accruing even after
 * they've withdrawn some.
 *
 * Hides itself entirely for users with zero lifetime earnings so
 * the orders page's empty state isn't muddled with a "£0 earned"
 * banner that reads as a bug. Silent on fetch error — the orders
 * list below is the user's actual goal.
 */
export function CashbackEarningsHeadline(): React.JSX.Element | null {
  // A2-1156: auth-gate so cold-start doesn't fire before session restore.
  const { isAuthenticated } = useAuth();
  const query = useQuery({
    queryKey: ['me', 'cashback-summary'],
    queryFn: getCashbackSummary,
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 60_000,
  });

  if (query.isPending || query.isError) return null;

  const summary: UserCashbackSummary = query.data;
  // Hide when the user has literally earned zero — no point showing
  // "£0 earned" above a (probably empty) orders list.
  if (summary.lifetimeMinor === '0') return null;

  const lifetime = fmtEarnings(summary.lifetimeMinor, summary.currency);
  const thisMonth = fmtEarnings(summary.thisMonthMinor, summary.currency);
  const hasMonthlyCashback = summary.thisMonthMinor !== '0';

  return (
    <section
      aria-label="Lifetime cashback earned"
      className="rounded-xl border border-green-100 bg-green-50 px-4 py-3 dark:border-green-900/50 dark:bg-green-900/10"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-wide font-medium text-green-700 dark:text-green-400">
            Earned with Loop
          </div>
          <div className="mt-0.5 text-xl font-semibold tabular-nums text-green-900 dark:text-green-100">
            {lifetime}
          </div>
        </div>
        {hasMonthlyCashback ? (
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wide font-medium text-green-700 dark:text-green-400">
              This month
            </div>
            <div className="mt-0.5 text-sm font-medium tabular-nums text-green-800 dark:text-green-200">
              +{thisMonth}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
