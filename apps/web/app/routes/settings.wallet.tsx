import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  ApiException,
  HOME_CURRENCIES,
  displayCurrencyCode,
  heldStableForCurrency,
  type HomeCurrency,
} from '@loop/shared';
import type { Route } from './+types/settings.wallet';
import i18n from '~/i18n/i18next';
import { useAuth } from '~/hooks/use-auth';
import { ACCOUNT_QUERY_KEY, useAccount } from '~/hooks/use-account';
import {
  getMe,
  linkWallet,
  setCashbackDestination,
  setHomeCurrency,
  unlinkWallet,
  updateWallet,
  type CashbackDestination,
  type UserMeView,
} from '~/services/user';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { PayoutsCard } from '~/components/features/cashback/PayoutsCard';
import { copyToClipboard } from '~/native/clipboard';
import { Phase2Gate } from '~/components/Phase2Gate';
import { Navbar } from '~/components/features/Navbar';
import { PageHeader } from '~/components/ui/PageHeader';
import { useNativePlatform } from '~/hooks/use-native-platform';

export function meta(): Route.MetaDescriptors {
  return [{ title: i18n.t('settings:wallet.meta.title') }];
}

export function ErrorBoundary(): React.JSX.Element {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <main className="max-w-2xl mx-auto px-6 py-12 text-center">
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
        {t('common:errorBoundary.heading')}
      </h1>
      <p className="text-gray-600 dark:text-gray-300 mb-6">{t('settings:errorBoundary.body')}</p>
      <a href="/settings/wallet" className="text-blue-600 underline">
        {t('settings:errorBoundary.retry')}
      </a>
    </main>
  );
}

export default function SettingsWalletRoute(): React.JSX.Element {
  const { t } = useTranslation('settings');
  const { isNative } = useNativePlatform();
  return (
    <Phase2Gate>
      {!isNative && <Navbar />}
      <PageHeader title={t('wallet.heading')} fallbackHref="/auth" />
      <SettingsWalletBody />
    </Phase2Gate>
  );
}

const CARD =
  'rounded-xl border border-gray-200 dark:border-gray-800 p-5 bg-white dark:bg-gray-900 space-y-4';
const SECONDARY_BUTTON =
  'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800';

