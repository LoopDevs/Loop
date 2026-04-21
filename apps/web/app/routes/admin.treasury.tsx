import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { Route } from './+types/admin.treasury';
import { useAuth } from '~/hooks/use-auth';
import { getTreasurySnapshot, type TreasurySnapshot } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Treasury — Loop' }];
}

/**
 * Minor-unit (pence / cent) int string → human currency string.
 * Accepts a BigInt-safe string so we don't silently lose precision
 * for large ledger totals.
 */
function fmtMinor(minor: string, currency: string): string {
  // Normalise sign + digits; values are decimal integers.
  const negative = minor.startsWith('-');
  const digits = negative ? minor.slice(1) : minor;
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2);
  const fraction = padded.slice(-2);
  const sign = negative ? '-' : '';
  const symbol =
    currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : currency === 'USD' ? '$' : '';
  return `${sign}${symbol}${Number(whole).toLocaleString('en-US')}.${fraction} ${currency}`;
}

const KNOWN_TYPES = ['cashback', 'interest', 'refund', 'spend', 'withdrawal', 'adjustment'];

/**
 * `/admin/treasury` — admin-only snapshot of the credits ledger
 * + the CTX operator pool state (ADR 009 / 011 / 013).
 *
 * Backend returns a read-optimised shape so the UI doesn't run its
 * own aggregation — see `src/admin/treasury.ts`.
 */
export default function AdminTreasuryRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const query = useQuery({
    queryKey: ['admin-treasury'],
    queryFn: getTreasurySnapshot,
    enabled: isAuthenticated,
    retry: shouldRetry,
    // Treasury is read-mostly but changes as new orders / credits
    // land. 10s staleness is a balance between "fresh enough for an
    // operator looking at incidents" and "not hammering the ledger
    // aggregation for a tab left open in the background".
    staleTime: 10_000,
  });

  if (!isAuthenticated) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
          Admin · Treasury
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

  if (query.isPending) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12 flex justify-center">
        <Spinner />
      </main>
    );
  }

  if (query.isError) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
          Admin · Treasury
        </h1>
        <p className="text-red-600 dark:text-red-400">
          Failed to load treasury snapshot. You may not be an admin.
        </p>
      </main>
    );
  }

  const snapshot: TreasurySnapshot = query.data;
  const currencies = Object.keys({
    ...snapshot.outstanding,
    ...snapshot.totals,
  }).sort();

  return (
    <main className="max-w-5xl mx-auto px-6 py-12 space-y-10">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Admin · Treasury</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Snapshot of the credits ledger and the CTX supplier pool.
        </p>
      </header>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          Outstanding credit
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          What Loop owes users right now — sum of live user balances.
        </p>
        {currencies.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No credit ledger activity yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {currencies.map((c) => (
              <div
                key={c}
                className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900"
              >
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{c}</div>
                <div className="mt-1 text-xl font-semibold text-gray-900 dark:text-white tabular-nums">
                  {fmtMinor(snapshot.outstanding[c] ?? '0', c)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          Ledger movements (all-time)
        </h2>
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">
                  Currency
                </th>
                {KNOWN_TYPES.map((t) => (
                  <th
                    key={t}
                    className="px-3 py-2 text-right font-medium text-gray-500 dark:text-gray-400 capitalize"
                  >
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-900 bg-white dark:bg-gray-900">
              {currencies.length === 0 ? (
                <tr>
                  <td
                    colSpan={KNOWN_TYPES.length + 1}
                    className="px-3 py-6 text-center text-gray-500 dark:text-gray-400"
                  >
                    No ledger movements yet.
                  </td>
                </tr>
              ) : (
                currencies.map((c) => {
                  const bucket = snapshot.totals[c] ?? {};
                  return (
                    <tr key={c}>
                      <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">{c}</td>
                      {KNOWN_TYPES.map((t) => (
                        <td
                          key={t}
                          className="px-3 py-2 text-right tabular-nums text-gray-700 dark:text-gray-300"
                        >
                          {bucket[t] !== undefined ? fmtMinor(bucket[t], c) : '—'}
                        </td>
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          CTX operator pool
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Service accounts fronting CTX — ADR 013. Each entry has its own circuit breaker.
        </p>
        {snapshot.operatorPool.size === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Pool is unconfigured (<code>CTX_OPERATOR_POOL</code> not set).
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
            {snapshot.operatorPool.operators.map((op) => (
              <li key={op.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <span className="font-medium text-gray-900 dark:text-white">{op.id}</span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    op.state === 'closed'
                      ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                      : op.state === 'half_open'
                        ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
                        : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                  }`}
                >
                  {op.state}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
