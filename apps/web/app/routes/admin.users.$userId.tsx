import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/admin.users.$userId';
import { useAuth } from '~/hooks/use-auth';
import {
  createCreditAdjustment,
  getAdminUser,
  getAdminUserCreditHistory,
  type AdminUserView,
} from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { Button } from '~/components/ui/Button';
import { Spinner } from '~/components/ui/Spinner';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · User — Loop' }];
}

/**
 * Minor-unit bigint-string → home-currency-formatted decimal. Kept
 * local (not shared) because only two admin pages format home-currency
 * values today and both have their own variant. A follow-up consolidates
 * these into `@loop/shared/money` once the helper shape stabilises.
 */
function fmtMinor(minor: string, currency: string): string {
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

/** Abbreviated Stellar pubkey for UI display — G...xyz. */
function truncPubkey(pk: string): string {
  if (pk.length <= 12) return pk;
  return `${pk.slice(0, 6)}…${pk.slice(-4)}`;
}

/**
 * Parses a signed decimal input ("5.00", "-10.5", "3") into a minor-unit
 * bigint-string. Returns null on malformed input so the caller can
 * surface a validation error rather than silently converting garbage.
 * Two decimal places max — matches every home-currency we support;
 * inputs with more precision are rejected outright.
 */
function decimalToMinor(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (match === null) return null;
  const sign = match[1] === '-' ? '-' : '';
  const whole = match[2] ?? '0';
  const fraction = (match[3] ?? '').padEnd(2, '0');
  // Drop any leading zeros on the whole portion so bigint parse is clean.
  const combined = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
  if (combined === '' || combined === '0') return '0';
  try {
    return BigInt(`${sign}${combined}`).toString();
  } catch {
    return null;
  }
}

/**
 * `/admin/users/:userId` — admin user drill-down (ADR 011 / 015).
 *
 * Renders the one-shot summary from `GET /api/admin/users/:userId`
 * (identity, balance, lifetime cashback, counts) alongside two
 * deep-links into the existing paginated admin views:
 *   - /admin/orders?userId=X — every order by this user
 *   - /admin/payouts?userId=X — every payout tied to this user
 *
 * Landing here from those pages and back again is how an admin
 * triages a specific user across order/payout/balance states.
 */
export default function AdminUserRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const params = useParams();
  const userId = params['userId'] ?? '';
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['admin-user', userId],
    queryFn: () => getAdminUser(userId),
    enabled: isAuthenticated && userId.length > 0,
    retry: shouldRetry,
    staleTime: 10_000,
  });

  // Head-only ledger (20 most-recent entries). Pagination via
  // `?before=<iso>` is wired on the backend + service; the UI here
  // keeps the first cut simple — a follow-up adds the "Load more"
  // button once we've seen how deep support typically scrolls.
  const historyQuery = useQuery({
    queryKey: ['admin-user-credit-history', userId],
    queryFn: () => getAdminUserCreditHistory(userId, { limit: 20 }),
    enabled: isAuthenticated && userId.length > 0,
    retry: shouldRetry,
    staleTime: 10_000,
  });

  const [amountInput, setAmountInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [successSummary, setSuccessSummary] = useState<string | null>(null);

  const adjustMutation = useMutation({
    mutationFn: async (input: {
      amountMinor: string;
      currency: 'USD' | 'GBP' | 'EUR';
      note: string;
    }) => createCreditAdjustment(userId, input),
    onSuccess: (res) => {
      setAmountInput('');
      setNoteInput('');
      setFormError(null);
      setSuccessSummary(
        `${res.entry.amountMinor.startsWith('-') ? 'Debited' : 'Credited'} ${res.entry.amountMinor} minor ${res.entry.currency} · new balance ${res.balance.balanceMinor}`,
      );
      void queryClient.invalidateQueries({ queryKey: ['admin-user', userId] });
      // Ledger table below should now show the new adjustment row.
      void queryClient.invalidateQueries({ queryKey: ['admin-user-credit-history', userId] });
      // Invalidate the treasury snapshot too — outstanding credit moves.
      void queryClient.invalidateQueries({ queryKey: ['admin-treasury'] });
    },
    onError: (err) => {
      setSuccessSummary(null);
      if (err instanceof ApiException) {
        setFormError(err.message);
      } else if (err instanceof Error) {
        setFormError(err.message);
      } else {
        setFormError('Failed to write adjustment');
      }
    },
  });

  if (!isAuthenticated) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">Admin · User</h1>
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
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">Admin · User</h1>
        <p className="text-red-600 dark:text-red-400">
          Failed to load user. The id may be wrong, or you may not be an admin.
        </p>
      </main>
    );
  }

  const user: AdminUserView = query.data.user;

  return (
    <main className="max-w-5xl mx-auto px-6 py-12 space-y-8">
      <AdminNav />

      <header className="space-y-2">
        <p className="text-xs uppercase tracking-wide font-semibold text-gray-500 dark:text-gray-400">
          Admin · User
        </p>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white break-all">
          {user.email}
        </h1>
        <div className="flex flex-wrap gap-2 text-xs">
          {user.isAdmin ? (
            <span className="rounded-full px-2.5 py-0.5 font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
              admin
            </span>
          ) : null}
          <span className="rounded-full px-2.5 py-0.5 font-medium bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
            home · {user.homeCurrency}
          </span>
          <span className="font-mono text-gray-500 dark:text-gray-400">{user.id}</span>
        </div>
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Balance</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white tabular-nums">
            {fmtMinor(user.balanceMinor, user.homeCurrency)}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            What Loop owes this user right now.
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Lifetime cashback earned
          </div>
          <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white tabular-nums">
            {fmtMinor(user.lifetimeCashbackEarnedMinor, user.homeCurrency)}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Cashback credited since signup. Withdrawals don&apos;t reduce this.
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          Account details
        </h2>
        <dl className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-900 text-sm">
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-gray-500 dark:text-gray-400">Stellar address</dt>
            <dd className="font-mono text-gray-900 dark:text-white">
              {user.stellarAddress === null ? (
                <span className="text-gray-500 dark:text-gray-400">not linked</span>
              ) : (
                truncPubkey(user.stellarAddress)
              )}
            </dd>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-gray-500 dark:text-gray-400">Signed up</dt>
            <dd className="text-gray-900 dark:text-white">
              {new Date(user.createdAt).toLocaleString()}
            </dd>
          </div>
        </dl>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">Activity</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Link
            to={`/admin/orders?userId=${encodeURIComponent(user.id)}`}
            className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900 hover:border-gray-400 dark:hover:border-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Orders</div>
            <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white tabular-nums">
              {user.orderCount}
            </div>
            <div className="text-xs text-blue-600 dark:text-blue-400 mt-1">See all orders →</div>
          </Link>
          <Link
            to={`/admin/payouts?userId=${encodeURIComponent(user.id)}`}
            className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900 hover:border-gray-400 dark:hover:border-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Open payouts</div>
            <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white tabular-nums">
              {user.pendingPayoutCount}
            </div>
            <div className="text-xs text-blue-600 dark:text-blue-400 mt-1">See all payouts →</div>
          </Link>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          Credit adjustment
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Support-initiated write to this user&apos;s balance (ADR 009 / 011). Positive credits,
          negative debits. Every adjustment is logged with your admin id and the note below.
        </p>
        <form
          className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(null);
            setSuccessSummary(null);
            const minor = decimalToMinor(amountInput);
            if (minor === null) {
              setFormError('Enter a signed decimal like 5.00 or -10.50');
              return;
            }
            if (minor === '0') {
              setFormError('Amount must be non-zero');
              return;
            }
            const trimmedNote = noteInput.trim();
            if (trimmedNote.length < 3) {
              setFormError('Note must be at least 3 characters');
              return;
            }
            adjustMutation.mutate({
              amountMinor: minor,
              currency: user.homeCurrency,
              note: trimmedNote,
            });
          }}
        >
          <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Amount ({user.homeCurrency})
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                placeholder="e.g. 5.00"
                className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2 text-sm text-gray-900 dark:text-white tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-500"
                aria-label="Adjustment amount"
                disabled={adjustMutation.isPending}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Note (audit trail)
              </span>
              <textarea
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                placeholder="e.g. Goodwill credit — support chat #1234"
                rows={2}
                className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                aria-label="Adjustment note"
                disabled={adjustMutation.isPending}
                maxLength={500}
              />
            </label>
          </div>
          {formError !== null ? (
            <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>
          ) : null}
          {successSummary !== null ? (
            <p className="text-sm text-green-700 dark:text-green-400">{successSummary}</p>
          ) : null}
          <div className="flex items-center justify-end">
            <Button type="submit" disabled={adjustMutation.isPending}>
              {adjustMutation.isPending ? 'Writing…' : 'Write adjustment'}
            </Button>
          </div>
        </form>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">Recent ledger</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          The last 20 credit-transactions for this user — cashback, interest, withdrawals, and
          support adjustments. Notes on <code className="text-xs">adjustment</code> rows are visible
          only to admins.
        </p>
        {historyQuery.isPending ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : historyQuery.isError ? (
          <p className="text-sm text-red-600 dark:text-red-400">Failed to load ledger.</p>
        ) : historyQuery.data.entries.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No ledger activity yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">
                    When
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">
                    Type
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-gray-500 dark:text-gray-400">
                    Amount
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">
                    Reference / note
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-900 bg-white dark:bg-gray-900">
                {historyQuery.data.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                      {new Date(e.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${ledgerTypeClass(e.type)}`}
                      >
                        {e.type}
                      </span>
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${e.amountMinor.startsWith('-') ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'}`}
                    >
                      {fmtMinor(e.amountMinor, e.currency)}
                    </td>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-300">
                      {e.note !== null ? (
                        <span className="italic">{e.note}</span>
                      ) : e.referenceType !== null ? (
                        <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                          {e.referenceType}
                          {e.referenceId !== null ? ` · ${e.referenceId.slice(0, 8)}…` : ''}
                        </span>
                      ) : (
                        <span className="text-gray-400 dark:text-gray-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

/**
 * Pill colour per ledger type. Cashback/interest/refund earn green;
 * spend/withdrawal red; adjustment yellow (operator touched this row);
 * unknown falls back to neutral.
 */
function ledgerTypeClass(type: string): string {
  switch (type) {
    case 'cashback':
    case 'interest':
    case 'refund':
      return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
    case 'spend':
    case 'withdrawal':
      return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
    case 'adjustment':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }
}
