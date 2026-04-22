import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ApiException, STELLAR_PUBKEY_REGEX, loopAssetForCurrency } from '@loop/shared';
import type { Route } from './+types/settings.wallet';
import { useAuth } from '~/hooks/use-auth';
import { getMe, setStellarAddress, type UserMeView } from '~/services/user';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { PendingPayoutsCard } from '~/components/features/cashback/PendingPayoutsCard';

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
            <button
              type="button"
              onClick={handleUnlink}
              disabled={linkMutation.isPending}
              className="rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:bg-gray-900 dark:text-red-400 dark:hover:bg-red-900/20"
            >
              {linkMutation.isPending ? 'Saving…' : 'Unlink wallet'}
            </button>
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
