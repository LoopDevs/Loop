/**
 * `/admin/ledger` — fleet-wide ledger browser (ADR 037 §4.2 / A5-8).
 *
 * Paginated, filterable, READ-ONLY browse of `credit_transactions`
 * across every user — the surface ADR-037 named but never shipped a
 * UI for ("Ledger browser — paginated credit_transactions UI with
 * type/date filters"). Ops uses this for drift investigation,
 * dispute triage, and reconciliation without reaching for SQL; the
 * per-user drill at `/admin/users/:userId` (`CreditTransactionsTable`)
 * answers "how did THIS user's balance get here" — this page answers
 * "where did money move, fleet-wide".
 *
 * Filters: `userId`, `type`, `referenceType`+`referenceId`, and a
 * `since`/`before` date range, all URL-driven (bookmarkable, ADR 018
 * drill-down convention) via `useSearchParams`. Keyset pagination on
 * `createdAt` (never OFFSET) — same "Newest / Older" affordance as
 * `/admin/users`.
 *
 * Support-tier: matches the backend gate (routes/admin-support-ops.ts).
 * No write action anywhere on this page.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { ApiException, type CreditTransactionType } from '@loop/shared';
import type { Route } from './+types/admin.ledger';
import { RequireStaff } from '~/components/features/admin/RequireAdmin';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { listAdminLedger, type AdminLedgerEntry } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { ADMIN_LOCALE } from '~/utils/locale';
import { Spinner } from '~/components/ui/Spinner';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Ledger — Loop' }];
}

const PAGE_SIZE = 50;

const TYPES: ReadonlyArray<'all' | CreditTransactionType> = [
  'all',
  'cashback',
  'interest',
  'spend',
  'withdrawal',
  'refund',
  'adjustment',
];

function fmtSignedMinor(minor: string, currency: string): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return '—';
  const major = n / 100;
  try {
    // `signDisplay: 'exceptZero'` matches the per-user
    // CreditTransactionsTable — direction is the signal for ops, not
    // just the type pill.
    return new Intl.NumberFormat(ADMIN_LOCALE, {
      style: 'currency',
      currency,
      signDisplay: 'exceptZero',
    }).format(major);
  } catch {
    const sign = major > 0 ? '+' : '';
    return `${sign}${major.toFixed(2)} ${currency}`;
  }
}

function typePillClass(t: CreditTransactionType): string {
  switch (t) {
    case 'cashback':
    case 'interest':
    case 'refund':
      return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
    case 'withdrawal':
    case 'spend':
      return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
    case 'adjustment':
      return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300';
  }
}

function truncId(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/** Reference link target — mirrors the referenceType tags credit_transactions writers use. */
function referenceHref(referenceType: string, referenceId: string): string | null {
  if (referenceType === 'order') return `/admin/orders/${encodeURIComponent(referenceId)}`;
  if (referenceType === 'payout') return `/admin/payouts/${encodeURIComponent(referenceId)}`;
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function AdminLedgerRoute(): React.JSX.Element {
  return (
    <RequireStaff minimum="support">
      <AdminLedgerRouteInner />
    </RequireStaff>
  );
}

function AdminLedgerRouteInner(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();

  const userIdParam = searchParams.get('userId') ?? undefined;
  const userIdFilter =
    userIdParam !== undefined && UUID_RE.test(userIdParam) ? userIdParam : undefined;
  const referenceTypeParam = searchParams.get('referenceType') ?? undefined;
  const referenceIdParam = searchParams.get('referenceId') ?? undefined;
  // Backend requires referenceType + referenceId together (money-review
  // finding on PR #1620 — either alone isn't index-selective, see
  // admin/ledger.ts). A URL with only one set is an incomplete/stale
  // deep link, not a valid filter — drop both rather than send a
  // request the backend will 400.
  const referencePairComplete = referenceTypeParam !== undefined && referenceIdParam !== undefined;
  const referencePairIncomplete =
    (referenceTypeParam !== undefined) !== (referenceIdParam !== undefined);
  const sinceParam = searchParams.get('since') ?? undefined;
  const before = searchParams.get('before') ?? undefined;

  const [typeFilter, setTypeFilter] = useState<'all' | CreditTransactionType>('all');
  const [userIdDraft, setUserIdDraft] = useState(userIdParam ?? '');
  const [referenceIdDraft, setReferenceIdDraft] = useState(referenceIdParam ?? '');
  const [referenceTypeDraft, setReferenceTypeDraft] = useState(referenceTypeParam ?? '');
  const [sinceDraft, setSinceDraft] = useState(
    sinceParam !== undefined ? sinceParam.slice(0, 10) : '',
  );
  const [filterError, setFilterError] = useState<string | null>(null);

  const resetCursor = (): void => {
    setSearchParams((params) => {
      params.delete('before');
      return params;
    });
  };

  const applyFilters = (): void => {
    const trimmedUserId = userIdDraft.trim();
    if (trimmedUserId.length > 0 && !UUID_RE.test(trimmedUserId)) {
      setFilterError('userId must be a UUID.');
      return;
    }

    const trimmedRefId = referenceIdDraft.trim();
    const trimmedRefType = referenceTypeDraft.trim();
    // Mirrors the backend's pairing requirement (money-review finding,
    // PR #1620) — reject client-side instead of round-tripping a 400.
    if (trimmedRefType.length > 0 !== trimmedRefId.length > 0) {
      setFilterError('Reference type and reference ID must be provided together.');
      return;
    }

    setFilterError(null);
    setSearchParams((params) => {
      if (trimmedUserId.length === 0) params.delete('userId');
      else params.set('userId', trimmedUserId);

      if (trimmedRefId.length === 0) params.delete('referenceId');
      else params.set('referenceId', trimmedRefId);

      if (trimmedRefType.length === 0) params.delete('referenceType');
      else params.set('referenceType', trimmedRefType);

      if (sinceDraft.length === 0) params.delete('since');
      else params.set('since', `${sinceDraft}T00:00:00.000Z`);

      params.delete('before');
      return params;
    });
  };

  const clearFilters = (): void => {
    setUserIdDraft('');
    setReferenceIdDraft('');
    setReferenceTypeDraft('');
    setSinceDraft('');
    setFilterError(null);
    setTypeFilter('all');
    setSearchParams((params) => {
      params.delete('userId');
      params.delete('referenceId');
      params.delete('referenceType');
      params.delete('since');
      params.delete('before');
      return params;
    });
  };

  const query = useQuery({
    queryKey: [
      'admin-ledger',
      userIdFilter ?? null,
      typeFilter,
      referencePairComplete ? referenceTypeParam : null,
      referencePairComplete ? referenceIdParam : null,
      sinceParam ?? null,
      before ?? null,
    ],
    queryFn: () =>
      listAdminLedger({
        limit: PAGE_SIZE,
        ...(userIdFilter !== undefined ? { userId: userIdFilter } : {}),
        ...(typeFilter !== 'all' ? { type: typeFilter } : {}),
        // Only ever sent as a pair — see referencePairComplete above.
        ...(referencePairComplete && referenceTypeParam !== undefined
          ? { referenceType: referenceTypeParam }
          : {}),
        ...(referencePairComplete && referenceIdParam !== undefined
          ? { referenceId: referenceIdParam }
          : {}),
        ...(sinceParam !== undefined ? { since: sinceParam } : {}),
        ...(before !== undefined ? { before } : {}),
      }),
    retry: shouldRetry,
    staleTime: 10_000,
  });

  const rows = query.data?.transactions ?? [];
  const hasMore = rows.length === PAGE_SIZE;

  const pageOlder = (): void => {
    const last = rows[rows.length - 1];
    if (last === undefined) return;
    setSearchParams((params) => {
      params.set('before', last.createdAt);
      return params;
    });
  };

  const malformedUserId = userIdParam !== undefined && userIdFilter === undefined;
  const anyUrlFilterActive = referencePairComplete || referencePairIncomplete || malformedUserId;

  return (
    <main className="max-w-6xl mx-auto px-6 py-12 space-y-6">
      <AdminNav />
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Admin · Ledger</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Fleet-wide, read-only browse of every credit_transactions row — for drift investigation,
          dispute triage, and reconciliation without SQL. Newest first.
        </p>
      </header>

      {/* Deep-link banner (ADR 018): a reference drill-in from an
          order/payout detail page, an incomplete reference pair, or a
          malformed userId in the URL. */}
      {anyUrlFilterActive ? (
        <div
          role="status"
          className="flex items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
        >
          <span>
            {referencePairComplete ? (
              <>
                Filtered to reference{' '}
                <code className="font-mono text-xs">
                  {referenceTypeParam}:{referenceIdParam}
                </code>
              </>
            ) : referencePairIncomplete ? (
              'This link only sets one of referenceType/referenceId — both are required together, so neither was applied.'
            ) : (
              'The userId in this link is not a valid UUID — ignored.'
            )}
          </span>
          <button
            type="button"
            onClick={clearFilters}
            className="text-xs font-medium underline hover:no-underline"
          >
            Clear
          </button>
        </div>
      ) : null}

      <form
        className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters();
        }}
      >
        <div className="flex flex-wrap gap-2">
          {TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTypeFilter(t);
                resetCursor();
              }}
              aria-pressed={typeFilter === t}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                typeFilter === t
                  ? 'border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-gray-900'
                  : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
              }`}
            >
              {t === 'all' ? 'All types' : t}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 dark:text-gray-400">
            User ID
            <input
              type="text"
              value={userIdDraft}
              onChange={(e) => setUserIdDraft(e.target.value)}
              placeholder="uuid"
              aria-label="Filter by user id"
              autoComplete="off"
              spellCheck={false}
              className="w-64 rounded-lg border border-gray-300 bg-white px-2 py-1.5 font-mono text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder-gray-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 dark:text-gray-400">
            Reference type
            <input
              type="text"
              value={referenceTypeDraft}
              onChange={(e) => setReferenceTypeDraft(e.target.value)}
              placeholder="order / payout"
              aria-label="Filter by reference type"
              autoComplete="off"
              spellCheck={false}
              className="w-40 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder-gray-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 dark:text-gray-400">
            Reference ID
            <input
              type="text"
              value={referenceIdDraft}
              onChange={(e) => setReferenceIdDraft(e.target.value)}
              placeholder="order or payout id"
              aria-label="Filter by reference id"
              autoComplete="off"
              spellCheck={false}
              className="w-64 rounded-lg border border-gray-300 bg-white px-2 py-1.5 font-mono text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder-gray-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 dark:text-gray-400">
            Since
            <input
              type="date"
              value={sinceDraft}
              onChange={(e) => setSinceDraft(e.target.value)}
              aria-label="Only show transactions on or after this date"
              className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </label>
          <button
            type="submit"
            className="rounded-lg border border-gray-900 bg-gray-900 px-4 py-2 text-xs font-medium text-white hover:bg-gray-800 dark:border-white dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Clear filters
          </button>
        </div>
        {filterError !== null ? (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {filterError}
          </p>
        ) : null}
      </form>

      {query.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : query.isError ? (
        <p className="text-sm text-red-600 dark:text-red-400 py-6">
          {query.error instanceof ApiException && query.error.status === 404
            ? 'This page is only available to Loop staff.'
            : 'Failed to load ledger rows.'}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-6">
          No ledger rows match this filter.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                {['When', 'User', 'Type', 'Amount', 'Reference'].map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-start font-medium text-gray-500 dark:text-gray-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-900 bg-white dark:bg-gray-900">
              {rows.map((tx: AdminLedgerEntry) => {
                const href =
                  tx.referenceType !== null && tx.referenceId !== null
                    ? referenceHref(tx.referenceType, tx.referenceId)
                    : null;
                return (
                  <tr key={tx.id}>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-700 dark:text-gray-300">
                      {new Date(tx.createdAt).toLocaleString(ADMIN_LOCALE, {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs" title={tx.userId}>
                      <Link
                        to={`/admin/users/${tx.userId}`}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {truncId(tx.userId)}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${typePillClass(tx.type)}`}
                      >
                        {tx.type}
                      </span>
                    </td>
                    <td className="px-3 py-2 tabular-nums font-medium text-gray-900 dark:text-white">
                      {fmtSignedMinor(tx.amountMinor, tx.currency)}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
                      {tx.referenceType !== null && tx.referenceId !== null ? (
                        href !== null ? (
                          <Link
                            to={href}
                            className="font-mono text-blue-600 hover:underline dark:text-blue-400"
                          >
                            {tx.referenceType}:{truncId(tx.referenceId)}
                          </Link>
                        ) : (
                          <span className="font-mono" title={tx.referenceId}>
                            {tx.referenceType}:{truncId(tx.referenceId)}
                          </span>
                        )
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <nav className="flex justify-between" aria-label="Ledger pagination">
        <button
          type="button"
          onClick={resetCursor}
          disabled={before === undefined}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          ← Newest
        </button>
        <button
          type="button"
          onClick={pageOlder}
          disabled={!hasMore}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Older →
        </button>
      </nav>
    </main>
  );
}
