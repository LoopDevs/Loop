import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import type { Route } from './+types/admin.operators.$operatorId';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';
import {
  getOperatorActivity,
  getOperatorLatency,
  getOperatorStats,
  getOperatorSupplierSpend,
  type OperatorActivityDay,
  type SupplierSpendRow,
} from '~/services/admin';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { Spinner } from '~/components/ui/Spinner';
import { shortDay } from '~/components/features/admin/PaymentMethodActivityChart';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Operator — Loop' }];
}

function fmtMinor(minor: string, currency: string): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n / 100);
  } catch {
    return `${(n / 100).toFixed(2)} ${currency}`;
  }
}

function fmtMs(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

/**
 * `/admin/operators/:operatorId` — single-operator drill page
 * (ADR 013 / 022). Lands the operator quartet on one surface:
 *
 *   - Fleet operator-stats row filtered to this operator
 *     → order count, fulfilled count, failed count, last-order
 *   - Fleet operator-latency row filtered to this operator
 *     → p50 / p95 / p99 fulfilment latency
 *   - Per-operator supplier-spend — /operators/:id/supplier-spend
 *     → per-currency wholesale + margin breakdown
 *   - Per-operator activity — /operators/:id/activity
 *     → 30-day created/fulfilled/failed time-series
 *
 * Companion to /admin/treasury: that page shows the fleet view
 * (who's busy? who's slow?); this page is the drill answer to
 * "why is op-alpha-01 carrying so much spend this week?".
 *
 * The fleet stats + latency queries reuse endpoints already loaded
 * by the treasury page — if the operator just arrived from there,
 * TanStack Query's 30-60s staleTime keeps the cache warm.
 */
export default function AdminOperatorDetailRoute(): React.JSX.Element {
  const { operatorId = '' } = useParams<{ operatorId: string }>();
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();

  const statsQuery = useQuery({
    queryKey: ['admin-operator-stats'],
    queryFn: () => getOperatorStats(),
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  const latencyQuery = useQuery({
    queryKey: ['admin-operator-latency'],
    queryFn: () => getOperatorLatency(),
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  const spendQuery = useQuery({
    queryKey: ['admin-operator-supplier-spend', operatorId],
    queryFn: () => getOperatorSupplierSpend(operatorId),
    enabled: isAuthenticated && operatorId.length > 0,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  const activityQuery = useQuery({
    queryKey: ['admin-operator-activity', operatorId, 30],
    queryFn: () => getOperatorActivity(operatorId, { days: 30 }),
    enabled: isAuthenticated && operatorId.length > 0,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  if (!isAuthenticated) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
          Admin · Operator
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

  const statsRow = statsQuery.data?.rows.find((r) => r.operatorId === operatorId);
  const latencyRow = latencyQuery.data?.rows.find((r) => r.operatorId === operatorId);

  return (
    <main className="max-w-5xl mx-auto px-6 py-12 space-y-10">
      <AdminNav />
      <header>
        <nav className="mb-2 text-sm">
          <Link to="/admin/treasury" className="text-blue-600 hover:underline dark:text-blue-400">
            ← Treasury
          </Link>
        </nav>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white break-all font-mono">
          {operatorId || '(unknown operator)'}
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          CTX supplier operator — ADR 013 / 022.
        </p>
        <Link
          to={`/admin/orders?ctxOperatorId=${encodeURIComponent(operatorId)}`}
          className="inline-block mt-3 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          Orders carried by this operator →
        </Link>
      </header>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          Recent activity (24h)
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Aggregate count from the fleet operator-stats feed. Failed non-zero means this operator
          has tripped at least one order; page ops if it's rising.
        </p>
        {statsQuery.isPending ? (
          <Spinner />
        ) : statsQuery.isError ? (
          <p className="text-sm text-red-600 dark:text-red-400">Failed to load operator stats.</p>
        ) : statsRow === undefined ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No orders in the last 24 hours for this operator.
          </p>
        ) : (
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Metric label="Orders" value={String(statsRow.orderCount)} />
            <Metric label="Fulfilled" value={String(statsRow.fulfilledCount)} />
            <Metric
              label="Failed"
              value={String(statsRow.failedCount)}
              tone={statsRow.failedCount > 0 ? 'warn' : undefined}
            />
            <Metric label="Last order" value={shortDay(statsRow.lastOrderAt.slice(0, 10))} />
          </dl>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          Fulfilment latency (24h)
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          p50 / p95 / p99 of <code className="text-xs">fulfilledAt − paidAt</code> for fulfilled
          orders this operator carried. A rising p95 is the early signal before the circuit breaker
          trips.
        </p>
        {latencyQuery.isPending ? (
          <Spinner />
        ) : latencyQuery.isError ? (
          <p className="text-sm text-red-600 dark:text-red-400">Failed to load operator latency.</p>
        ) : latencyRow === undefined ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No fulfilled orders in the last 24 hours — no latency sample.
          </p>
        ) : (
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Metric label="p50" value={fmtMs(latencyRow.p50Ms)} />
            <Metric
              label="p95"
              value={fmtMs(latencyRow.p95Ms)}
              tone={latencyRow.p95Ms > 30_000 ? 'warn' : undefined}
            />
            <Metric label="p99" value={fmtMs(latencyRow.p99Ms)} />
            <Metric
              label="Samples"
              value={String(latencyRow.sampleCount)}
              tone={latencyRow.sampleCount < 5 ? 'muted' : undefined}
            />
          </dl>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          Supplier spend (24h)
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Per-currency aggregate of what Loop paid CTX for fulfilled orders this operator carried
          (ADR 013 / 015). <em>Wholesale</em> is the procurement cost; <em>margin</em> is what Loop
          kept after cashback.
        </p>
        {spendQuery.isPending ? (
          <Spinner />
        ) : spendQuery.isError ? (
          <p className="text-sm text-red-600 dark:text-red-400">
            Failed to load operator supplier spend.
          </p>
        ) : spendQuery.data.rows.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No fulfilled orders in the last 24 hours — no supplier spend to show.
          </p>
        ) : (
          <SpendTable rows={spendQuery.data.rows} />
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          30-day activity
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Per-day created / fulfilled / failed orders. Zero-filled by the backend so the layout
          stays stable even when the operator is idle.
        </p>
        {activityQuery.isPending ? (
          <Spinner />
        ) : activityQuery.isError ? (
          <p className="text-sm text-red-600 dark:text-red-400">
            Failed to load operator activity.
          </p>
        ) : (
          <ActivityChart days={activityQuery.data.days} />
        )}
      </section>
    </main>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'warn' | 'muted';
}): React.JSX.Element {
  const valueClass =
    tone === 'warn'
      ? 'text-amber-700 dark:text-amber-400'
      : tone === 'muted'
        ? 'text-gray-400 dark:text-gray-500'
        : 'text-gray-900 dark:text-white';
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900">
      <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className={`mt-1 text-xl font-semibold tabular-nums ${valueClass}`}>{value}</dd>
    </div>
  );
}

function SpendTable({ rows }: { rows: SupplierSpendRow[] }): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">
              Currency
            </th>
            <th className="px-3 py-2 text-right font-medium text-gray-500 dark:text-gray-400">
              Count
            </th>
            <th className="px-3 py-2 text-right font-medium text-gray-500 dark:text-gray-400">
              Face value
            </th>
            <th className="px-3 py-2 text-right font-medium text-gray-500 dark:text-gray-400">
              Wholesale
            </th>
            <th className="px-3 py-2 text-right font-medium text-gray-500 dark:text-gray-400">
              Cashback
            </th>
            <th className="px-3 py-2 text-right font-medium text-gray-500 dark:text-gray-400">
              Margin
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-900 bg-white dark:bg-gray-900">
          {rows.map((r) => (
            <tr key={r.currency}>
              <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">{r.currency}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.count}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {fmtMinor(r.faceValueMinor, r.currency)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums font-medium">
                {fmtMinor(r.wholesaleMinor, r.currency)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-green-700 dark:text-green-400">
                {fmtMinor(r.userCashbackMinor, r.currency)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-blue-700 dark:text-blue-400">
                {fmtMinor(r.loopMarginMinor, r.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivityChart({ days }: { days: OperatorActivityDay[] }): React.JSX.Element {
  const max = days.reduce((m, d) => Math.max(m, d.created), 0);
  if (max === 0) {
    return (
      <p className="py-2 text-sm text-gray-500 dark:text-gray-400">
        No orders for this operator in the last 30 days.
      </p>
    );
  }
  return (
    <ul role="list" className="space-y-1">
      {days.map((d) => {
        const createdPct = max === 0 ? 0 : (d.created / max) * 100;
        const fulfilledPct = max === 0 ? 0 : (d.fulfilled / max) * 100;
        const failedPct = max === 0 ? 0 : (d.failed / max) * 100;
        const label = `${shortDay(d.day)}: ${d.created} created, ${d.fulfilled} fulfilled, ${d.failed} failed`;
        return (
          <li key={d.day} className="flex items-center gap-2 text-xs" aria-label={label}>
            <span className="shrink-0 w-16 tabular-nums text-gray-500 dark:text-gray-400">
              {shortDay(d.day)}
            </span>
            <span className="relative flex h-3 flex-1 overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
              <span
                className="absolute inset-y-0 left-0 bg-gray-400/40 dark:bg-gray-500/30"
                style={{ width: `${createdPct}%` }}
                aria-hidden="true"
              />
              <span
                className="absolute inset-y-0 left-0 bg-green-500/80 dark:bg-green-400/70"
                style={{ width: `${fulfilledPct}%` }}
                aria-hidden="true"
              />
              {d.failed > 0 ? (
                <span
                  className="absolute inset-y-0 right-0 bg-rose-500/70 dark:bg-rose-400/60"
                  style={{ width: `${failedPct}%` }}
                  aria-hidden="true"
                />
              ) : null}
            </span>
            <span className="shrink-0 w-24 tabular-nums text-right text-gray-700 dark:text-gray-300">
              {d.fulfilled}/{d.created}
              {d.failed > 0 ? (
                <span className="text-rose-600 dark:text-rose-400"> · {d.failed}✗</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
