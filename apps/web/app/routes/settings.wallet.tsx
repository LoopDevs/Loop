import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  ApiException,
  HOME_CURRENCIES,
  STELLAR_PUBKEY_REGEX,
  loopAssetForCurrency,
  type HomeCurrency,
} from '@loop/shared';
import type { Route } from './+types/settings.wallet';
import i18n from '~/i18n/i18next';
import { useAuth } from '~/hooks/use-auth';
import { getMe, setHomeCurrency, setStellarAddress, type UserMeView } from '~/services/user';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { PendingPayoutsCard } from '~/components/features/cashback/PendingPayoutsCard';
import { TrustlineSetupCard } from '~/components/features/wallet/TrustlineSetupCard';
import { StellarTrustlineStatus } from '~/components/features/wallet/StellarTrustlineStatus';
import { copyToClipboard } from '~/native/clipboard';
import { Phase2Gate } from '~/components/Phase2Gate';

export function meta(): Route.MetaDescriptors {
  return [{ title: i18n.t('settings:wallet.meta.title') }];
}

// `STELLAR_PUBKEY_REGEX` (ADR 015/016) + `loopAssetForCurrency`
// (ADR 015) both come from `@loop/shared` — one source of truth
// for the home-currency ↔ LOOP-asset mapping and the Stellar
// address format, shared between backend zod schemas and this
// UI form. See packages/shared/src/stellar.ts + loop-asset.ts.

/**
 * `/settings/wallet` — opt in / out of on-chain cashback payouts
 * (ADR 015). Paste a Stellar pubkey to receive the LOOP-branded
 * asset matching your home currency, or unlink to go back to
 * off-chain-only ledger accrual.
 *
 * Nothing is lost when unlinking — the credit ledger continues
 * to track cashback server-side; only the Stellar-side emission
 * is gated on a linked address.
 */
export default function SettingsWalletRoute(): React.JSX.Element {
  return (
    <Phase2Gate>
      <SettingsWalletBody />
    </Phase2Gate>
  );
}

