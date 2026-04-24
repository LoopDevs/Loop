import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { foldForSearch } from '@loop/shared';
import type { Route } from './+types/admin.merchants';
import { useAllMerchants } from '~/hooks/use-merchants';
import { shouldRetry } from '~/hooks/query-retry';
import { listCashbackConfigs, type MerchantCashbackConfig } from '~/services/admin';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { RequireAdmin } from '~/components/features/admin/RequireAdmin';
import { CsvDownloadButton } from '~/components/features/admin/CsvDownloadButton';
import { Spinner } from '~/components/ui/Spinner';
import { ADMIN_LOCALE } from '~/utils/locale';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Merchants — Loop' }];
}

/**
 * `/admin/merchants` — searchable index of every merchant in the
 * catalog joined against the admin cashback-config state (#652).
 *
 * Before this page, the only ways to get to a specific merchant
 * drill were: the flywheel-share leaderboard on /admin/cashback,
 * a drill Link from /admin/orders?merchantId=<slug>, or the
 * cashback-config table on /admin/cashback. This page gives ops
 * a dedicated top-level entry point with name-search, so the
 * drill-down is reachable for any merchant in the catalog — not
 * just the ones that have orders or a config.
 *
 * Pure composition over existing endpoints — no new backend
 * work. `useAllMerchants()` (catalog, already cached client-side
 * for the homepage) + `listCashbackConfigs()` (admin, already
 * cached for /admin/cashback) rendered side-by-side in one
 * table. Click a row → /admin/merchants/:merchantId drill.
 *
 * Shows cashback-config state inline so an operator can scan for
 * "which merchants have configs" and "which merchants are active"
 * without a second click. ADR 011 active=false state is
 * highlighted so it can't be confused with "no config yet".
 */
// A2-1101: see RequireAdmin.tsx for the shell-gate rationale.
export default function AdminMerchantsRoute(): React.JSX.Element {
  return (
    <RequireAdmin>
      <AdminMerchantsRouteInner />
    </RequireAdmin>
  );
}

function AdminMerchantsRouteInner(): React.JSX.Element {
  const { merchants, isLoading: merchantsLoading } = useAllMerchants();
  const configsQuery = useQuery({
    queryKey: ['admin-cashback-configs'],
    queryFn: listCashbackConfigs,
    retry: shouldRetry,
    // Matches the /admin/merchants/:id drill — so navigating
    // between the two reuses the cache rather than re-fetching.
    staleTime: 60_000,
  });

  const [q, setQ] = useState('');
  const folded = foldForSearch(q.trim());

  const configsById = useMemo(() => {
    const map = new Map<string, MerchantCashbackConfig>();
    if (configsQuery.data === undefined) return map;
    for (const c of configsQuery.data.configs) {
      map.set(c.merchantId, c);
    }
    return map;
  }, [configsQuery.data]);

  const filtered = useMemo(() => {
    if (folded.length === 0) return merchants;
    return merchants.filter((m) => foldForSearch(m.name).includes(folded));
  }, [merchants, folded]);

  return (
    <main className="max-w-4xl mx-auto px-6 py-12 space-y-6">
      <AdminNav />
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Admin · Merchants</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Every merchant in the catalog. Filter by name, click through for the drill-down (flywheel,
          cashback, rail mix, orders).
        </p>
      </header>

      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="search"
          placeholder="Search by name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Filter merchants"
          className="flex-1 min-w-[16rem] rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
        />
        <CsvDownloadButton
          path="/api/admin/merchants-catalog.csv"
          filename={`merchants-catalog-${new Date().toISOString().slice(0, 10)}.csv`}
          label="Catalog CSV"
        />
      </div>

      {merchantsLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-6 text-sm text-gray-500 dark:text-gray-400">
          No merchants match &ldquo;{q}&rdquo;.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                {['Merchant', 'Id', 'Cashback config', 'Catalog'].map((h) => (
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
              {filtered.map((m) => {
                const config = configsById.get(m.id);
                return (
                  <tr key={m.id}>
                    <td className="px-3 py-2">
                      <Link
                        to={`/admin/merchants/${encodeURIComponent(m.id)}`}
                        className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {m.name}
                      </Link>
                    </td>
                    <td
                      className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400"
                      title={m.id}
                    >
                      {m.id}
                    </td>
                    <td className="px-3 py-2">
                      <ConfigPill config={config} loading={configsQuery.isPending} />
                    </td>
                    <td className="px-3 py-2">
                      {m.enabled === false ? (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-300">
                          disabled
                        </span>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                          live
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-500 dark:text-gray-400">
        Showing {filtered.length.toLocaleString(ADMIN_LOCALE)} of{' '}
        {merchants.length.toLocaleString(ADMIN_LOCALE)} merchants.
      </p>
    </main>
  );
}

function ConfigPill({
  config,
  loading,
}: {
  config: MerchantCashbackConfig | undefined;
  loading: boolean;
}): React.JSX.Element {
  if (loading) {
    return <span className="text-xs text-gray-400">loading…</span>;
  }
  if (config === undefined) {
    return (
      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
        no config
      </span>
    );
  }
  if (!config.active) {
    return (
      <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300">
        inactive · {config.userCashbackPct}%
      </span>
    );
  }
  return (
    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-300">
      {config.userCashbackPct}% active
    </span>
  );
}
