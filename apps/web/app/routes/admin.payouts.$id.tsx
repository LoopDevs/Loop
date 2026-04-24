import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/admin.payouts.$id';
import { shouldRetry } from '~/hooks/query-retry';
import {
  getAdminPayout,
  retryPayout,
  type AdminPayoutView,
  type PayoutState,
} from '~/services/admin';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { RequireAdmin } from '~/components/features/admin/RequireAdmin';
import { CopyButton } from '~/components/features/admin/CopyButton';
import { Spinner } from '~/components/ui/Spinner';
import { ADMIN_LOCALE } from '~/utils/locale';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Payout — Loop' }];
}

const STATE_CLASSES: Record<PayoutState, string> = {
  pending: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  submitted: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  confirmed: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
};

/**
 * Formats a stroops (7-decimal minor) amount as `X.Y <code>`. Strips
 * trailing zeros so `1.2500000 GBPLOOP` renders as `1.25 GBPLOOP`.
 * Falls back to em-dash on non-numeric input.
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

function TimelineRow({ label, iso }: { label: string; iso: string | null }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-3 py-1.5 text-sm">
      <span className="w-24 shrink-0 text-gray-500 dark:text-gray-400">{label}</span>
      {iso !== null ? (
        <span title={iso} className="text-gray-900 dark:text-white tabular-nums">
          {new Date(iso).toLocaleString(ADMIN_LOCALE, { dateStyle: 'medium', timeStyle: 'short' })}
        </span>
      ) : (
        <span className="text-gray-400 dark:text-gray-600">—</span>
      )}
    </div>
  );
}

/**
 * `/admin/payouts/:id` — single-row drill-down for `pending_payouts`
 * (ADR 015/016). Gives ops a permalink for an incident ticket:
 * state timeline, full tx hash + Stellar Expert deep-link, error
 * transcript when failed, retry button on failed rows (ADR 017
 * compliant — prompts for reason, generates an Idempotency-Key).
 */
// A2-1101: see RequireAdmin.tsx for the shell-gate rationale.
export default function AdminPayoutDetailRoute(): React.JSX.Element {
  return (
    <RequireAdmin>
      <AdminPayoutDetailRouteInner />
    </RequireAdmin>
  );
}

function AdminPayoutDetailRouteInner(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['admin-payout', id ?? null],
    queryFn: () => getAdminPayout(id ?? ''),
    enabled: id !== undefined && id.length > 0,
    retry: shouldRetry,
    staleTime: 10_000,
  });

  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const retryMutation = useMutation({
    mutationFn: retryPayout,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-payout'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-payouts'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-treasury'] });
      setRetryError(null);
    },
    onError: (err) => {
      setRetryError(err instanceof Error ? err.message : 'Retry failed');
    },
    onSettled: () => setRetrying(false),
  });

  const handleRetry = (payoutId: string): void => {
    const reason = window.prompt('Reason for retrying this payout? (2–500 chars, logged in audit)');
    if (reason === null) return;
    const trimmed = reason.trim();
    if (trimmed.length < 2 || trimmed.length > 500) {
      setRetryError('Reason must be 2–500 characters');
      return;
    }
    setRetrying(true);
    setRetryError(null);
    retryMutation.mutate({ id: payoutId, reason: trimmed });
  };

  const notFound = query.error instanceof ApiException && query.error.status === 404;

  return (
    <main className="max-w-3xl mx-auto px-6 py-12 space-y-6">
      <AdminNav />
      <nav aria-label="Back to payouts list">
        <Link
          to="/admin/payouts"
          className="text-sm text-gray-600 hover:underline dark:text-gray-400"
        >
          ← All payouts
        </Link>
      </nav>

      {query.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : notFound ? (
        <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Payout not found</h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            No payout with id <code className="font-mono text-xs">{id}</code>.
          </p>
        </section>
      ) : query.isError ? (
        <p className="text-red-600 dark:text-red-400 py-6">
          Failed to load payout. You may not be an admin.
        </p>
      ) : (
        <>
          <Detail row={query.data} />

          {retryError !== null ? (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
            >
              Retry failed: {retryError}
            </div>
          ) : null}

          {query.data.state === 'failed' ? (
            <button
              type="button"
              onClick={() => handleRetry(query.data.id)}
              disabled={retrying}
              className="rounded-lg border border-gray-900 bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
            >
              {retrying ? 'Retrying…' : 'Retry payout'}
            </button>
          ) : null}
        </>
      )}
    </main>
  );
}

function Detail({ row }: { row: AdminPayoutView }): React.JSX.Element {
  const stellarExpertUrl =
    row.txHash !== null
      ? `https://stellar.expert/explorer/public/tx/${encodeURIComponent(row.txHash)}`
      : null;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
            {fmtStroops(row.amountStroops, row.assetCode)}
          </h1>
          <p className="mt-1 text-xs font-mono text-gray-500 dark:text-gray-400 break-all inline-flex items-center gap-1">
            {row.id}
            <CopyButton text={row.id} label="Copy payout id" />
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE_CLASSES[row.state]}`}
        >
          {row.state}
        </span>
      </header>

      <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 text-sm">
        <div>
          <dt className="text-gray-500 dark:text-gray-400">User</dt>
          <dd>
            <Link
              to={`/admin/users/${row.userId}`}
              className="text-blue-600 hover:underline dark:text-blue-400 font-mono text-xs break-all"
            >
              {row.userId}
            </Link>
          </dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Order</dt>
          <dd className="font-mono text-xs text-gray-700 dark:text-gray-300 break-all">
            {row.orderId}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Destination</dt>
          <dd className="font-mono text-xs text-gray-700 dark:text-gray-300 break-all">
            {row.toAddress}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Memo</dt>
          <dd className="font-mono text-xs text-gray-700 dark:text-gray-300 break-all">
            {row.memoText}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Asset issuer</dt>
          <dd className="font-mono text-xs text-gray-700 dark:text-gray-300 break-all">
            {row.assetIssuer}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Attempts</dt>
          <dd className="text-gray-900 dark:text-white tabular-nums">{row.attempts}</dd>
        </div>
      </dl>

      <section className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Timeline
        </h2>
        <div className="mt-2 divide-y divide-gray-100 dark:divide-gray-900">
          <TimelineRow label="Created" iso={row.createdAt} />
          <TimelineRow label="Submitted" iso={row.submittedAt} />
          <TimelineRow label="Confirmed" iso={row.confirmedAt} />
          <TimelineRow label="Failed" iso={row.failedAt} />
        </div>
      </section>

      {row.txHash !== null && stellarExpertUrl !== null ? (
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Transaction
          </h2>
          <p className="mt-2 font-mono text-xs text-gray-700 dark:text-gray-300 break-all">
            {row.txHash}
          </p>
          <a
            href={stellarExpertUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            View on Stellar Expert →
          </a>
        </section>
      ) : null}

      {row.lastError !== null ? (
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
            Last error
          </h2>
          <pre className="mt-2 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-800 dark:text-red-300 whitespace-pre-wrap break-words">
            {row.lastError}
          </pre>
        </section>
      ) : null}
    </section>
  );
}
