import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  listAdminUserCreditTransactions,
  type AdminCreditTransactionView,
  type CreditTransactionType,
} from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

const PAGE_SIZE = 20;

const TYPES: ReadonlyArray<'all' | CreditTransactionType> = [
  'all',
  'cashback',
  'adjustment',
  'refund',
  'spend',
  'withdrawal',
  'interest',
];

function fmtSignedMinor(minor: string, currency: string): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return '—';
  const major = n / 100;
  try {
    // `signDisplay: 'exceptZero'` surfaces +/- in the output so a debit
    // reads as "-£1.00" and a cashback reads as "+£0.20" — the direction
    // is the signal for ops, not just the type pill.
    return new Intl.NumberFormat('en-US', {
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

interface Props {
  userId: string;
}

/**
 * Per-user credit-transactions ledger drill (ADR 009). Backend is
 * newest-first + cursor pagination on `createdAt`; this component
 * owns the cursor in local state so the URL isn't polluted with
 * ledger-internal paging while the user's still on the detail page.
 *
 * Filter chips narrow the query server-side by `?type=` so pagination
 * stays consistent when a filter is active.
 */
export function CreditTransactionsTable({ userId }: Props): React.JSX.Element {
  const [typeFilter, setTypeFilter] = useState<'all' | CreditTransactionType>('all');
  const [beforeCursor, setBeforeCursor] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['admin-user-credit-transactions', userId, typeFilter, beforeCursor],
    queryFn: () =>
      listAdminUserCreditTransactions({
        userId,
        ...(typeFilter !== 'all' ? { type: typeFilter } : {}),
        ...(beforeCursor !== null ? { before: beforeCursor } : {}),
        limit: PAGE_SIZE,
      }),
    retry: shouldRetry,
    staleTime: 10_000,
  });

  const rows = query.data?.transactions ?? [];
  const hasMore = rows.length === PAGE_SIZE;

  const pageOlder = (): void => {
    const last = rows[rows.length - 1];
    if (last === undefined) return;
    setBeforeCursor(last.createdAt);
  };

  const pageToTop = (): void => setBeforeCursor(null);

  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-2" aria-label="Transaction type filter">
        {TYPES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTypeFilter(t);
              setBeforeCursor(null);
            }}
            className={`rounded-full px-3 py-1 text-xs font-medium border ${
              typeFilter === t
                ? 'border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-gray-900'
                : 'border-gray-200 text-gray-700 bg-white dark:border-gray-700 dark:text-gray-300 dark:bg-gray-900'
            }`}
          >
            {t === 'all' ? 'All' : t}
          </button>
        ))}
      </nav>

      {query.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : query.isError ? (
        <p className="py-6 text-sm text-red-600 dark:text-red-400">
          Failed to load credit transactions.
        </p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-sm text-gray-500 dark:text-gray-400">
          {typeFilter === 'all'
            ? 'No credit transactions for this user yet.'
            : `No ${typeFilter} transactions.`}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                {['When', 'Type', 'Amount', 'Reference'].map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-900 bg-white dark:bg-gray-900">
              {rows.map((tx: AdminCreditTransactionView) => (
                <tr key={tx.id}>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700 dark:text-gray-300">
                    {new Date(tx.createdAt).toLocaleString('en-US', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
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
                      <span className="font-mono" title={tx.referenceId}>
                        {tx.referenceType}:{tx.referenceId.slice(0, 8)}…
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav className="flex justify-between" aria-label="Ledger pagination">
        <button
          type="button"
          onClick={pageToTop}
          disabled={beforeCursor === null}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          ← Newest
        </button>
        <button
          type="button"
          onClick={pageOlder}
          disabled={!hasMore}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Older →
        </button>
      </nav>
    </div>
  );
}
