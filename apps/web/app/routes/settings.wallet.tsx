import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/settings.wallet';
import { useAuth } from '~/hooks/use-auth';
import { useAppConfig } from '~/hooks/use-app-config';
import { getMe, setStellarAddress, type UserMeView } from '~/services/user';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { copyToClipboard } from '~/native/clipboard';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Wallet — Loop' }];
}

const STELLAR_PUBKEY_REGEX = /^G[A-Z2-7]{55}$/;

/**
 * Picks the LOOP-asset code the user will receive on-chain, based
 * on their home currency. Mirrors `payoutAssetFor` on the backend.
 */
function loopAssetForCurrency(code: string): string {
  if (code === 'USD') return 'USDLOOP';
  if (code === 'GBP') return 'GBPLOOP';
  if (code === 'EUR') return 'EURLOOP';
  return `${code}LOOP`;
}

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
  // Issuer addresses for the trustline prompt come from /api/config,
  // cached 10 min alongside every other flag. Null per-asset when the
  // operator hasn't configured that issuer yet — the UI hides the
  // trustline prompt for null entries rather than showing guidance
  // the user can't act on.
  const { config } = useAppConfig();

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

      {linked && (
        <TrustlineCard
          assetCode={assetCode}
          issuer={config.loopAssetIssuers[assetCode as 'USDLOOP' | 'GBPLOOP' | 'EURLOOP'] ?? null}
        />
      )}

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

/**
 * Trustline guidance card (ADR 015). A Stellar wallet that hasn't
 * added a trustline to the LOOP-asset issuer can't receive the
 * payout — the Stellar transaction fails with `op_no_trust`. Loop
 * can't add the trustline for the user (they control the wallet
 * keypair), so we surface the asset code + issuer here and let them
 * paste the values into Freighter, Lobstr, or a signing tool.
 *
 * Hidden when:
 *   - The backend hasn't configured an issuer for the user's home
 *     currency (`null` in `config.loopAssetIssuers`). Guidance a user
 *     can't act on is worse than silence.
 *   - The user hasn't linked a wallet. Handled by the parent gate.
 */
function TrustlineCard({
  assetCode,
  issuer,
}: {
  assetCode: string;
  issuer: string | null;
}): React.JSX.Element | null {
  const [copied, setCopied] = useState<'code' | 'issuer' | null>(null);
  if (issuer === null) return null;

  const copy = (text: string, which: 'code' | 'issuer'): void => {
    void (async () => {
      const ok = await copyToClipboard(text);
      if (ok) {
        setCopied(which);
        setTimeout(() => setCopied(null), 2000);
      }
    })();
  };

  return (
    <section
      aria-labelledby="trustline-heading"
      className="rounded-xl border border-amber-200 bg-amber-50 p-5 space-y-3 dark:border-amber-900/50 dark:bg-amber-900/10"
    >
      <div className="flex items-center gap-2">
        <svg
          className="h-5 w-5 text-amber-700 dark:text-amber-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.5M12 16h.01M4.93 19h14.14a2 2 0 001.74-3l-7.07-12a2 2 0 00-3.48 0L3.2 16a2 2 0 001.73 3z"
          />
        </svg>
        <h2
          id="trustline-heading"
          className="text-base font-semibold text-amber-900 dark:text-amber-200"
        >
          Add a trustline before your next payout
        </h2>
      </div>
      <p className="text-sm text-amber-800 dark:text-amber-300">
        Stellar wallets need a trustline to hold each LOOP asset. Without one, Loop&rsquo;s payout
        transaction fails with <code>op_no_trust</code>. Open your wallet (Freighter, Lobstr, or any
        Stellar-compatible wallet) and add a trustline using the asset code and issuer below.
      </p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="font-medium text-amber-900 dark:text-amber-200">Asset code</dt>
        <dd className="flex items-center justify-between gap-2">
          <code className="font-mono font-semibold text-amber-900 dark:text-amber-200">
            {assetCode}
          </code>
          <button
            type="button"
            onClick={() => copy(assetCode, 'code')}
            aria-label="Copy asset code"
            className="rounded-md border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-gray-900 dark:text-amber-300 dark:hover:bg-amber-900/30"
          >
            {copied === 'code' ? 'Copied' : 'Copy'}
          </button>
        </dd>
        <dt className="font-medium text-amber-900 dark:text-amber-200">Issuer</dt>
        <dd className="min-w-0 flex items-center justify-between gap-2">
          <code
            className="truncate font-mono text-xs text-amber-900 dark:text-amber-200"
            title={issuer}
          >
            {issuer}
          </code>
          <button
            type="button"
            onClick={() => copy(issuer, 'issuer')}
            aria-label="Copy issuer address"
            className="shrink-0 rounded-md border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-gray-900 dark:text-amber-300 dark:hover:bg-amber-900/30"
          >
            {copied === 'issuer' ? 'Copied' : 'Copy'}
          </button>
        </dd>
      </dl>
    </section>
  );
}
