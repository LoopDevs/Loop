/**
 * `/admin/merchants/:merchantId` — single-merchant drill-down.
 *
 * Permalink for a single merchant. Ops lands here from the
 * cashback-config table on `/admin/cashback`, the flywheel
 * leaderboard on the same page, or the drill-in Link on a row in
 * `/admin/orders?merchantId=<slug>`. Before this page existed, the
 * only way to see "current config + recent audit trail + recent
 * orders" for one merchant was to open three tabs.
 *
 * Composition over new endpoints: every data source on this page
 * already existed before this slice — we just co-locate them.
 *   - Merchant catalog (name + image)   → `useAllMerchants`
 *   - Current cashback config           → `listCashbackConfigs`
 *   - Config audit trail                → `cashbackConfigHistory`
 *   - Recent orders                     → `listAdminOrders({ merchantId })`
 *
 * The route deliberately doesn't compute per-merchant flywheel
 * share — that's already available on the leaderboard card on
 * `/admin/cashback` (#603) and would duplicate the same aggregate.
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/admin.merchants.$merchantId';
import { useAllMerchants } from '~/hooks/use-merchants';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';
import {
  cashbackConfigHistory,
  listAdminOrders,
  listCashbackConfigs,
  type AdminOrderView,
} from '~/services/admin';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { CopyButton } from '~/components/features/admin/CopyButton';
import { CsvDownloadButton } from '~/components/features/admin/CsvDownloadButton';
import { MerchantCashbackMonthlyChart } from '~/components/features/admin/MerchantCashbackMonthlyChart';
import { MerchantCashbackPaidCard } from '~/components/features/admin/MerchantCashbackPaidCard';
import { MerchantFlywheelActivityChart } from '~/components/features/admin/MerchantFlywheelActivityChart';
import { MerchantFlywheelChip } from '~/components/features/admin/MerchantFlywheelChip';
import { MerchantRailMixCard } from '~/components/features/admin/MerchantRailMixCard';
import { MerchantTopEarnersCard } from '~/components/features/admin/MerchantTopEarnersCard';
import { Spinner } from '~/components/ui/Spinner';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Merchant — Loop' }];
}

const RECENT_ORDERS_LIMIT = 10;

export default function AdminMerchantDetailRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const { merchantId = '' } = useParams<{ merchantId: string }>();
  const { isAuthenticated } = useAuth();
  const { merchants } = useAllMerchants();
  const merchant = merchants.find((m) => m.id === merchantId);

  const configsQuery = useQuery({
    queryKey: ['admin-cashback-configs'],
    queryFn: listCashbackConfigs,
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 60_000,
  });

  const historyQuery = useQuery({
    queryKey: ['admin-cashback-config-history', merchantId],
    queryFn: () => cashbackConfigHistory(merchantId),
    enabled: isAuthenticated && merchantId.length > 0,
    retry: shouldRetry,
    staleTime: 60_000,
  });

  const ordersQuery = useQuery({
    queryKey: ['admin-merchant-orders', merchantId],
    queryFn: () => listAdminOrders({ merchantId, limit: RECENT_ORDERS_LIMIT }),
    enabled: isAuthenticated && merchantId.length > 0,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  if (!isAuthenticated) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
          Admin · Merchant
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

  const config = configsQuery.data?.configs.find((c) => c.merchantId === merchantId);
  // A missing row is the common case — only ~20% of catalog
  // merchants have a cashback config yet. Don't treat it as "not
  // found"; the rest of the page still renders.
  const configDenied =
    configsQuery.error instanceof ApiException &&
    (configsQuery.error.status === 401 || configsQuery.error.status === 404);

  return (
    <main className="max-w-4xl mx-auto px-6 py-12 space-y-6">
      <AdminNav />
      <nav aria-label="Back to cashback admin">
        <Link
          to="/admin/cashback"
          className="text-sm text-gray-600 hover:underline dark:text-gray-400"
        >
          ← All merchants
        </Link>
      </nav>

      <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
              {merchant?.name ?? merchantId}
            </h1>
            <p className="mt-1 text-xs font-mono text-gray-500 dark:text-gray-400 inline-flex items-center gap-1">
              {merchantId}
              <CopyButton text={merchantId} label="Copy merchant id" />
            </p>
          </div>
          {merchant?.enabled === false ? (
            <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-300">
              disabled
            </span>
          ) : null}
        </header>
        {merchant === undefined ? (
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
            Merchant not in the current catalog — may have been evicted (ADR 021 Rule B). Historical
            orders still render below.
          </p>
        ) : null}
        {/* Flywheel chip — recycled-vs-total over the last 31 days,
            backed by /api/admin/merchants/:id/flywheel-stats (#623).
            Gives ops a one-glance answer to "how much of this
            merchant's volume is coming through the cashback rail?"
            without leaving the drill-down. */}
        <div className="mt-4">
          <MerchantFlywheelChip merchantId={merchantId} />
        </div>
        {/* Flywheel trajectory sparkline (#641). The scalar chip
            above says "12% over 31d"; this sparkline says "and
            here's how that 12% got there, day by day". Green
            recycled line diverging upward from the blue total
            line is the shape of pivot success at this merchant. */}
        <div className="mt-4">
          <MerchantFlywheelActivityChart merchantId={merchantId} />
        </div>
        {/* Tier-3 CSV export (#645). Day-by-day flywheel series
            pulled as a year-long spreadsheet for BD / commercial
            prep — the long-form companion to the scalar chip and
            the 30-day sparkline. Appends ?days=366 for a full-
            year pull in one go. */}
        <div className="mt-4">
          <CsvDownloadButton
            path={`/api/admin/merchants/${encodeURIComponent(merchantId)}/flywheel-activity.csv?days=366`}
            filename={`${merchantId}-flywheel-activity-${new Date().toISOString().slice(0, 10)}.csv`}
            label="Flywheel CSV (1y)"
          />
        </div>
      </section>

      {/* Current cashback config — small card. Shows the three
          pinned percentages or a "no config yet" copy if the row
          hasn't been written. */}
      <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">
            Current cashback split
          </h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Pinned at order-creation time. Editing on{' '}
            <Link
              to="/admin/cashback"
              className="underline decoration-gray-300 hover:decoration-gray-500"
            >
              /admin/cashback
            </Link>{' '}
            creates a new audit row — in-flight orders keep their earlier split.
          </p>
        </header>
        <div className="p-6">
          {configsQuery.isPending ? (
            <Spinner />
          ) : configDenied ? (
            <p className="text-sm text-red-600 dark:text-red-400">
              Admin access required to view config.
            </p>
          ) : config !== undefined ? (
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3 text-sm">
              <PctRow label="Wholesale" value={config.wholesalePct} />
              <PctRow label="User cashback" value={config.userCashbackPct} />
              <PctRow label="Loop margin" value={config.loopMarginPct} />
            </dl>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No cashback config for this merchant yet.
            </p>
          )}
        </div>
      </section>

      {/* Cashback paid out (#625). Per-currency lifetime
          user_cashback_minor on fulfilled orders. Sits between the
          current-config card (what the split *is*) and the audit
          trail (how the split got there) — those two answer
          "what's the rule?"; this one answers "what has the rule
          cost us so far?". */}
      <MerchantCashbackPaidCard merchantId={merchantId} />

      {/* Monthly cashback trend (#635). 12-month emission series
          scoped to this merchant — time-series companion to the
          scalar cashback-paid-out card above. Same visual
          primitives as the fleet + per-user charts. */}
      <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">
            Monthly cashback (last 12 months)
          </h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            User cashback minted on fulfilled orders at this merchant per month, per charge
            currency. Same pinned <code>user_cashback_minor</code> data as the card above, bucketed
            on fulfilment date — answers &ldquo;is cashback emission trending up at this
            merchant?&rdquo; rather than &ldquo;how much in total?&rdquo;.
          </p>
        </header>
        <div className="px-6 py-5">
          <MerchantCashbackMonthlyChart merchantId={merchantId} />
        </div>
      </section>

      {/* Rail mix (#627). Per-merchant payment-method share —
          how users are paying for fulfilled orders at this one
          merchant. A rising LOOP-asset share is the per-merchant
          version of the fleet flywheel signal. */}
      <MerchantRailMixCard merchantId={merchantId} />

      {/* Top earners (#655). Inverse axis of the user-drill's
          cashback-by-merchant table — ranks users by cashback
          earned at this one merchant. Drives BD outreach ("who
          spends a lot at Amazon?") and support triage ("who's
          the impact of this merchant's incident?"). */}
      <MerchantTopEarnersCard merchantId={merchantId} />

      {/* Config audit trail (ADR 011). Newest first, last 50 rows
          by backend default. Silent-hide on error — the current-
          config card above carries the primary signal. */}
      <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Config history</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Every cashback-config change for this merchant. Newest first.
          </p>
        </header>
        <div className="overflow-x-auto">
          {historyQuery.isPending ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : historyQuery.isError || historyQuery.data.history.length === 0 ? (
            <p className="px-6 py-6 text-sm text-gray-500 dark:text-gray-400">
              No config history yet for this merchant.
            </p>
          ) : (
            <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
              <thead>
                <tr>
                  {['Changed', 'Wholesale', 'User', 'Loop margin', 'By', 'Active'].map((h) => (
                    <th
                      key={h}
                      className="px-6 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-900">
                {historyQuery.data.history.map((h) => (
                  <tr key={h.id}>
                    <td className="px-6 py-2 text-xs text-gray-600 dark:text-gray-400 tabular-nums">
                      {new Date(h.changedAt).toLocaleString('en-US', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </td>
                    <td className="px-6 py-2 tabular-nums">{h.wholesalePct}%</td>
                    <td className="px-6 py-2 tabular-nums">{h.userCashbackPct}%</td>
                    <td className="px-6 py-2 tabular-nums">{h.loopMarginPct}%</td>
                    <td className="px-6 py-2 font-mono text-xs text-gray-600 dark:text-gray-400 truncate max-w-[10rem]">
                      {h.changedBy}
                    </td>
                    <td className="px-6 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          h.active
                            ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                        }`}
                      >
                        {h.active ? 'active' : 'inactive'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Recent orders for this merchant — 10 most-recent rows.
          Deep-link at the bottom for the full filtered list. */}
      <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-6 py-4 dark:border-gray-800">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Recent orders</h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Latest {RECENT_ORDERS_LIMIT} orders from this merchant. Click through for the full
              filtered list.
            </p>
          </div>
          <Link
            to={`/admin/orders?merchantId=${encodeURIComponent(merchantId)}`}
            className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            See all orders →
          </Link>
        </header>
        <div className="overflow-x-auto">
          {ordersQuery.isPending ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : ordersQuery.isError || ordersQuery.data.orders.length === 0 ? (
            <p className="px-6 py-6 text-sm text-gray-500 dark:text-gray-400">
              No orders from this merchant yet.
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-900">
              {ordersQuery.data.orders.map((o) => (
                <OrderRow key={o.id} order={o} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}

function PctRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </dt>
      <dd className="mt-1 text-xl font-semibold text-gray-900 dark:text-white tabular-nums">
        {value}%
      </dd>
    </div>
  );
}

function OrderRow({ order }: { order: AdminOrderView }): React.JSX.Element {
  const date = new Date(order.createdAt).toLocaleString('en-US', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  return (
    <li className="flex items-center justify-between gap-3 px-6 py-3 text-sm">
      <Link
        to={`/admin/orders/${order.id}`}
        className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
        title={order.id}
      >
        {order.id.slice(0, 8)}
      </Link>
      <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">{date}</span>
      <span
        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
          order.paymentMethod === 'loop_asset'
            ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
            : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
        }`}
      >
        {order.paymentMethod === 'loop_asset' ? '♻️ ' : ''}
        {order.paymentMethod}
      </span>
      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
        {order.state}
      </span>
    </li>
  );
}
