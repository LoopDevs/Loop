import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  getPayoutsByAsset,
  type PayoutsByAssetRow,
  type PerStateBreakdown,
} from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

/**
 * Renders a stroops-as-string amount as `X.Y <code>`. Same formatting
 * as /admin/payouts (7-decimal stellar minor → major). Falls back
 * to `—` for non-numeric input so a bad response doesn't print NaN.
 */
function fmtStroops(stroops: string, code: string): string {
  const negative = stroops.startsWith('-');
  const digits = negative ? stroops.slice(1) : stroops;
  if (!/^\d+$/.test(digits)) return '—';
  const padded = digits.padStart(8, '0');
  const whole = padded.slice(0, -7);
  const fractionRaw = padded.slice(-7).replace(/0+$/, '');
  const fraction = fractionRaw.length > 0 ? `.${fractionRaw}` : '';
  const sign = negative ? '-' : '';
  return `${sign}${Number(whole).toLocaleString('en-US')}${fraction} ${code}`;
}

function StateCell({
  value,
  assetCode,
  emphasiseFailed = false,
}: {
  value: PerStateBreakdown;
  assetCode: string;
  emphasiseFailed?: boolean;
}): React.JSX.Element {
  if (value.count === 0) {
    return <span className="text-gray-400 dark:text-gray-600">—</span>;
  }
  return (
    <div className={emphasiseFailed ? 'text-red-700 dark:text-red-400' : ''}>
      <div className="tabular-nums font-medium">{value.count}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400">
        {fmtStroops(value.stroops, assetCode)}
      </div>
    </div>
  );
}

export function PayoutsByAssetTable(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-payouts-by-asset'],
    queryFn: getPayoutsByAsset,
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
    return (
      <p className="py-4 text-sm text-red-600 dark:text-red-400">
        Failed to load per-asset payout breakdown.
      </p>
    );
  }

  if (query.data.rows.length === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">No pending_payouts rows yet.</p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            {['Asset', 'Pending', 'Submitted', 'Confirmed', 'Failed'].map((h) => (
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
          {query.data.rows.map((row: PayoutsByAssetRow) => (
            <tr key={row.assetCode}>
              <td className="px-3 py-3 font-medium text-gray-900 dark:text-white">
                <Link
                  to={`/admin/payouts?assetCode=${row.assetCode}`}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                  aria-label={`Show all ${row.assetCode} payouts`}
                >
                  {row.assetCode}
                </Link>
              </td>
              <td className="px-3 py-3">
                <StateCell value={row.pending} assetCode={row.assetCode} />
              </td>
              <td className="px-3 py-3">
                <StateCell value={row.submitted} assetCode={row.assetCode} />
              </td>
              <td className="px-3 py-3">
                <StateCell value={row.confirmed} assetCode={row.assetCode} />
              </td>
              <td className="px-3 py-3">
                {row.failed.count > 0 ? (
                  <Link
                    to={`/admin/payouts?state=failed&assetCode=${row.assetCode}`}
                    className="hover:underline"
                    aria-label={`Review ${row.failed.count} failed ${row.assetCode} payouts`}
                  >
                    <StateCell value={row.failed} assetCode={row.assetCode} emphasiseFailed />
                  </Link>
                ) : (
                  <StateCell value={row.failed} assetCode={row.assetCode} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
