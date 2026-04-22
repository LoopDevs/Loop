/**
 * `/settings/cashback` — paginated cashback-history detail view (ADR 009 / 015).
 *
 * The Account screen ("/auth") shows the last 5 credit-ledger events
 * via `CashbackHistoryCard`. This page gives the user the full list
 * with a Load-more cursor over `GET /api/users/me/cashback-history`.
 *
 * Pagination is cursor-based on `createdAt` — the endpoint accepts
 * `?before=<iso-8601>` so we don't need server-side offset state. The
 * loaded pages accumulate in local state; each Load-more fires another
 * `useQuery` keyed on the cursor so TanStack caches them independently.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { Route } from './+types/settings.cashback';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { Button } from '~/components/ui/Button';
import {
  getCashbackHistory,
  getUserPendingPayouts,
  type CashbackHistoryEntry,
  type CashbackHistoryResponse,
  type UserPendingPayoutState,
  type UserPendingPayoutView,
} from '~/services/user';
import { CashbackBalanceCard } from '~/components/features/cashback/CashbackBalanceCard';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Cashback history — Loop' }];
}

const PAGE_SIZE = 25;

const LEDGER_LABELS: Record<CashbackHistoryEntry['type'], string> = {
  cashback: 'Cashback',
  interest: 'Interest',
  spend: 'Spend',
  withdrawal: 'Withdrawal',
  refund: 'Refund',
  adjustment: 'Adjustment',
};

function formatAmount(minor: string, currency: string): string {
  try {
    const major = Number(BigInt(minor)) / 100;
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
      signDisplay: 'always',
    }).format(major);
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

export default function SettingsCashbackRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  // Cursor accumulator: every Load-more pushes the last-row's
  // `createdAt` into this list, and each cursor is its own query key.
  // Undefined cursor is the first page (no `?before`).
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);

  if (!isAuthenticated) {
    return (
      <main className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
          Cashback history
        </h1>
        <p className="text-gray-700 dark:text-gray-300 mb-6">
          Sign in to see your cashback activity.
        </p>
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

  return (
    <main className="max-w-2xl mx-auto px-6 py-12 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Cashback history</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Every credit-ledger event on your account — newest first.
        </p>
      </header>

      {/* Current balance card — the user's first question is "how
          much do I have?". Rendered above everything else so the
          number is the first thing on the page. Multi-currency users
          get one tile per currency; most users see a single tile. */}
      <CashbackBalanceCard />

      {/* On-chain payouts — rendered above the ledger so in-flight
          Stellar emissions are immediately visible. The section hides
          itself entirely when the user has never received a payout,
          so new users don't see an empty card full of state terms
          they haven't earned context for yet. */}
      <PendingPayoutsSection />

      <section
        aria-labelledby="history-heading"
        className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-800"
      >
        <h2
          id="history-heading"
          className="px-5 pt-4 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
        >
          Off-chain ledger
        </h2>
        {cursors.map((cursor, idx) => (
          <HistoryPage
            key={cursor ?? 'head'}
            cursor={cursor}
            isLastPage={idx === cursors.length - 1}
            onLoadMore={(nextCursor) => {
              setCursors((prev) => [...prev, nextCursor]);
            }}
          />
        ))}
      </section>
    </main>
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
 * Formats a stroops string (bigint 7-decimal integer) into a
 * human-readable asset-unit string: "1.2500000 GBPLOOP" →
 * "1.25 GBPLOOP". Strips trailing zeros, keeps up to 7 decimal
 * places, falls back to "—" on parse failure.
 */
function formatAssetAmount(stroopsStr: string, assetCode: string): string {
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

function PendingPayoutsSection(): React.JSX.Element | null {
  const query = useQuery({
    // Short staleTime + automatic refetchOnWindowFocus so the user
    // sees state transitions (`submitted` → `confirmed`) without
    // reloading the page — the submit worker's cadence is ~30s so
    // polling at that rate is appropriate.
    queryKey: ['me', 'pending-payouts'],
    queryFn: () => getUserPendingPayouts({ limit: 25 }),
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

  // Silent fail: if the endpoint is erroring, the ledger section
  // below still shows the authoritative off-chain state. No point
  // splashing a red banner at the top of the page.
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

function PendingPayoutRow({ row }: { row: UserPendingPayoutView }): React.JSX.Element {
  const ui = PAYOUT_STATE_UI[row.state];
  // stellar.expert has the friendliest on-chain-explorer UX (shows
  // memo, asset, matches Loop's issuer view). Only rendered for
  // confirmed payouts — pre-confirm rows don't have a hash yet and
  // `submitted` rows aren't discoverable until the network includes
  // them.
  const explorerHref =
    row.txHash === null
      ? null
      : `https://stellar.expert/explorer/public/tx/${encodeURIComponent(row.txHash)}`;
  // Render the most informative timestamp the row has reached, not
  // just `createdAt` — once a payout confirms the user cares about
  // WHEN it confirmed, not when it was queued.
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

function HistoryPage({
  cursor,
  isLastPage,
  onLoadMore,
}: {
  cursor: string | undefined;
  isLastPage: boolean;
  onLoadMore: (nextCursor: string) => void;
}): React.JSX.Element {
  const query = useQuery<CashbackHistoryResponse>({
    queryKey: ['me', 'cashback-history', cursor ?? null, PAGE_SIZE],
    queryFn: () =>
      getCashbackHistory({
        limit: PAGE_SIZE,
        ...(cursor !== undefined ? { before: cursor } : {}),
      }),
    retry: shouldRetry,
    staleTime: 60_000,
  });

  if (query.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="px-5 py-6 text-sm text-red-600 dark:text-red-400">
        Couldn&rsquo;t load this page of your history. Please try again in a moment.
      </div>
    );
  }

  const entries = query.data.entries;

  if (entries.length === 0 && cursor === undefined) {
    return (
      <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
        No cashback activity yet. Your first Loop order will show up here.
      </div>
    );
  }

  // Server caps at PAGE_SIZE, so "hasMore" is reasonably detected by a
  // full page. A future API revision could return `nextCursor`
  // explicitly; for now this is the cleanest heuristic.
  const hasMore = entries.length === PAGE_SIZE;
  const lastCreatedAt = entries[entries.length - 1]?.createdAt;

  return (
    <>
      <ul role="list">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="flex items-center justify-between gap-4 px-5 py-4 border-b border-gray-200 dark:border-gray-800 last:border-0"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-gray-900 dark:text-white">
                {LEDGER_LABELS[entry.type]}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {formatDate(entry.createdAt)}
                {entry.referenceType !== null ? (
                  <>
                    {' · '}
                    <span className="capitalize">{entry.referenceType}</span>
                    {entry.referenceId !== null ? ` ${entry.referenceId.slice(0, 8)}` : ''}
                  </>
                ) : null}
              </p>
            </div>
            <p
              className={`shrink-0 text-sm font-semibold ${
                entry.amountMinor.startsWith('-')
                  ? 'text-gray-500 dark:text-gray-400'
                  : 'text-green-600 dark:text-green-500'
              }`}
            >
              {formatAmount(entry.amountMinor, entry.currency)}
            </p>
          </li>
        ))}
      </ul>
      {isLastPage && hasMore && lastCreatedAt !== undefined ? (
        <div className="px-5 py-4 flex justify-center">
          <Button
            variant="secondary"
            onClick={() => {
              onLoadMore(lastCreatedAt);
            }}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}
