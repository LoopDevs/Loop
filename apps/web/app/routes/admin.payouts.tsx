import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { Route } from './+types/admin.payouts';
import { useAuth } from '~/hooks/use-auth';
import { listPayouts, retryPayout, type AdminPayoutView, type PayoutState } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { Spinner } from '~/components/ui/Spinner';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Payouts — Loop' }];
}

const STATES: readonly (PayoutState | 'all')[] = [
  'all',
  'pending',
  'submitted',
  'confirmed',
  'failed',
];

function fmtStroops(stroops: string, code: string): string {
  const negative = stroops.startsWith('-');
  const digits = negative ? stroops.slice(1) : stroops;
  const padded = digits.padStart(8, '0');
  const whole = padded.slice(0, -7);
  const fractionRaw = padded.slice(-7).replace(/0+$/, '');
  const fraction = fractionRaw.length > 0 ? `.${fractionRaw}` : '';
  const sign = negative ? '-' : '';
  return `${sign}${Number(whole).toLocaleString('en-US')}${fraction} ${code}`;
}

function truncId(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function statePillClass(s: PayoutState): string {
  switch (s) {
    case 'confirmed':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
    case 'failed':
      return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
    case 'submitted':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
    case 'pending':
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }
}

/**
 * `/admin/payouts` — drilldown list for ADR 015/016's
 * `pending_payouts`. Filter chips route via `?state=`; failed rows
 * show a Retry button that wraps `resetPayoutToPending`.
 */
export default function AdminPayoutsRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const stateParam = searchParams.get('state');
  const activeState = STATES.includes(stateParam as PayoutState | 'all')
    ? (stateParam as PayoutState | 'all')
    : 'all';
  // `?userId=<uuid>` narrows the list to one user's payouts —
  // cross-link target from `/admin/orders`. Validated here with the
  // same regex the backend uses so an in-page link change takes
  // effect immediately; a malformed param is treated as absent so
  // the list stays usable rather than 400-ing the whole page.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const userIdParamRaw = searchParams.get('userId');
  const activeUserId =
    userIdParamRaw !== null && UUID_RE.test(userIdParamRaw) ? userIdParamRaw : null;

  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['admin-payouts', activeState, activeUserId],
    queryFn: () =>
      listPayouts({
        limit: 50,
        ...(activeState === 'all' ? {} : { state: activeState }),
        ...(activeUserId !== null ? { userId: activeUserId } : {}),
      }),
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 10_000,
  });

  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const retryMutation = useMutation({
    mutationFn: retryPayout,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-payouts'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-treasury'] });
      setRetryError(null);
    },
    onError: (err) => {
      setRetryError(err instanceof Error ? err.message : 'Retry failed');
    },
    onSettled: () => setRetryingId(null),
  });

  const handleRetry = (id: string): void => {
    setRetryingId(id);
    setRetryError(null);
    retryMutation.mutate(id);
  };

  const setState = (next: PayoutState | 'all'): void => {
    setSearchParams((params) => {
      if (next === 'all') params.delete('state');
      else params.set('state', next);
      return params;
    });
  };

  const clearUserFilter = (): void => {
    setSearchParams((params) => {
      params.delete('userId');
      return params;
    });
  };

  if (!isAuthenticated) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
          Admin · Payouts
        </h1>
        <p className="text-gray-700 dark:text-gray-300 mb-6">Sign in with an admin account.</p>
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
    <main className="max-w-6xl mx-auto px-6 py-12 space-y-6">
      <AdminNav />
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Admin · Payouts</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Stellar cashback emissions (ADR 015/016). Filter by state; retry failed rows with the
          button at the row level.
        </p>
      </header>

      {activeUserId !== null && (
        // Cross-link indicator — tells the admin this list is narrowed
        // to one user and gives them a one-click out. Rendered above
        // the state pills so it reads first when the filter is active.
        <div className="flex items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 dark:border-blue-900/50 dark:bg-blue-900/10">
          <p className="text-sm text-blue-800 dark:text-blue-300">
            Filtered to user <code className="font-mono text-xs">{activeUserId.slice(0, 8)}</code>
          </p>
          <button
            type="button"
            onClick={clearUserFilter}
            className="text-xs font-medium text-blue-700 hover:text-blue-800 underline underline-offset-2 dark:text-blue-300 dark:hover:text-blue-200"
          >
            Clear user filter
          </button>
        </div>
      )}

      <nav className="flex flex-wrap gap-2" aria-label="Payout state filter">
        {STATES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setState(s)}
            className={`rounded-full px-3 py-1 text-sm font-medium border ${
              activeState === s
                ? 'border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-gray-900'
                : 'border-gray-200 text-gray-700 bg-white dark:border-gray-700 dark:text-gray-300 dark:bg-gray-900'
            }`}
          >
            {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </nav>

      {retryError !== null ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
        >
          Retry failed: {retryError}
        </div>
      ) : null}

      {query.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : query.isError ? (
        <p className="text-red-600 dark:text-red-400 py-6">
          Failed to load payouts. You may not be an admin.
        </p>
      ) : query.data.payouts.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-6">
          No payouts in this bucket yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                {[
                  'When',
                  'State',
                  'Asset',
                  'Amount',
                  'User',
                  'To',
                  'Tx / Error',
                  'Attempts',
                  '',
                ].map((h) => (
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
              {query.data.payouts.map((p: AdminPayoutView) => (
                <tr key={p.id}>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700 dark:text-gray-300">
                    {new Date(p.createdAt).toLocaleString('en-US', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statePillClass(p.state)}`}
                    >
                      {p.state}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                    {p.assetCode}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                    {fmtStroops(p.amountStroops, p.assetCode)}
                  </td>
                  <td className="px-3 py-2">
                    {/* Reverse cross-link to /admin/orders — lets ops
                        pivot from "which payout is this?" back to
                        "which orders drove this user's backlog?".
                        Matches the user-id link on /admin/orders. */}
                    <Link
                      to={`/admin/orders?userId=${encodeURIComponent(p.userId)}`}
                      className="font-mono text-xs text-blue-700 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 underline underline-offset-2"
                      title={`View orders for ${p.userId}`}
                    >
                      {truncId(p.userId)}
                    </Link>
                  </td>
                  <td
                    className="px-3 py-2 font-mono text-xs text-gray-600 dark:text-gray-400"
                    title={p.toAddress}
                  >
                    {truncId(p.toAddress)}
                  </td>
                  <td className="px-3 py-2 text-xs max-w-xs">
                    {p.state === 'failed' && p.lastError !== null ? (
                      <span className="text-red-600 dark:text-red-400 line-clamp-2">
                        {p.lastError}
                      </span>
                    ) : p.txHash !== null ? (
                      <span className="font-mono text-gray-600 dark:text-gray-400" title={p.txHash}>
                        {truncId(p.txHash)}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                    {p.attempts}
                  </td>
                  <td className="px-3 py-2">
                    {p.state === 'failed' ? (
                      <button
                        type="button"
                        onClick={() => handleRetry(p.id)}
                        disabled={retryingId === p.id}
                        className="rounded-lg border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
                      >
                        {retryingId === p.id ? 'Retrying…' : 'Retry'}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
