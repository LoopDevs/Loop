import { useQuery } from '@tanstack/react-query';
import { LocaleLink as Link } from '~/components/ui/LocaleLink';
import { merchantSlug } from '@loop/shared';
import { getCashbackByMerchant, type CashbackByMerchantRow } from '~/services/user';
import { useAllMerchants } from '~/hooks/use-merchants';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { formatMinorCurrency, useLocaleTag } from '~/i18n/format';

/**
 * Formats a non-negative minor amount as currency in the active route
 * locale (CF-22) via the shared bigint-exact formatter — same em-dash
 * fallback as the other cashback cards so users never see a bare `NaN`.
 * `locale` defaults to `en-US` for direct (non-component) callers.
 */
export function fmtCashback(minor: string, currency: string, locale?: string): string {
  if (!Number.isFinite(Number(minor))) return '—';
  return formatMinorCurrency(minor, currency, locale);
}

/**
 * "Earned by merchant" card for /settings/cashback. Answers the
 * question "which merchants do I actually earn cashback from?" —
 * complements the balance card (undrawn) + the lifetime headline
 * (all-time) + the ledger page (per-event detail).
 *
 * Uses the in-memory merchant catalog to resolve display names,
 * falling back to the raw slug when a merchant has been removed
 * from the catalog (possible for legacy orders). Each row links
 * to the gift-card purchase page so a returning user can buy
 * from a merchant they've earned with before.
 *
 * Hides itself silently for users with no cashback in the window
 * (the ledger section below tells the empty-state story) and on
 * fetch error (the authoritative history is the ledger).
 */
export function CashbackByMerchantCard(): React.JSX.Element | null {
  // A2-1156: auth-gate so cold-start doesn't fire before session restore.
  const { isAuthenticated } = useAuth();
  const locale = useLocaleTag();
  const query = useQuery({
    queryKey: ['me', 'cashback-by-merchant'],
    queryFn: () => getCashbackByMerchant({ limit: 10 }),
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 60_000,
  });
  const { merchants } = useAllMerchants();

  if (query.isPending) {
    return (
      <section className="flex justify-center py-4">
        <Spinner />
      </section>
    );
  }
  if (query.isError) return null;
  if (query.data.rows.length === 0) return null;

  const currency = query.data.currency;
  // Resolve the full catalog row so the link uses the country-aware
  // merchantSlug. Falls back to the raw id (name + slug) when the merchant
  // has been removed from the catalog (possible for legacy orders).
  const resolve = (id: string): { name: string; slug: string } => {
    const m = merchants.find((x) => x.id === id);
    return m !== undefined ? { name: m.name, slug: merchantSlug(m) } : { name: id, slug: id };
  };

  return (
    <section
      aria-labelledby="cashback-by-merchant-heading"
      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
    >
      <header className="px-5 pt-4 pb-3">
        <h2
          id="cashback-by-merchant-heading"
          className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
        >
          Earned by merchant
        </h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Where your cashback comes from — last 180 days.
        </p>
      </header>
      <ul role="list" className="divide-y divide-gray-100 dark:divide-gray-900">
        {query.data.rows.map((row: CashbackByMerchantRow) => {
          const { name, slug } = resolve(row.merchantId);
          return (
            <li key={row.merchantId} className="flex items-center justify-between px-5 py-3">
              <div className="min-w-0">
                <Link
                  to={`/gift-card/${slug}`}
                  className="text-sm font-medium text-gray-900 dark:text-white hover:underline truncate"
                >
                  {name}
                </Link>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {row.orderCount} {row.orderCount === 1 ? 'order' : 'orders'}
                </p>
              </div>
              <p className="ml-3 shrink-0 text-sm font-semibold tabular-nums text-green-700 dark:text-green-400">
                +{fmtCashback(row.cashbackMinor, currency, locale)}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