function SettingsWalletBody(): React.JSX.Element {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: getMe,
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 60_000,
  });

  const [draftAddress, setDraftAddress] = useState<string>('');
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [currencyError, setCurrencyError] = useState<string | null>(null);
  const linkMutation = useMutation({
    mutationFn: (addr: string | null) => setStellarAddress(addr),
    onSuccess: (view: UserMeView) => {
      queryClient.setQueryData(['me'], view);
      setDraftAddress('');
      setFormError(null);
    },
    onError: (err) => {
      setFormError(err instanceof ApiException ? err.message : t('wallet.link.fallbackError'));
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
      <main className="max-w-2xl mx-auto px-6 py-12">
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

  if (meQuery.isPending) {
    return (
      <main className="max-w-2xl mx-auto px-6 py-12 flex justify-center">
        <Spinner />
      </main>
    );
  }

  if (meQuery.isError) {
    return (
      <main className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
          {t('wallet.heading')}
        </h1>
        <p className="text-red-600 dark:text-red-400">{t('wallet.loadError')}</p>
      </main>
    );
  }

  const user = meQuery.data;
  const linked = user.stellarAddress !== null;
  const trimmed = draftAddress.trim();
  const draftValid = STELLAR_PUBKEY_REGEX.test(trimmed);
  const assetCode = loopAssetForCurrency(user.homeCurrency);

  const handleLink = (): void => {
    if (!draftValid || linkMutation.isPending) return;
    setFormError(null);
    linkMutation.mutate(trimmed);
  };
  const handleUnlink = (): void => {
    if (linkMutation.isPending) return;
    setFormError(null);
    linkMutation.mutate(null);
  };
  const handleCopy = async (): Promise<void> => {
    if (user.stellarAddress === null) return;
    const ok = await copyToClipboard(user.stellarAddress);
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

  return (
    <main className="max-w-2xl mx-auto px-6 py-12 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          {t('wallet.heading')}
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          {t('wallet.introPrefix')} <strong>{assetCode}</strong> {t('wallet.introSuffix')}
        </p>
      </header>

      {/* Home-currency picker. The backend locks the column once the
          user has placed an order (409 HOME_CURRENCY_LOCKED), so the
          first-order-onwards flow is a one-way gate — the button click
          optimistically fires the PUT, the 409 branch falls through to
          an inline "contact support" callout. Keeping this a card
          (not buried in a /settings index) so users who land here to
          link a wallet see the asset-code consequence immediately. */}
      <section
        aria-labelledby="home-currency-heading"
        className="rounded-xl border border-gray-200 dark:border-gray-800 p-5 bg-white dark:bg-gray-900 space-y-4"
      >
        <h2
          id="home-currency-heading"
          className="text-base font-semibold text-gray-900 dark:text-white"
        >
          {t('wallet.homeCurrency.heading')}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('wallet.homeCurrency.introPrefix')} <strong>{user.homeCurrency}</strong>
          {t('wallet.homeCurrency.introMiddle')} <strong>{assetCode}</strong>
          {t('wallet.homeCurrency.introSuffix')}
        </p>
        <div
          role="radiogroup"
          aria-label={t('wallet.homeCurrency.radiogroupLabel')}
          className="flex flex-wrap gap-2"
        >
          {HOME_CURRENCIES.map((code, i) => {
            const active = code === user.homeCurrency;
            // A11Y-021 / CF-35: WAI-ARIA radiogroup keyboard contract — one
            // roving tab stop (the selected currency, or the first), with
            // Arrow/Home/End moving selection. The active radio stays
            // focusable (only `isPending` disables it) so it can be the tab
            // stop; `handleCurrencyChange` already no-ops on re-select.
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
                {code} → {loopAssetForCurrency(code)}
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

      <section
        aria-labelledby="linked-heading"
        className="rounded-xl border border-gray-200 dark:border-gray-800 p-5 bg-white dark:bg-gray-900 space-y-4"
      >
        <h2 id="linked-heading" className="text-base font-semibold text-gray-900 dark:text-white">
          {t('wallet.linked.heading')}
        </h2>
        {linked ? (
          <>
            <p
              className="break-all font-mono text-sm text-gray-900 dark:text-white"
              title={user.stellarAddress ?? ''}
            >
              {user.stellarAddress}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  void handleCopy();
                }}
                aria-live="polite"
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                {copied ? t('wallet.linked.copied') : t('wallet.linked.copy')}
              </button>
              <button
                type="button"
                onClick={handleUnlink}
                disabled={linkMutation.isPending}
                className="rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:bg-gray-900 dark:text-red-400 dark:hover:bg-red-900/20"
              >
                {linkMutation.isPending ? t('wallet.linked.unlinking') : t('wallet.linked.unlink')}
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-600 dark:text-gray-400">{t('wallet.linked.empty')}</p>
        )}
      </section>

      {/* In-flight on-chain payouts. Hides itself when the user has
          no payout history yet, so the first-link flow stays clean;
          appears automatically after the next fulfilled order so the
          user can watch a payout transition pending → submitted →
          confirmed without reloading. */}
      {linked ? <PendingPayoutsCard /> : null}

      {/* Per-LOOP-asset trustline status (#725). Complements the
          setup card below with "did my wallet actually open the
          trustline?" — self-hides when no address is linked since
          the form above is the primary surface then. */}
      {linked ? <StellarTrustlineStatus /> : null}

      {/* Trustline setup helper — self-hides on error / empty-list /
          unconfigured deployments. Shown to every visitor (linked or
          not) because opening a trustline is a wallet-side action
          that happens before the user sees their first payout, so
          the card should be visible up-front on first arrival. */}
      <TrustlineSetupCard />

      <section
        aria-labelledby="link-heading"
        className="rounded-xl border border-gray-200 dark:border-gray-800 p-5 bg-white dark:bg-gray-900 space-y-4"
      >
        <h2 id="link-heading" className="text-base font-semibold text-gray-900 dark:text-white">
          {linked ? t('wallet.link.headingRelink') : t('wallet.link.headingLink')}
        </h2>
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
            {t('wallet.link.pubkeyHintPart2')} <strong>{assetCode}</strong>{' '}
            {t('wallet.link.pubkeyHintPart3')} <code>op_no_trust</code>
            {t('wallet.link.pubkeyHintPart4')}
          </p>
        </label>
        {formError !== null ? (
          <div role="alert" className="text-sm text-red-600 dark:text-red-400">
            {formError}
          </div>
        ) : null}
        {trimmed.length > 0 && !draftValid ? (
          <div className="text-sm text-amber-700 dark:text-amber-400">
            {t('wallet.link.invalidAddress')}
          </div>
        ) : null}
        <button
          type="button"
          onClick={handleLink}
          disabled={!draftValid || linkMutation.isPending}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-white dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100 dark:disabled:bg-gray-700 dark:disabled:text-gray-400"
        >
          {linkMutation.isPending
            ? t('wallet.link.saving')
            : linked
              ? t('wallet.link.update')
              : t('wallet.link.linkCta')}
        </button>
      </section>
    </main>
  );
}
