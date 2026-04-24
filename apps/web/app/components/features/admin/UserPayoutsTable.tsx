import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { listPayouts, type AdminPayoutView, type PayoutState } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { ADMIN_LOCALE } from '~/utils/locale';

const LIMIT = 25;

const STATE_CLASSES: Record<PayoutState, string> = {
  pending: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  submitted: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  confirmed: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
};

/**
 * Formats a stroops (7-decimal minor) amount as `X.Y <code>` — trims
 * trailing zeros, falls back to em-dash on non-numeric input.
 */
export function fmtStroops(stroops: string, code: string): string {
  const negative = stroops.startsWith('-');
  const digits = negative ? stroops.slice(1) : stroops;
  if (!/^\d+$/.test(digits)) return '—';
  const padded = digits.padStart(8, '0');
  const whole = padded.slice(0, -7);
  const fractionRaw = padded.slice(-7).replace(/0+$/, '');
  const fraction = fractionRaw.length > 0 ? `.${fractionRaw}` : '';
  const sign = negative ? '-' : '';
  return `${sign}${Number(whole).toLocaleString(ADMIN_LOCALE)}${fraction} ${code}`;
}

interface Props {
  userId: string;
}

/**
 * Shows the user's most recent on-chain payouts on
 * `/admin/users/:userId`. Uses listPayouts with `?userId=` so we get
 * the same BigInt-safe view as the global payouts list. Each row id
 * links to the payout detail drill-down.
 */
export function UserPayoutsTable({ userId }: Props): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-user-payouts', userId, LIMIT],
    queryFn: () => listPayouts({ userId, limit: LIMIT }),
    retry: shouldRetry,
    staleTime: 15_000,
  });

  if (query.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  if (query.isError) {
    return <p className="py-4 text-sm text-red-600 dark:text-red-400">Failed to load payouts.</p>;
  }

  if (query.data.payouts.length === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No on-chain payouts for this user yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            {['When', 'Payout', 'Asset', 'Amount', 'State', 'Attempts'].map((h) => (
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
          {query.data.payouts.map((row: AdminPayoutView) => (
            <tr key={row.id}>
              <td className="px-3 py-2 whitespace-nowrap text-gray-700 dark:text-gray-300">
                {new Date(row.createdAt).toLocaleString(ADMIN_LOCALE, {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}
              </td>
              <td className="px-3 py-2">
                <Link
                  to={`/admin/payouts/${row.id}`}
                  className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
                  title={row.id}
                >
                  {row.id.slice(0, 8)}
                </Link>
              </td>
              <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                {row.assetCode}
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                {fmtStroops(row.amountStroops, row.assetCode)}
              </td>
              <td className="px-3 py-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_CLASSES[row.state]}`}
                >
                  {row.state}
                </span>
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                {row.attempts}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
