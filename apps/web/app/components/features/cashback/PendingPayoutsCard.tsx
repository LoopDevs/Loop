import { useQuery } from '@tanstack/react-query';
import {
  getUserPendingPayouts,
  type UserPendingPayoutState,
  type UserPendingPayoutView,
} from '~/services/user';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

/**
 * On-chain payouts card. Rendered on `/settings/cashback` above the
 * off-chain ledger and on `/settings/wallet` below the linked-address
 * form — both places where the user wants to see whether their
 * in-flight USDLOOP / GBPLOOP / EURLOOP emissions are progressing
 * (pending → submitted → confirmed) without reloading the page.
 *
 * Self-hiding on: pending-fetch (no flash), error (the authoritative
 * off-chain ledger on the same page covers for the missing surface),
 * and empty (new users don't need a card full of state terms they
 * haven't earned context for yet).
 *
 * Polls every 30s — the submit worker cadence — so state transitions
 * land without a refresh. `refetchOnWindowFocus` is implicit via
 * TanStack Query defaults.
 */
export function PendingPayoutsCard(): React.JSX.Element | null {
  // A2-1156: auth-gate so cold-start doesn't fire before session restore.
  const { isAuthenticated } = useAuth();
  const query = useQuery({
    queryKey: ['me', 'pending-payouts'],
    queryFn: () => getUserPendingPayouts({ limit: 25 }),
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  if (query.isPending) {
    return (
      <section className="flex justify-center py-4">
        <Spinner />
      </section>
    );
  }

  if (query.isError) return null;

  const payouts = query.data.payouts;
  if (payouts.length === 0) return null;

  return (
    <section
      aria-labelledby="payouts-heading"
      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
    >
      <h2
        id="payouts-heading"
        className="px-5 pt-4 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
      >
        On-chain payouts
      </h2>
      <ul role="list" className="divide-y divide-gray-200 dark:divide-gray-800">
        {payouts.map((row) => (
          <PendingPayoutRow key={row.id} row={row} />
        ))}
      </ul>
    </section>
  );
}

const PAYOUT_STATE_UI: Record<UserPendingPayoutState, { label: string; classes: string }> = {
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

/**
 * Stroops string (bigint 7-decimal integer) → human-readable asset
 * amount: `"12500000"` + `"GBPLOOP"` → `"1.25 GBPLOOP"`. Strips
 * trailing zeros, falls back to `"—"` on BigInt parse failure.
 */
export function formatAssetAmount(stroopsStr: string, assetCode: string): string {
  try {
    const stroops = BigInt(stroopsStr);
    const whole = stroops / 10_000_000n;
    const fractionRaw = (stroops % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
    const fraction = fractionRaw.length > 0 ? `.${fractionRaw}` : '';
    return `${whole.toString()}${fraction} ${assetCode}`;
  } catch {
    return '—';
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function PendingPayoutRow({ row }: { row: UserPendingPayoutView }): React.JSX.Element {
  const ui = PAYOUT_STATE_UI[row.state];
  const explorerHref =
    row.txHash === null
      ? null
      : `https://stellar.expert/explorer/public/tx/${encodeURIComponent(row.txHash)}`;
  const primaryTimestamp = row.confirmedAt ?? row.failedAt ?? row.submittedAt ?? row.createdAt;
  return (
    <li className="flex items-center justify-between gap-3 px-5 py-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-gray-900 dark:text-white">
          {formatAssetAmount(row.amountStroops, row.assetCode)}
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
      </div>
      <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${ui.classes}`}>
        {ui.label}
      </span>
    </li>
  );
}
