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
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Route } from './+types/settings.cashback';
import i18n from '~/i18n/i18next';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { Button } from '~/components/ui/Button';
import { Phase2Gate } from '~/components/Phase2Gate';
import {
  getCashbackHistory,
  type CashbackHistoryEntry,
  type CashbackHistoryResponse,
} from '~/services/user';
import { CashbackBalanceCard } from '~/components/features/cashback/CashbackBalanceCard';
import { FlywheelChip } from '~/components/features/cashback/FlywheelChip';
import { CashbackByMerchantCard } from '~/components/features/cashback/CashbackByMerchantCard';
import { LinkWalletNudge } from '~/components/features/cashback/LinkWalletNudge';
import { MonthlyCashbackChart } from '~/components/features/cashback/MonthlyCashbackChart';
import { RailMixCard } from '~/components/features/cashback/RailMixCard';
import { PendingPayoutsCard } from '~/components/features/cashback/PendingPayoutsCard';

export function meta(): Route.MetaDescriptors {
  return [{ title: i18n.t('settings:cashback.meta.title') }];
}

const PAGE_SIZE = 25;

/**
 * Plain helper (not a component) — `t` threaded in from the caller's
 * `useTranslation('settings')`, same pattern as `routes/auth.tsx`'s
 * `ledgerLabel(t, type)` (docs/i18n.md #3).
 */
function ledgerLabel(t: TFunction, type: CashbackHistoryEntry['type']): string {
  const labels: Record<CashbackHistoryEntry['type'], string> = {
    cashback: t('cashback.labels.cashback'),
    interest: t('cashback.labels.interest'),
    spend: t('cashback.labels.spend'),
    withdrawal: t('cashback.labels.withdrawal'),
    refund: t('cashback.labels.refund'),
    adjustment: t('cashback.labels.adjustment'),
  };
  return labels[type];
}

function formatAmount(minor: string, currency: string): string {
  try {
    // Bigint split per the `@loop/shared` money-format convention
    // (`formatMinorCurrency`): divide/modulo in bigint space and
    // Number-cast only the whole + fraction components, so a minor
    // amount beyond 2^53 can't silently round before the division.
    // (We format locally rather than calling the shared helper
    // because this is a user-facing surface — browser locale +
    // signDisplay, vs the helper's pinned en-US admin locale.)
    const big = BigInt(minor);
    const neg = big < 0n;
    const abs = neg ? -big : big;
    const major = (neg ? -1 : 1) * (Number(abs / 100n) + Number(abs % 100n) / 100);
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
  return (
    <Phase2Gate>
      <SettingsCashbackBody />
    </Phase2Gate>
  );
}

function SettingsCashbackBody(): React.JSX.Element {
  const { t } = useTranslation('settings');
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
          {t('cashback.signedOut.heading')}
        </h1>
        <p className="text-gray-700 dark:text-gray-300 mb-6">{t('cashback.signedOut.body')}</p>
        <button
          type="button"
          className="text-blue-600 underline"
          onClick={() => {
            void navigate('/auth');
          }}
        >
          {t('cashback.signedOut.cta')}
        </button>
      </main>
    );
  }

  return (
    <main className="max-w-2xl mx-auto px-6 py-12 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          {t('cashback.heading')}
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{t('cashback.subtitle')}</p>
      </header>

      {/* Current balance card — the user's first question is "how
          much do I have?". Rendered above everything else so the
          number is the first thing on the page. Multi-currency users
          get one tile per currency; most users see a single tile. */}
      <CashbackBalanceCard />

      {/* Flywheel chip — "£X recycled across N orders". Mirrors the
          placement on /orders. Self-hides for users with zero
          recycled orders so brand-new accounts see the balance +
          history flow without a premature milestone pill. */}
      <FlywheelChip />

      {/* Rail mix (#643) — breakdown of how the user has paid,
          per rail. Answers the follow-up question to the chip
          above: if you've recycled 0%, here's where your spend
          went instead. Self-hides on zero-orders / error so new
          accounts don't see an empty table; motivational framing
          lives in FlywheelChip. */}
      <RailMixCard />

      {/* Nudge users with positive balance + no linked wallet to
          connect one. Hides itself when either condition isn't met
          so returning users with a linked wallet don't see the
          prompt, and new users with no cashback yet aren't asked
          to hand over wallet info before earning anything. */}
      <LinkWalletNudge />

      {/* On-chain payouts — rendered above the ledger so in-flight
          Stellar emissions are immediately visible. The card hides
          itself entirely when the user has never received a payout,
          so new users don't see an empty card full of state terms
          they haven't earned context for yet. Shared with the wallet
          settings page so the same live status lands in both spots. */}
      <PendingPayoutsCard />

      {/* Last-12-months bar chart (ADR 009 / #576). Renders one
          bar per (month, currency) pair; multi-currency users see
          one chart per currency stacked. Self-hiding on empty /
          error so the card doesn't clutter the page before the user
          has earned anything. */}
      <MonthlyCashbackChart />

      {/* Top merchants the user has earned cashback from — same
          180-day window the backend defaults to. Self-hiding for
          users with no cashback (the ledger section tells the
          empty-state story) and on fetch error. */}
      <CashbackByMerchantCard />

      <section
        aria-labelledby="history-heading"
        className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-800"
      >
        <h2
          id="history-heading"
          className="px-5 pt-4 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
        >
          {t('cashback.ledgerHeading')}
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

function HistoryPage({
  cursor,
  isLastPage,
  onLoadMore,
}: {
  cursor: string | undefined;
  isLastPage: boolean;
  onLoadMore: (nextCursor: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation('settings');
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
        {t('cashback.pageError')}
      </div>
    );
  }

  const entries = query.data.entries;

  if (entries.length === 0 && cursor === undefined) {
    return (
      <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
        {t('cashback.empty')}
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
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- ADR 042: Tailwind Preflight sets `list-style: none` on <ul>, which strips the implicit list/listitem role in Safari VoiceOver (a known WebKit quirk — Chrome/Firefox are unaffected). role="list" restores it. The rule can't see the CSS interaction, so this is a documented false positive, not a mistake. Tracked: docs/readiness-backlog-2026-07-03.md B-2. */}
      <ul role="list">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="flex items-center justify-between gap-4 px-5 py-4 border-b border-gray-200 dark:border-gray-800 last:border-0"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-gray-900 dark:text-white">
                {ledgerLabel(t, entry.type)}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {formatDate(entry.createdAt)}
                {entry.referenceType !== null ? (
                  <>
                    {' · '}
                    {entry.referenceType === 'order' && entry.referenceId !== null ? (
                      <Link
                        to={`/orders/${entry.referenceId}`}
                        className="capitalize text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {t('cashback.orderReference', {
                          shortId: entry.referenceId.slice(0, 8),
                        })}
                      </Link>
                    ) : (
                      <>
                        <span className="capitalize">{entry.referenceType}</span>
                        {entry.referenceId !== null ? ` ${entry.referenceId.slice(0, 8)}` : ''}
                      </>
                    )}
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
            {t('cashback.loadMore')}
          </Button>
        </div>
      ) : null}
    </>
  );
}
