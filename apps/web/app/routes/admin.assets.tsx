import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { LOOP_ASSET_CODES, type LoopAssetCode } from '@loop/shared';
import type { Route } from './+types/admin.assets';
import { shouldRetry } from '~/hooks/query-retry';
import {
  getTreasurySnapshot,
  getPayoutsByAsset,
  type LoopLiability,
  type PayoutsByAssetRow,
} from '~/services/admin';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { RequireAdmin } from '~/components/features/admin/RequireAdmin';
import { AssetDriftBadge } from '~/components/features/admin/AssetDriftBadge';
import { Spinner } from '~/components/ui/Spinner';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Assets — Loop' }];
}

function fiatOf(code: LoopAssetCode): string {
  return code.slice(0, 3);
}

function fmtMinor(minor: string, fiat: string): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: fiat }).format(n / 100);
  } catch {
    return `${(n / 100).toFixed(2)} ${fiat}`;
  }
}

function truncPubkey(pk: string): string {
  if (pk.length <= 12) return pk;
  return `${pk.slice(0, 6)}…${pk.slice(-4)}`;
}

interface AssetSummary {
  code: LoopAssetCode;
  fiat: string;
  outstandingMinor: string;
  issuer: string | null;
  pending: number;
  submitted: number;
  confirmed: number;
  failed: number;
}

export function buildAssetSummaries(
  liabilities: Record<LoopAssetCode, LoopLiability> | undefined,
  byAssetRows: PayoutsByAssetRow[] | undefined,
): AssetSummary[] {
  const byCode = new Map<string, PayoutsByAssetRow>();
  for (const r of byAssetRows ?? []) byCode.set(r.assetCode, r);
  return LOOP_ASSET_CODES.map((code) => {
    const liability = liabilities?.[code] ?? { outstandingMinor: '0', issuer: null };
    const row = byCode.get(code);
    return {
      code,
      fiat: fiatOf(code),
      outstandingMinor: liability.outstandingMinor,
      issuer: liability.issuer,
      pending: row?.pending.count ?? 0,
      submitted: row?.submitted.count ?? 0,
      confirmed: row?.confirmed.count ?? 0,
      failed: row?.failed.count ?? 0,
    };
  });
}

/**
 * `/admin/assets` — fleet index of LOOP stablecoins (ADR 015 / 022).
 * Sibling of `/admin/operators`: that one is the CTX-supplier fleet
 * view, this is the liability-side fleet view.
 *
 * One row per configured LOOP asset (USDLOOP / GBPLOOP / EURLOOP)
 * with outstanding fiat liability, issuer pubkey, and in-flight
 * payout-state counts. Row drills into `/admin/assets/:assetCode`
 * for the full per-asset picture.
 *
 * Shares TanStack keys with `/admin/treasury` (`['admin-treasury']`)
 * and the asset drill page (`['admin-payouts-by-asset']`), so
 * navigating between them deduplicates fetches.
 */
// A2-1101: see RequireAdmin.tsx for the shell-gate rationale.
export default function AdminAssetsIndexRoute(): React.JSX.Element {
  return (
    <RequireAdmin>
      <AdminAssetsIndexRouteInner />
    </RequireAdmin>
  );
}

function AdminAssetsIndexRouteInner(): React.JSX.Element {
  const snapshotQuery = useQuery({
    queryKey: ['admin-treasury'],
    queryFn: getTreasurySnapshot,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  const byAssetQuery = useQuery({
    queryKey: ['admin-payouts-by-asset'],
    queryFn: getPayoutsByAsset,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  const summaries = useMemo(
    () => buildAssetSummaries(snapshotQuery.data?.liabilities, byAssetQuery.data?.rows),
    [snapshotQuery.data, byAssetQuery.data],
  );

  const isPending = snapshotQuery.isPending || byAssetQuery.isPending;
  const hasError = snapshotQuery.isError || byAssetQuery.isError;

  return (
    <main className="max-w-5xl mx-auto px-6 py-12 space-y-6">
      <AdminNav />
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Admin · Assets</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          LOOP stablecoins pinned 1:1 to fiat (ADR 015). Click a row to drill into outstanding
          liability, issuer state, top holders, and settlement activity.
        </p>
      </header>

      <section>
        {isPending ? (
          <Spinner />
        ) : hasError ? (
          <p className="text-sm text-red-600 dark:text-red-400">Failed to load assets.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  {[
                    'Asset',
                    'Outstanding',
                    'Drift',
                    'Issuer',
                    'Pending',
                    'Submitted',
                    'Confirmed',
                    'Failed',
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
                {summaries.map((s) => (
                  <tr key={s.code}>
                    <td className="px-3 py-2 font-medium text-gray-900 dark:text-white font-mono">
                      <Link
                        to={`/admin/assets/${encodeURIComponent(s.code)}`}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                        aria-label={`Open ${s.code} asset detail`}
                      >
                        {s.code}
                      </Link>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-gray-900 dark:text-white">
                      {fmtMinor(s.outstandingMinor, s.fiat)}
                    </td>
                    <td className="px-3 py-2">
                      {s.issuer === null ? (
                        <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                      ) : (
                        <AssetDriftBadge assetCode={s.code} />
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {s.issuer === null ? (
                        <span className="font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                          not configured
                        </span>
                      ) : (
                        <code className="font-mono text-gray-500 dark:text-gray-400">
                          {truncPubkey(s.issuer)}
                        </code>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                      {s.pending}
                    </td>
                    <td
                      className={`px-3 py-2 tabular-nums ${
                        s.submitted > 0
                          ? 'text-yellow-700 dark:text-yellow-400'
                          : 'text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {s.submitted}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-blue-700 dark:text-blue-400">
                      {s.confirmed}
                    </td>
                    <td
                      className={`px-3 py-2 tabular-nums ${
                        s.failed > 0
                          ? 'text-red-700 dark:text-red-400 font-medium'
                          : 'text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {s.failed > 0 ? (
                        <Link
                          to={`/admin/payouts?state=failed&assetCode=${encodeURIComponent(s.code)}`}
                          className="hover:underline"
                          aria-label={`Review ${s.failed} failed ${s.code} payouts`}
                        >
                          {s.failed}
                        </Link>
                      ) : (
                        s.failed
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
