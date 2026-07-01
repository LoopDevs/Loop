import { useQuery } from '@tanstack/react-query';
import {
  getUserPayoutByOrder,
  type UserPendingPayoutState,
  type UserPendingPayoutView,
} from '~/services/user';
import { shouldRetry } from '~/hooks/query-retry';
import { useAuth } from '~/hooks/use-auth';
import { useAppConfig } from '~/hooks/use-app-config';
import { formatAssetAmount } from '~/components/features/cashback/PendingPayoutsCard';

/**
 * Per-order cashback settlement card (ADR 015 / 016). Rendered on
 * `/orders/:id`, feeds from GET /api/users/me/orders/:orderId/payout.
 *
 * Self-hides when no payout row exists for the order yet — common
 * on:
 *   - Orders still in pending/procuring (no cashback due yet)
 *   - Fulfilled orders where cashback went to credit-only ledger
 *     (user has no Stellar trustline → no payout queued)
 *   - 404 on cross-user ids (defensive — route-level auth should
 *     already prevent this)
 *
 * The existing EarnedCashbackCard tells the user *how much* they
 * earned off this order. This card tells them *where it went on
 * Stellar* ("queued / submitting / confirmed / failed") with the
 * tx hash deep link when confirmed.
 *
 * Polls every 30s so state transitions (submit worker cadence)
 * land without a manual refresh.
 */
const STATE_UI: Record<UserPendingPayoutState, { label: string; classes: string }> = {
  pending: {
    label: 'Queued',
    classes: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  },
  submitted: {
    label: 'Submitting',
    classes: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  },
  confirmed: {
    label: 'Confirmed',
    classes: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  },
  failed: {
    label: 'Failed',
    classes: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function OrderPayoutCard({ orderId }: { orderId: string }): React.JSX.Element | null {
  // Audit CF-24: gate on auth (A2-1156 cold-start 401/refresh-storm guard).
  const { isAuthenticated } = useAuth();
  // WUM-05 / CF2-08 (2026-06-30 cold audit): this card tells the user
  // where their cashback went "on Stellar" — a Phase 2+ concept.
  // AGENTS.md documents LOOP_PHASE_1_ONLY as hiding every Phase 2+
  // surface; every sibling cashback/wallet surface already gates on
  // this, this one didn't.
  const { config } = useAppConfig();
  const query = useQuery({
    queryKey: ['order', orderId, 'payout'],
    queryFn: () => getUserPayoutByOrder(orderId),
    enabled: isAuthenticated && orderId.length > 0 && !config.phase1Only,
    retry: shouldRetry,
    staleTime: 30_000,
    // Poll only while the payout can still change. `confirmed`/`failed` are
    // terminal — keep polling those forever (W-02) wastes a request every 30s
    // on every open order page. Stop once we have terminal data.
    refetchInterval: (q) => {
      const state = q.state.data?.state;
      return state === 'confirmed' || state === 'failed' ? false : 30_000;
    },
  });

  if (config.phase1Only) return null;
  if (query.isPending || query.isError) return null;
  const payout: UserPendingPayoutView | null = query.data;
  if (payout === null) return null;

  const ui = STATE_UI[payout.state];
  const explorerHref =
    payout.txHash === null
      ? null
      : `https://stellar.expert/explorer/public/tx/${encodeURIComponent(payout.txHash)}`;
  const primaryTimestamp =
    payout.confirmedAt ?? payout.failedAt ?? payout.submittedAt ?? payout.createdAt;

  return (
    <section
      aria-labelledby="order-payout-heading"
      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="order-payout-heading"
            className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
          >
            Cashback settlement
          </h2>
          <p className="mt-1 text-sm font-medium text-gray-900 dark:text-white tabular-nums">
            {formatAssetAmount(payout.amountStroops, payout.assetCode)}
          </p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {formatDate(primaryTimestamp)}
            {explorerHref !== null && (
              <>
                {' · '}
                <a
                  href={explorerHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200"
                >
                  View tx
                </a>
              </>
            )}
          </p>
          {/* Failed payouts: show retry count + support reassurance.
              Admin can resubmit via /admin/payouts/:id/retry; from
              the user's side the important signal is "we tried N
              times and we're on it", not the raw last_error (which
              can leak internals — kept admin-only). */}
          {payout.state === 'failed' ? (
            <p className="mt-1 text-xs text-red-700 dark:text-red-400">
              {payout.attempts === 0
                ? 'Our system hasn\u2019t retried yet — support will pick it up shortly.'
                : `Tried ${payout.attempts} time${payout.attempts === 1 ? '' : 's'}. Support is reviewing.`}
            </p>
          ) : null}
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${ui.classes}`}
          aria-label={`Payout state: ${ui.label}`}
        >
          {ui.label}
        </span>
      </div>
    </section>
  );
}
