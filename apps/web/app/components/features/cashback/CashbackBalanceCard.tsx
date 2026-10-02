import { displayCurrencyCode } from '@loop/shared';
import { useAccount } from '~/hooks/use-account';
import { formatAccountAmount, useLocaleTag } from '~/i18n/format';
import { Spinner } from '~/components/ui/Spinner';

export function CashbackBalanceCard(): React.JSX.Element {
  const locale = useLocaleTag();
  const { account, isLoading, isError } = useAccount();

  if (isLoading) {
    return (
      <section className="flex justify-center py-4">
        <Spinner />
      </section>
    );
  }
  if (isError || account === undefined) return <></>;

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
      {account.wallet.length === 0 ? (
        <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
          No cashback yet. Your first Loop order will show up here.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
          {account.wallet.map((b) => (
            <div
              key={b.currency}
              className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 px-4 py-3"
            >
              <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {displayCurrencyCode(b.currency)}
              </div>
              <div className="mt-0.5 text-xl font-semibold tabular-nums text-gray-900 dark:text-white">
                {formatAccountAmount(b.amount, b.currency, locale)}
              </div>
            </div>
          ))}
        </div>
      )}
      {account.savings.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Savings
          </h3>
          <dl className="mt-2 space-y-2">
            {account.savings.map((s) => (
              <div
                key={`${s.provider}:${s.currency}`}
                className="flex items-baseline justify-between gap-3 text-sm"
              >
                <dt className="text-gray-700 dark:text-gray-300">
                  {displayCurrencyCode(s.currency)}
                </dt>
                <dd className="tabular-nums text-gray-900 dark:text-white">
                  {formatAccountAmount(s.value, s.currency, locale)}
                  <span className="ms-2 text-xs text-green-700 dark:text-green-400">
                    +{formatAccountAmount(s.earnt, s.currency, locale)} earnt
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </section>
  );
}
