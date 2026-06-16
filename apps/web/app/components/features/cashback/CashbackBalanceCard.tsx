import { useQuery } from '@tanstack/react-query';
import { getMyCredits, type UserCreditRow } from '~/services/user';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { formatMinorCurrency, useLocaleTag } from '~/i18n/format';

/**
 * Formats a non-negative minor-unit balance as currency in the active
 * route locale (CF-22). Delegates to the shared bigint-exact formatter
 * so grouping/decimals/symbol all follow the `/:country/:lang` market;
 * a non-numeric row renders an em-dash rather than `NaN`. `locale`
 * defaults to `en-US` so direct (non-component) callers — e.g. unit
 * tests — keep a stable output.
 */
export function fmtBalance(balanceMinor: string, currency: string, locale?: string): string {
  if (!Number.isFinite(Number(balanceMinor))) return '—';
  return formatMinorCurrency(balanceMinor, currency, locale);
}

/**
 * "Your cashback balance" card for /settings/cashback. Renders a
 * single tile per currency — most users will only ever see one, but
 * the layout scales to the multi-currency edge case (home-currency
 * flip, admin adjustment in a non-home currency).
 *
 * Never surfaces a loud error — cashback history below is the
 * authoritative ledger view. A quiet em-dash is better than a red
 * banner above the ledger that the ledger itself will disprove.
 */
export function CashbackBalanceCard(): React.JSX.Element {
  // A2-1156: gate on isAuthenticated so cold-start doesn't fire a 401
  // before session restore completes.
  const { isAuthenticated } = useAuth();
  const locale = useLocaleTag();
  const query = useQuery({
    queryKey: ['me', 'credits'],
    queryFn: getMyCredits,
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  if (query.isPending) {
    return (
      <section className="flex justify-center py-4">
        <Spinner />
      </section>
    );
  }

  // Silent fail — the off-chain ledger view below tells the full story.
  if (query.isError) return <></>;

  const rows = query.data.credits;

  return (
    <section
      aria-labelledby="balance-heading"
      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5"
    >
      <h2
        id="balance-heading"
        className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
      >
        Your cashback balance
      </h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
          No cashback yet. Your first Loop order will show up here.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
          {rows.map((r: UserCreditRow) => (
            <div
              key={r.currency}
              className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 px-4 py-3"
            >
              <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {r.currency}
              </div>
              <div className="mt-0.5 text-xl font-semibold tabular-nums text-gray-900 dark:text-white">
                {fmtBalance(r.balanceMinor, r.currency, locale)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
