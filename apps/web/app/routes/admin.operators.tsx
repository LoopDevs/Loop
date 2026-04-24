import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { Route } from './+types/admin.operators';
import { shouldRetry } from '~/hooks/query-retry';
import {
  getOperatorLatency,
  getOperatorStats,
  type OperatorLatencyRow,
  type OperatorStatsRow,
} from '~/services/admin';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { RequireAdmin } from '~/components/features/admin/RequireAdmin';
import { CsvDownloadButton } from '~/components/features/admin/CsvDownloadButton';
import { Spinner } from '~/components/ui/Spinner';
import { successRatePct } from '~/components/features/admin/OperatorStatsCard';
import { ADMIN_LOCALE } from '~/utils/locale';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Operators — Loop' }];
}

interface CombinedRow {
  operatorId: string;
  orderCount: number;
  fulfilledCount: number;
  failedCount: number;
  lastOrderAt: string;
  p50Ms: number | null;
  p95Ms: number | null;
  sampleCount: number;
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Joins the fleet operator-stats + operator-latency rows by
 * operatorId. Latency is optional — an operator that's been busy
 * but had zero *fulfilled* orders still shows up in stats (with
 * null latency); the reverse can happen during a partial window
 * slice when stats has cleared its cache but latency hasn't.
 *
 * Sort: failed DESC (surface incidents), then orderCount DESC
 * (busy operators bubble up), then id ASC for stable tie-break.
 */
export function combineRows(
  stats: OperatorStatsRow[],
  latency: OperatorLatencyRow[],
): CombinedRow[] {
  const byId = new Map<string, OperatorLatencyRow>();
  for (const r of latency) byId.set(r.operatorId, r);

  const rows: CombinedRow[] = stats.map((s) => {
    const l = byId.get(s.operatorId);
    return {
      operatorId: s.operatorId,
      orderCount: s.orderCount,
      fulfilledCount: s.fulfilledCount,
      failedCount: s.failedCount,
      lastOrderAt: s.lastOrderAt,
      p50Ms: l?.p50Ms ?? null,
      p95Ms: l?.p95Ms ?? null,
      sampleCount: l?.sampleCount ?? 0,
    };
  });

  rows.sort((a, b) => {
    if (a.failedCount !== b.failedCount) return b.failedCount - a.failedCount;
    if (a.orderCount !== b.orderCount) return b.orderCount - a.orderCount;
    return a.operatorId.localeCompare(b.operatorId);
  });
  return rows;
}

/**
 * `/admin/operators` — fleet index of CTX supplier operators
 * (ADR 013 / 022). Top-level entry point in AdminNav so the per-
 * operator drill (shipped as /admin/operators/:operatorId) is
 * discoverable without going via the treasury page's
 * `OperatorStatsCard`.
 *
 * Joins `/api/admin/operator-stats` (busy-ness + success rate) with
 * `/api/admin/operators/latency` (p50/p95 fulfilment latency) into
 * one sortable table. Operator id is a drill-down link into the
 * detail page; failed-count keeps its incident-triage shortcut into
 * `/admin/orders` for direct triage.
 */
// A2-1101: see RequireAdmin.tsx for the shell-gate rationale.
export default function AdminOperatorsIndexRoute(): React.JSX.Element {
  return (
    <RequireAdmin>
      <AdminOperatorsIndexRouteInner />
    </RequireAdmin>
  );
}

function AdminOperatorsIndexRouteInner(): React.JSX.Element {
  const statsQuery = useQuery({
    queryKey: ['admin-operator-stats'],
    queryFn: () => getOperatorStats(),
    retry: shouldRetry,
    staleTime: 30_000,
  });

  const latencyQuery = useQuery({
    queryKey: ['admin-operator-latency'],
    queryFn: () => getOperatorLatency(),
    retry: shouldRetry,
    staleTime: 30_000,
  });

  const rows = useMemo(
    () => combineRows(statsQuery.data?.rows ?? [], latencyQuery.data?.rows ?? []),
    [statsQuery.data, latencyQuery.data],
  );

  const isPending = statsQuery.isPending || latencyQuery.isPending;
  const hasError = statsQuery.isError || latencyQuery.isError;

  return (
    <main className="max-w-5xl mx-auto px-6 py-12 space-y-6">
      <AdminNav />
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Admin · Operators
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            CTX supplier operators — volume, success rate, fulfilment latency (last 24h). Click an
            operator for the full drill (ADR 013 / 022).
          </p>
        </div>
        {/* Tier-3 CSV of the joined snapshot for CTX quarterly
            reviews — hand the relationship owner one sheet. */}
        <CsvDownloadButton
          path="/api/admin/operators-snapshot.csv"
          filename={`operators-snapshot-${new Date().toISOString().slice(0, 10)}.csv`}
          label="Snapshot CSV"
        />
      </header>

      <section>
        {isPending ? (
          <Spinner />
        ) : hasError ? (
          <p className="text-sm text-red-600 dark:text-red-400">Failed to load operators.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No operator activity in the last 24 hours.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  {[
                    'Operator',
                    'Orders',
                    'Fulfilled',
                    'Failed',
                    'Success',
                    'p50',
                    'p95',
                    'Last order',
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
                {rows.map((r) => (
                  <tr key={r.operatorId}>
                    <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                      <Link
                        to={`/admin/operators/${encodeURIComponent(r.operatorId)}`}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                        aria-label={`Open operator detail for ${r.operatorId}`}
                      >
                        {r.operatorId}
                      </Link>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                      {r.orderCount.toLocaleString(ADMIN_LOCALE)}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-green-700 dark:text-green-400">
                      {r.fulfilledCount.toLocaleString(ADMIN_LOCALE)}
                    </td>
                    <td
                      className={`px-3 py-2 tabular-nums ${
                        r.failedCount > 0
                          ? 'text-red-700 dark:text-red-400 font-medium'
                          : 'text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {r.failedCount > 0 ? (
                        <Link
                          to={`/admin/orders?state=failed&ctxOperatorId=${encodeURIComponent(r.operatorId)}`}
                          className="hover:underline"
                          aria-label={`Review ${r.failedCount} failed orders on ${r.operatorId}`}
                        >
                          {r.failedCount.toLocaleString(ADMIN_LOCALE)}
                        </Link>
                      ) : (
                        r.failedCount.toLocaleString(ADMIN_LOCALE)
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                      {successRatePct({
                        operatorId: r.operatorId,
                        orderCount: r.orderCount,
                        fulfilledCount: r.fulfilledCount,
                        failedCount: r.failedCount,
                        lastOrderAt: r.lastOrderAt,
                      })}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                      {fmtMs(r.p50Ms)}
                    </td>
                    <td
                      className={`px-3 py-2 tabular-nums ${
                        r.p95Ms !== null && r.p95Ms > 30_000
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-gray-700 dark:text-gray-300'
                      }`}
                    >
                      {fmtMs(r.p95Ms)}
                    </td>
                    <td
                      className="px-3 py-2 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400"
                      title={r.lastOrderAt}
                    >
                      {fmtRelative(r.lastOrderAt)}
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
