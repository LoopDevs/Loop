import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getUserOrdersSummary, type UserOrdersSummary } from '~/services/user';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';
import { formatMinorCurrency, formatNumber, useLocaleTag } from '~/i18n/format';

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
  const { t } = useTranslation('orders');
  // A2-1156: auth-gate so cold-start doesn't fire before session restore.
  const { isAuthenticated } = useAuth();
  const locale = useLocaleTag();
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
      aria-label={t('summary.ariaLabel')}
      className="grid grid-cols-2 sm:grid-cols-4 gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900"
    >
      <Stat label={t('summary.total')} value={formatNumber(summary.totalOrders, locale)} />
      <Stat label={t('summary.fulfilled')} value={formatNumber(summary.fulfilledCount, locale)} />
      <Stat
        label={t('summary.inFlight')}
        value={formatNumber(summary.pendingCount, locale)}
        emphasis={summary.pendingCount > 0 ? 'yellow' : 'neutral'}
      />
      <Stat
        label={t('summary.spent')}
        value={formatMinor(summary.totalSpentMinor, summary.currency, locale)}
      />
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
 * Renders a minor-unit bigint-string as a currency total with no
 * decimals, in the active route locale (CF-22) via the shared
 * bigint-exact formatter. Em-dash on non-numeric input so a malformed
 * response doesn't tear the header down. `locale` defaults to `en-US`
 * for direct (non-component) callers.
 */
export function formatMinor(minor: string, currency: string, locale?: string): string {
  if (!Number.isFinite(Number(minor))) return '—';
  return formatMinorCurrency(minor, currency, locale, { fractionDigits: 0 });
}

/**
 * Re-exported for tests + for prospective consumers on the mobile
 * home dashboard. Kept alongside the header so the formatter and
 * the primary consumer stay in the same file.
 */
export type { UserOrdersSummary };
