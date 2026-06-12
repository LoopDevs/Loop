import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiException, type WalletProvisioningState } from '@loop/shared';
import { getAdminUserWallet, reprovisionAdminUserWallet } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { useUiStore } from '~/stores/ui.store';
import { ReasonDialog } from './ReasonDialog';
import { CopyButton } from './CopyButton';
import { Spinner } from '~/components/ui/Spinner';
import { fmtStroops } from '~/utils/format-stellar';
import { ADMIN_LOCALE } from '~/utils/locale';

/**
 * User-360 wallet card (ADR 037 / ADR 030 Phase C).
 *
 * Surfaces the user's embedded-wallet provisioning state — the
 * support question is "why hasn't this customer's cashback landed?",
 * and a wallet stuck before `activated` is the most common answer.
 * Shows provider / addresses / the on-chain trustline snapshot /
 * attempt telemetry, plus the re-trigger action. `onChain: null`
 * means Horizon was unreachable (deliberately no last-known-good
 * fallback — support needs the truth), so the card renders a retry
 * hint instead of balances.
 *
 * The reprovision button is a support-allowed delivery-unsticking
 * action (ADR 037 §3 — an idempotent re-drive, no money movement),
 * so unlike the credit/emission forms it renders for both staff
 * roles. It carries the full ADR 017 contract, so the button opens a
 * ReasonDialog (2–500 chars, audited).
 */
const PROVISIONING_UI: Record<WalletProvisioningState, { label: string; classes: string }> = {
  none: {
    label: 'no wallet',
    classes: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  },
  wallet_created: {
    label: 'wallet created — not activated',
    classes: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  },
  activated: {
    label: 'activated',
    classes: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  },
};

export function UserWalletCard({ userId }: { userId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  const addToast = useUiStore((s) => s.addToast);
  const [reasonOpen, setReasonOpen] = useState(false);

  const query = useQuery({
    queryKey: ['admin-user-wallet', userId],
    queryFn: () => getAdminUserWallet(userId),
    retry: shouldRetry,
    staleTime: 15_000,
  });

  const reprovision = useMutation({
    mutationFn: (reason: string) => reprovisionAdminUserWallet({ userId, reason }),
    onSuccess: (envelope) => {
      addToast(
        envelope.audit.replayed
          ? 'Re-provision replayed — this re-drive was already enqueued.'
          : 'Wallet re-provisioning enqueued — the sweep picks it up on its next tick.',
        'success',
      );
      void queryClient.invalidateQueries({ queryKey: ['admin-user-wallet', userId] });
    },
    onError: (err) => {
      addToast(
        err instanceof ApiException ? err.message : 'Failed to enqueue wallet re-provisioning.',
        'error',
      );
    },
  });

  const handleReason = (reason: string | null): void => {
    setReasonOpen(false);
    if (reason !== null) reprovision.mutate(reason);
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <header className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4 dark:border-gray-800">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Wallet</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Embedded-wallet provisioning state + on-chain LOOP balances (ADR 030/036). On-chain is
            the authoritative cashback balance; a wallet stuck before{' '}
            <code className="font-mono">activated</code> is why payouts wait.
          </p>
        </div>
        {query.data !== undefined ? (
          <span
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${PROVISIONING_UI[query.data.provisioning].classes}`}
          >
            {PROVISIONING_UI[query.data.provisioning].label}
          </span>
        ) : null}
      </header>

      {query.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : query.isError ? (
        <p className="px-6 py-6 text-sm text-red-600 dark:text-red-400">
          Failed to load wallet state.
        </p>
      ) : (
        <div className="space-y-4 px-6 py-5">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 text-sm">
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Provider</dt>
              <dd className="text-gray-900 dark:text-white">{query.data.provider ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Wallet id</dt>
              <dd className="font-mono text-xs text-gray-700 dark:text-gray-300 break-all">
                {query.data.walletId ?? '—'}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-gray-500 dark:text-gray-400">Wallet address</dt>
              <dd className="font-mono text-xs text-gray-700 dark:text-gray-300 break-all inline-flex items-center gap-1">
                {query.data.walletAddress ?? '—'}
                {query.data.walletAddress !== null ? (
                  <CopyButton text={query.data.walletAddress} label="Copy wallet address" />
                ) : null}
              </dd>
            </div>
            {query.data.stellarAddress !== null ? (
              <div className="sm:col-span-2">
                <dt className="text-gray-500 dark:text-gray-400">Legacy payout address</dt>
                <dd className="font-mono text-xs text-gray-700 dark:text-gray-300 break-all inline-flex items-center gap-1">
                  {query.data.stellarAddress}
                  <CopyButton text={query.data.stellarAddress} label="Copy legacy payout address" />
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Provisioning attempts</dt>
              <dd className="tabular-nums text-gray-900 dark:text-white">
                {query.data.provisioningAttempts}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Last attempt</dt>
              <dd className="text-gray-900 dark:text-white">
                {query.data.provisioningLastAttemptAt !== null
                  ? new Date(query.data.provisioningLastAttemptAt).toLocaleString(ADMIN_LOCALE, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })
                  : '—'}
              </dd>
            </div>
          </dl>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              On-chain balances
            </h3>
            {query.data.onChain === null ? (
              <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
                Horizon unreachable — on-chain state unknown. Retry shortly.
              </p>
            ) : !query.data.onChain.accountExists ? (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                No on-chain account yet.
              </p>
            ) : query.data.onChain.balances.length === 0 ? (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                No LOOP-asset trustlines yet.
              </p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm">
                {query.data.onChain.balances.map((b) => (
                  <li
                    key={`${b.assetCode}:${b.assetIssuer}`}
                    className="tabular-nums text-gray-900 dark:text-white"
                  >
                    {fmtStroops(b.balanceStroops, b.assetCode)}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {query.data.provisioning !== 'activated' ? (
            <div>
              <button
                type="button"
                onClick={() => setReasonOpen(true)}
                disabled={reprovision.isPending}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                {reprovision.isPending ? 'Enqueuing…' : 'Re-trigger provisioning'}
              </button>
            </div>
          ) : null}
        </div>
      )}

      <ReasonDialog
        open={reasonOpen}
        title="Reason for re-triggering provisioning?"
        description="The reason lands in the audit trail and the Discord notification. The re-drive is idempotent — an already in-flight run is not duplicated."
        confirmLabel="Re-trigger"
        onResolve={handleReason}
      />
    </section>
  );
}