function SettingsWalletBody(): React.JSX.Element {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const { isNative } = useNativePlatform();
  const mainPad = isNative ? 'pt-16 pb-4' : 'pt-28 pb-8';
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: getMe,
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 60_000,
  });
  const { account, activeLink, isLoading: accountLoading, isError: accountError } = useAccount();

  const [draftAddress, setDraftAddress] = useState<string>('');
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [currencyError, setCurrencyError] = useState<string | null>(null);
  const [destinationError, setDestinationError] = useState<string | null>(null);

  const invalidateAccount = (): void => {
    void queryClient.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY });
  };
  const linkMutation = useMutation({
    mutationFn: (address: string) => linkWallet({ chain: 'XLM', address }),
    onSuccess: () => {
      setDraftAddress('');
      setFormError(null);
      invalidateAccount();
    },
    onError: (err) => {
      setFormError(err instanceof ApiException ? err.message : t('wallet.link.fallbackError'));
    },
  });
  const unlinkMutation = useMutation({
    mutationFn: (walletId: string) => unlinkWallet(walletId),
    onSuccess: () => {
      setFormError(null);
      invalidateAccount();
    },
    onError: (err) => {
      setFormError(err instanceof ApiException ? err.message : t('wallet.link.fallbackError'));
    },
  });
  const destinationMutation = useMutation({
    mutationFn: (walletId: string) => updateWallet(walletId, { autoPayout: true }),
    onSuccess: () => {
      setDestinationError(null);
      invalidateAccount();
    },
    onError: (err) => {
      setDestinationError(
        err instanceof ApiException ? err.message : t('wallet.destination.fallbackError'),
      );
    },
  });
  const cashbackDestinationMutation = useMutation({
    mutationFn: (destination: CashbackDestination) => setCashbackDestination(destination),
    onSuccess: (view: UserMeView) => {
      queryClient.setQueryData(['me'], view);
      setDestinationError(null);
      invalidateAccount();
    },
    onError: (err) => {
      setDestinationError(
        err instanceof ApiException ? err.message : t('wallet.destination.fallbackError'),
      );
    },
  });
  const currencyMutation = useMutation({
    mutationFn: (code: HomeCurrency) => setHomeCurrency(code),
    onSuccess: (view: UserMeView) => {
      queryClient.setQueryData(['me'], view);
      setCurrencyError(null);
    },
    onError: (err) => {
      if (err instanceof ApiException && err.status === 409) {
        setCurrencyError(t('wallet.homeCurrency.locked'));
        return;
      }
      setCurrencyError(
        err instanceof ApiException ? err.message : t('wallet.homeCurrency.fallbackError'),
      );
    },
  });

  if (!isAuthenticated) {
    return (
      <main className={`max-w-2xl mx-auto px-6 ${mainPad}`}>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
          {t('wallet.signedOut.heading')}
        </h1>
        <p className="text-gray-700 dark:text-gray-300 mb-6">{t('wallet.signedOut.body')}</p>
        <button
          type="button"
          className="text-blue-600 underline"
          onClick={() => {
            void navigate('/auth');
          }}
        >
          {t('wallet.signedOut.cta')}
        </button>
      </main>
    );
  }

  if (meQuery.isPending || accountLoading) {
    return (
      <main className={`max-w-2xl mx-auto px-6 ${mainPad} flex justify-center`}>
        <Spinner />
      </main>
    );
  }

  if (meQuery.isError || accountError || account === undefined) {
    return (
      <main className={`max-w-2xl mx-auto px-6 ${mainPad}`}>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
          {t('wallet.heading')}
        </h1>
        <p className="text-red-600 dark:text-red-400">
          {meQuery.isError ? t('wallet.loadError') : t('wallet.accountError')}
        </p>
      </main>
    );
  }

  const user = meQuery.data;
  const trimmed = draftAddress.trim();
  const draftValid = trimmed.length > 0;
  const stableCode = displayCurrencyCode(heldStableForCurrency(user.homeCurrency));
  const busy = linkMutation.isPending || unlinkMutation.isPending;
  const savingsSelected = user.cashbackDestination === 'savings';
  const payoutSelected = !savingsSelected && (activeLink === null || activeLink.autoPayout);
  const destinationBusy = destinationMutation.isPending || cashbackDestinationMutation.isPending;

  const handleLink = (): void => {
    if (!draftValid || busy) return;
    setFormError(null);
    linkMutation.mutate(trimmed);
  };
  const handleUnlink = (): void => {
    if (busy || activeLink === null) return;
    setFormError(null);
    unlinkMutation.mutate(activeLink.id);
  };
  const handleCopy = async (): Promise<void> => {
    if (activeLink === null) return;
    const ok = await copyToClipboard(activeLink.address);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  const handleCurrencyChange = (code: HomeCurrency): void => {
    if (currencyMutation.isPending || code === user.homeCurrency) return;
    setCurrencyError(null);
    currencyMutation.mutate(code);
  };
  const handleSelectPayout = (): void => {
    if (payoutSelected || destinationBusy) return;
    setDestinationError(null);
    if (savingsSelected) {
      cashbackDestinationMutation.mutate('account');
    }
    if (activeLink !== null && !activeLink.autoPayout) {
      destinationMutation.mutate(activeLink.id);
    }
  };
  const handleSelectSavings = (): void => {
    if (savingsSelected || destinationBusy) return;
    setDestinationError(null);
    cashbackDestinationMutation.mutate('savings');
  };

  return (
    <main className={`max-w-2xl mx-auto px-6 ${mainPad} space-y-8`}>
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          {t('wallet.heading')}
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          {t('wallet.introPrefix')} <strong>{stableCode}</strong> {t('wallet.introSuffix')}
        </p>
      </header>

      <section aria-labelledby="home-currency-heading" className={CARD}>
        <h2
          id="home-currency-heading"
          className="text-base font-semibold text-gray-900 dark:text-white"
        >
          {t('wallet.homeCurrency.heading')}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('wallet.homeCurrency.introPrefix')} <strong>{user.homeCurrency}</strong>
          {t('wallet.homeCurrency.introMiddle')} <strong>{stableCode}</strong>
          {t('wallet.homeCurrency.introSuffix')}
        </p>
        <div
          role="radiogroup"
          aria-label={t('wallet.homeCurrency.radiogroupLabel')}
          className="flex flex-wrap gap-2"
        >
          {HOME_CURRENCIES.map((code, i) => {
            const active = code === user.homeCurrency;
            const selectedIndex = HOME_CURRENCIES.indexOf(user.homeCurrency);
            const tabStop = selectedIndex === -1 ? 0 : selectedIndex;
            return (
              <button
                key={code}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={i === tabStop ? 0 : -1}
                onClick={() => handleCurrencyChange(code)}
                onKeyDown={(e) => {
                  const len = HOME_CURRENCIES.length;
                  let next: number | null = null;
                  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % len;
                  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + len) % len;
                  else if (e.key === 'Home') next = 0;
                  else if (e.key === 'End') next = len - 1;
                  if (next === null) return;
                  e.preventDefault();
                  const nextCode = HOME_CURRENCIES[next]!;
                  handleCurrencyChange(nextCode);
                  const group = e.currentTarget.closest('[role="radiogroup"]');
                  group?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
                }}
                disabled={currencyMutation.isPending}
                className={`rounded-lg border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed ${
                  active
                    ? 'border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-gray-900'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
                }`}
              >
                {code} → {displayCurrencyCode(heldStableForCurrency(code))}
              </button>
            );
          })}
        </div>
        {currencyError !== null ? (
          <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
            {currencyError}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="destination-heading" className={CARD}>
        <h2
          id="destination-heading"
          className="text-base font-semibold text-gray-900 dark:text-white"
        >
          {t('wallet.destination.heading')}
        </h2>
        <div
          role="radiogroup"
          aria-label={t('wallet.destination.radiogroupLabel')}
          className="grid grid-cols-1 sm:grid-cols-2 gap-3"
        >
          <button
            type="button"
            role="radio"
            aria-checked={payoutSelected}
            onClick={handleSelectPayout}
            disabled={destinationBusy}
            className={`rounded-lg border px-4 py-3 text-start disabled:cursor-not-allowed ${
              payoutSelected
                ? 'border-gray-900 dark:border-white'
                : 'border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800'
            }`}
          >
            <span className="block text-sm font-semibold text-gray-900 dark:text-white">
              {t('wallet.destination.payout')}
            </span>
            <span className="mt-0.5 block text-xs text-gray-600 dark:text-gray-400">
              {t('wallet.destination.payoutBody')}
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={savingsSelected}
            onClick={handleSelectSavings}
            disabled={destinationBusy}
            className={`rounded-lg border px-4 py-3 text-start disabled:cursor-not-allowed ${
              savingsSelected
                ? 'border-gray-900 dark:border-white'
                : 'border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800'
            }`}
          >
            <span className="block text-sm font-semibold text-gray-900 dark:text-white">
              {t('wallet.destination.savings')}
            </span>
            <span className="mt-0.5 block text-xs text-gray-600 dark:text-gray-400">
              {t('wallet.destination.savingsBody')}
            </span>
          </button>
        </div>
        {savingsSelected ? (
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {t('wallet.destination.savingsNote')}
          </p>
        ) : null}
        {destinationError !== null ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {destinationError}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="linked-heading" className={CARD}>
        <h2 id="linked-heading" className="text-base font-semibold text-gray-900 dark:text-white">
          {t('wallet.linked.heading')}
        </h2>
        {activeLink !== null ? (
          <>
            <p
              className="break-all font-mono text-sm text-gray-900 dark:text-white"
              title={activeLink.address}
            >
              {activeLink.address}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  void handleCopy();
                }}
                aria-live="polite"
                className={SECONDARY_BUTTON}
              >
                {copied ? t('wallet.linked.copied') : t('wallet.linked.copy')}
              </button>
              <button
                type="button"
                onClick={handleUnlink}
                disabled={busy}
                className="rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:bg-gray-900 dark:text-red-400 dark:hover:bg-red-900/20"
              >
                {unlinkMutation.isPending
                  ? t('wallet.linked.unlinking')
                  : t('wallet.linked.unlink')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-600 dark:text-gray-400">{t('wallet.linked.empty')}</p>
            <label htmlFor="stellar-address" className="block">
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('wallet.link.pubkeyLabel')}
              </span>
              <input
                id="stellar-address"
                type="text"
                spellCheck={false}
                autoComplete="off"
                inputMode="text"
                value={draftAddress}
                onChange={(e) => setDraftAddress(e.target.value)}
                placeholder={t('wallet.link.pubkeyPlaceholder')}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-mono text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white dark:placeholder-gray-600"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('wallet.link.pubkeyHintPart1')} <code>G</code>
                {t('wallet.link.pubkeyHintPart2')} <strong>{stableCode}</strong>{' '}
                {t('wallet.link.pubkeyHintPart3')} <code>op_no_trust</code>
                {t('wallet.link.pubkeyHintPart4')}
              </p>
            </label>
            <button
              type="button"
              onClick={handleLink}
              disabled={!draftValid || busy}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-white dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100 dark:disabled:bg-gray-700 dark:disabled:text-gray-400"
            >
              {linkMutation.isPending ? t('wallet.link.saving') : t('wallet.link.linkCta')}
            </button>
          </>
        )}
        {formError !== null ? (
          <div role="alert" className="text-sm text-red-600 dark:text-red-400">
            {formError}
          </div>
        ) : null}
      </section>

      <PayoutsCard />
    </main>
  );
}
