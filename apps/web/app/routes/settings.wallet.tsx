import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  ApiException,
  HOME_CURRENCIES,
  STELLAR_PUBKEY_REGEX,
  loopAssetForCurrency,
  type HomeCurrency,
} from '@loop/shared';
import type { Route } from './+types/settings.wallet';
import { useAuth } from '~/hooks/use-auth';
import { getMe, setHomeCurrency, setStellarAddress, type UserMeView } from '~/services/user';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { PendingPayoutsCard } from '~/components/features/cashback/PendingPayoutsCard';
import { TrustlineSetupCard } from '~/components/features/wallet/TrustlineSetupCard';
import { copyToClipboard } from '~/native/clipboard';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Wallet — Loop' }];
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
      setFormError(
        err instanceof ApiException ? err.message : "Couldn't save — check the address and retry.",
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
        setCurrencyError(
          "You've already placed an order, so your home currency is locked. Contact support to change it.",
        );
        return;
      }
      setCurrencyError(err instanceof ApiException ? err.message : "Couldn't change currency.");
    },
  });

  if (!isAuthenticated) {
    return (
      <main className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">Wallet</h1>
        <p className="text-gray-700 dark:text-gray-300 mb-6">Sign in to link a Stellar wallet.</p>
        <button
          type="button"
          className="text-blue-600 underline"
          onClick={() => {
            void navigate('/auth');
          }}
        >
          Go to sign-in
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
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">Wallet</h1>
        <p className="text-red-600 dark:text-red-400">Couldn&rsquo;t load your profile.</p>
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
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Wallet</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Link a Stellar wallet to receive your cashback as <strong>{assetCode}</strong> on-chain.
          Unlinked, your cashback still accrues server-side — you just can&rsquo;t spend it outside
          of Loop until you link one.
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
          Home currency
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Determines which LOOP asset your cashback lands in on-chain. Your current currency is{' '}
          <strong>{user.homeCurrency}</strong>, so payouts arrive as <strong>{assetCode}</strong>.
        </p>
        <div role="radiogroup" aria-label="Home currency" className="flex flex-wrap gap-2">
          {HOME_CURRENCIES.map((code) => {
            const active = code === user.homeCurrency;
            return (
              <button
                key={code}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => handleCurrencyChange(code)}
                disabled={currencyMutation.isPending || active}
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
          Linked address
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
                {copied ? 'Copied' : 'Copy address'}
              </button>
              <button
                type="button"
                onClick={handleUnlink}
                disabled={linkMutation.isPending}
                className="rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:bg-gray-900 dark:text-red-400 dark:hover:bg-red-900/20"
              >
                {linkMutation.isPending ? 'Saving…' : 'Unlink wallet'}
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            No wallet linked. Add one below to start receiving on-chain cashback.
          </p>
        )}
      </section>

      {/* In-flight on-chain payouts. Hides itself when the user has
          no payout history yet, so the first-link flow stays clean;
          appears automatically after the next fulfilled order so the
          user can watch a payout transition pending → submitted →
          confirmed without reloading. */}
      {linked ? <PendingPayoutsCard /> : null}

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
          {linked ? 'Relink to a different wallet' : 'Link a wallet'}
        </h2>
        <label htmlFor="stellar-address" className="block">
          <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Stellar public key
          </span>
          <input
            id="stellar-address"
            type="text"
            spellCheck={false}
            autoComplete="off"
            inputMode="text"
            value={draftAddress}
            onChange={(e) => setDraftAddress(e.target.value)}
            placeholder="GABC…"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-mono text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white dark:placeholder-gray-600"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            56 characters, starts with <code>G</code>. Make sure the wallet has a trustline to{' '}
            <strong>{assetCode}</strong> before linking — without it, payouts fail with{' '}
            <code>op_no_trust</code>.
          </p>
        </label>
        {formError !== null ? (
          <div role="alert" className="text-sm text-red-600 dark:text-red-400">
            {formError}
          </div>
        ) : null}
        {trimmed.length > 0 && !draftValid ? (
          <div className="text-sm text-amber-700 dark:text-amber-400">
            That doesn&rsquo;t look like a Stellar public key.
          </div>
        ) : null}
        <button
          type="button"
          onClick={handleLink}
          disabled={!draftValid || linkMutation.isPending}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-white dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100 dark:disabled:bg-gray-700 dark:disabled:text-gray-400"
        >
          {linkMutation.isPending ? 'Saving…' : linked ? 'Update wallet' : 'Link wallet'}
        </button>
      </section>
    </main>
  );
}
