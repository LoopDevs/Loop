import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ApiException,
  displayCurrencyCode,
  type AccountBalanceView,
  type SavingsOperationView,
  type SavingsPositionView,
} from '@loop/shared';
import { ACCOUNT_QUERY_KEY, useAccount } from '~/hooks/use-account';
import { formatAccountAmount, formatDateTime, useLocaleTag } from '~/i18n/format';
import { depositSavings, withdrawSavings } from '~/services/user';
import { Button } from '~/components/ui/Button';

type MoveKind = 'deposit' | 'withdraw';

interface MoveOption {
  currency: string;
  available: string;
}

const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;

const positive = (amount: string): boolean => Number(amount) > 0;

function depositOptions(wallet: readonly AccountBalanceView[]): MoveOption[] {
  return wallet
    .filter((b) => positive(b.amount))
    .map((b) => ({ currency: b.currency, available: b.amount }));
}

function withdrawOptions(savings: readonly SavingsPositionView[]): MoveOption[] {
  return savings
    .filter((s) => positive(s.available))
    .map((s) => ({ currency: s.currency, available: s.available }));
}

function formatApr(rate: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(rate);
}

export function SavingsCard(): React.JSX.Element {
  const { t } = useTranslation('settings');
  const locale = useLocaleTag();
  const { account, isLoading, isError } = useAccount();

  if (isLoading || isError || account === undefined) return <></>;

  const deposits = depositOptions(account.wallet);
  const withdrawals = withdrawOptions(account.savings);
  const pending = account.pendingOperations;
  if (account.savings.length === 0 && deposits.length === 0 && pending.length === 0) return <></>;

  return (
    <section
      aria-labelledby="savings-heading"
      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 space-y-5"
    >
      <div>
        <h2
          id="savings-heading"
          className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
        >
          {t('savings.heading')}
        </h2>
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{t('savings.intro')}</p>
      </div>

      {account.savings.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('savings.empty')}</p>
      ) : (
        <ul className="space-y-3">
          {account.savings.map((position) => (
            <li
              key={`${position.provider}:${position.currency}`}
              className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 px-4 py-3"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {displayCurrencyCode(position.currency)}
                </span>
                <span className="text-xl font-semibold tabular-nums text-gray-900 dark:text-white">
                  {formatAccountAmount(position.value, position.currency, locale)}
                </span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
                <dt>{t('savings.earnt')}</dt>
                <dd className="text-end tabular-nums text-green-700 dark:text-green-400">
                  +{formatAccountAmount(position.earnt, position.currency, locale)}
                </dd>
                <dt>{t('savings.available')}</dt>
                <dd className="text-end tabular-nums">
                  {formatAccountAmount(position.available, position.currency, locale)}
                </dd>
                {positive(position.locked) ? (
                  <>
                    <dt>{t('savings.locked')}</dt>
                    <dd className="text-end tabular-nums">
                      {formatAccountAmount(position.locked, position.currency, locale)}
                      {position.unlocksAt !== null ? (
                        <span className="ms-1">
                          ·{' '}
                          {t('savings.unlocks', {
                            when: formatDateTime(position.unlocksAt, locale),
                          })}
                        </span>
                      ) : null}
                    </dd>
                  </>
                ) : null}
              </dl>
              {position.estimatedApr !== null ? (
                <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
                  {t('savings.apr', { rate: formatApr(position.estimatedApr, locale) })}
                  {position.projectedYearlyEarnings !== null
                    ? ` · ${t('savings.projected', {
                        amount: formatAccountAmount(
                          position.projectedYearlyEarnings,
                          position.currency,
                          locale,
                        ),
                      })}`
                    : ''}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {pending.length > 0 ? (
        <ul className="space-y-1 text-xs text-gray-600 dark:text-gray-400">
          {pending.map((op) => (
            <li key={op.id} className="flex justify-between gap-3">
              <span>
                {t('savings.pending')} · {op.type}
              </span>
              <span className="tabular-nums">
                {formatAccountAmount(op.amount, op.currency, locale)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {deposits.length > 0 ? <MoveForm kind="deposit" options={deposits} /> : null}
        {withdrawals.length > 0 ? <MoveForm kind="withdraw" options={withdrawals} /> : null}
      </div>
    </section>
  );
}

function MoveForm({ kind, options }: { kind: MoveKind; options: MoveOption[] }): React.JSX.Element {
  const { t } = useTranslation('settings');
  const locale = useLocaleTag();
  const queryClient = useQueryClient();
  const [currency, setCurrency] = useState(options[0]?.currency ?? '');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const option = options.find((o) => o.currency === currency) ?? options[0];

  const mutation = useMutation({
    mutationFn: (body: { currency: string; amount: string }) =>
      kind === 'deposit' ? depositSavings(body) : withdrawSavings(body),
    onSuccess: (operation: SavingsOperationView) => {
      const formatted = formatAccountAmount(operation.amount, operation.currency, locale);
      setNotice(
        operation.status === 'complete'
          ? t(`savings.${kind}.done`, { amount: formatted })
          : t(`savings.${kind}.pendingDone`, { amount: formatted }),
      );
      setAmount('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY });
    },
    onError: (err) => {
      setNotice(null);
      setError(err instanceof ApiException ? err.message : t('savings.errors.fallback'));
    },
  });

  if (option === undefined) return <></>;

  const submit = (): void => {
    const trimmed = amount.trim();
    if (!AMOUNT_PATTERN.test(trimmed) || !positive(trimmed)) {
      setError(t('savings.errors.amount'));
      return;
    }
    if (Number(trimmed) > Number(option.available)) {
      setError(t('savings.errors.exceeds'));
      return;
    }
    setError(null);
    setNotice(null);
    mutation.mutate({ currency: option.currency, amount: trimmed });
  };

  const idPrefix = `savings-${kind}`;
  return (
    <form
      aria-labelledby={`${idPrefix}-heading`}
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3
        id={`${idPrefix}-heading`}
        className="text-sm font-semibold text-gray-900 dark:text-white"
      >
        {t(`savings.${kind}.heading`)}
      </h3>
      <label
        htmlFor={`${idPrefix}-currency`}
        className="block text-xs text-gray-600 dark:text-gray-400"
      >
        {t(`savings.${kind}.currency`)}
      </label>
      <select
        id={`${idPrefix}-currency`}
        value={option.currency}
        onChange={(event) => {
          setCurrency(event.target.value);
          setError(null);
        }}
        disabled={mutation.isPending || options.length <= 1}
        className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white"
      >
        {options.map((o) => (
          <option key={o.currency} value={o.currency}>
            {displayCurrencyCode(o.currency)}
          </option>
        ))}
      </select>
      <div className="flex items-baseline justify-between">
        <label
          htmlFor={`${idPrefix}-amount`}
          className="block text-xs text-gray-600 dark:text-gray-400"
        >
          {t(`savings.${kind}.amount`)}
        </label>
        <button
          type="button"
          onClick={() => {
            setAmount(option.available);
            setError(null);
          }}
          disabled={mutation.isPending}
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          {t(`savings.${kind}.max`, {
            amount: formatAccountAmount(option.available, option.currency, locale),
          })}
        </button>
      </div>
      <input
        id={`${idPrefix}-amount`}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={amount}
        onChange={(event) => {
          setAmount(event.target.value);
          if (error !== null) setError(null);
        }}
        disabled={mutation.isPending}
        className={`w-full rounded-lg border px-3 py-2 text-sm tabular-nums text-gray-900 dark:text-white bg-white dark:bg-gray-900 ${
          error !== null ? 'border-red-400' : 'border-gray-300 dark:border-gray-700'
        }`}
        placeholder="0.00"
      />
      {error !== null ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      {notice !== null ? (
        <p role="status" className="text-xs text-green-700 dark:text-green-400">
          {notice}
        </p>
      ) : null}
      <Button
        type="submit"
        variant="secondary"
        disabled={mutation.isPending || amount.trim() === ''}
      >
        {mutation.isPending ? t(`savings.${kind}.saving`) : t(`savings.${kind}.submit`)}
      </Button>
    </form>
  );
}
