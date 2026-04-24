import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ApiException, LOOP_ASSET_CODES, type LoopAssetCode } from '@loop/shared';
import type { Route } from './+types/admin._index';
import { shouldRetry } from '~/hooks/query-retry';
import { getTreasurySnapshot, type TreasurySnapshot } from '~/services/admin';
import {
  AdminNav,
  failedPayoutsCount,
  operatorPoolStatus,
} from '~/components/features/admin/AdminNav';
import { RequireAdmin } from '~/components/features/admin/RequireAdmin';
import { AdminAuditTail } from '~/components/features/admin/AdminAuditTail';
import { ConfigsHistoryCard } from '~/components/features/admin/ConfigsHistoryCard';
import { CashbackSparkline } from '~/components/features/admin/CashbackSparkline';
import { PayoutsSparkline } from '~/components/features/admin/PayoutsSparkline';
import { FleetFlywheelHeadline } from '~/components/features/admin/FleetFlywheelHeadline';
import { OrdersSparkline } from '~/components/features/admin/OrdersSparkline';
import { RealizationSparkline } from '~/components/features/admin/RealizationSparkline';
import { StuckOrdersCard } from '~/components/features/admin/StuckOrdersCard';
import { StuckPayoutsCard } from '~/components/features/admin/StuckPayoutsCard';
import { AssetDriftBadge } from '~/components/features/admin/AssetDriftBadge';
import { AssetDriftWatcherCard } from '~/components/features/admin/AssetDriftWatcherCard';
import { SettlementLagCard } from '~/components/features/admin/SettlementLagCard';
import { CashbackRealizationCard } from '~/components/features/admin/CashbackRealizationCard';
import { Spinner } from '~/components/ui/Spinner';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin — Loop' }];
}

interface CardLink {
  href: string;
  title: string;
  description: string;
}

// A2-1520: local fmtMinor replaced with bigint-safe shared helper.
import { formatMinorCurrency as fmtMinor } from '@loop/shared';

function LiabilityCard({
  code,
  outstandingMinor,
  issuer,
}: {
  code: LoopAssetCode;
  outstandingMinor: string;
  issuer: string | null;
}): React.JSX.Element {
  const fiat = code.slice(0, 3);
  return (
    <Link
      to={`/admin/assets/${encodeURIComponent(code)}`}
      aria-label={`Open ${code} asset detail`}
      className="rounded-xl border border-gray-200 bg-white p-4 hover:border-gray-400 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-600"
    >
      <div className="flex items-baseline justify-between">
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 font-mono">{code}</div>
        {issuer === null ? (
          <span className="text-[10px] uppercase tracking-wide font-semibold text-amber-700 dark:text-amber-400">
            not configured
          </span>
        ) : null}
      </div>
      <div className="mt-1 text-lg font-semibold text-gray-900 dark:text-white tabular-nums">
        {fmtMinor(outstandingMinor, fiat)}
      </div>
      {/* Drift badge (#712/#713). Third surface sharing the
          ['admin-asset-circulation', code] cache line — treasury
          cards, fleet-index column, and here. Self-hides while
          loading / on non-503 error / when issuer isn't set. */}
      {issuer !== null ? (
        <div className="mt-2">
          <AssetDriftBadge assetCode={code} />
        </div>
      ) : null}
    </Link>
  );
}

const CARDS: ReadonlyArray<CardLink> = [
  {
    href: '/admin/treasury',
    title: 'Treasury',
    description:
      'Outstanding credit, LOOP liabilities, operator pool health, payout counts, per-asset breakdown.',
  },
  {
    href: '/admin/payouts',
    title: 'Payouts',
    description: 'Stellar cashback backlog (ADR 015/016). Retry failed rows with Discord audit.',
  },
  {
    href: '/admin/orders',
    title: 'Orders',
    description: 'Loop-native orders drill-down with state + cashback split (ADR 011/015).',
  },
  {
    href: '/admin/cashback',
    title: 'Cashback',
    description: 'Per-merchant wholesale / cashback / margin config + audit trail (ADR 011).',
  },
  {
    href: '/admin/users',
    title: 'Users',
    description: 'Paginated user directory with email search + credit drill-down (ADR 009/017).',
  },
  {
    href: '/admin/merchants',
    title: 'Merchants',
    description:
      'Searchable catalog index with cashback-config state per merchant. Exports the catalog as CSV for BD / finance.',
  },
  {
    href: '/admin/operators',
    title: 'Operators',
    description:
      'CTX supplier operator pool — volume, success rate, p50/p95 fulfilment latency per operator (ADR 013/022).',
  },
  {
    href: '/admin/assets',
    title: 'Assets',
    description:
      'LOOP stablecoins (USDLOOP / GBPLOOP / EURLOOP) — outstanding liability, issuer, in-flight payout state (ADR 015/022).',
  },
  {
    href: '/admin/stuck-orders',
    title: 'Stuck orders',
    description:
      'SLO-triage list for orders sitting past threshold in paid / procuring (ADR 011/013).',
  },
  {
    href: '/admin/audit',
    title: 'Audit',
    description:
      'Admin write-audit trail (ADR 017/018) — every POST/PUT/DELETE with actor email and result.',
  },
];

/**
 * `/admin` landing — the tabs in AdminNav deep-link into subpages;
 * this index is the first thing an op sees when they navigate to the
 * admin root. Renders high-signal "is anything on fire right now?"
 * cards from the treasury snapshot (operator-pool state, failed
 * payouts count) followed by navigation cards into every subpage.
 *
 * Auth gate deliberately matches the subpages: show a sign-in CTA
 * when logged out; the 401/403 from the treasury fetch is how we
 * tell the caller isn't an admin.
 */
// A2-1101: the whole admin shell gates on `RequireAdmin`, which resolves
// /api/users/me.isAdmin before rendering children. Non-admins see the
// deny banner without any of the admin-specific data fetches firing.
export default function AdminIndexRoute(): React.JSX.Element {
  return (
    <RequireAdmin>
      <AdminIndexRouteInner />
    </RequireAdmin>
  );
}

function AdminIndexRouteInner(): React.JSX.Element {
  const snapshotQuery = useQuery<TreasurySnapshot, Error>({
    queryKey: ['admin-treasury'],
    queryFn: getTreasurySnapshot,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  const denied =
    snapshotQuery.error instanceof ApiException &&
    (snapshotQuery.error.status === 401 || snapshotQuery.error.status === 404);
  const status = operatorPoolStatus(snapshotQuery.data?.operatorPool);
  const failed = failedPayoutsCount(snapshotQuery.data?.payouts);

  return (
    <main className="max-w-5xl mx-auto px-6 py-12 space-y-8">
      <AdminNav />
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Admin</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Cashback operations hub. Use the tabs above or the cards below to drill into each surface.
        </p>
      </header>

      {denied ? (
        <section
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
        >
          Admin access required. The signed-in account is not marked as admin.
        </section>
      ) : snapshotQuery.isPending ? (
        <section className="rounded-xl border border-gray-200 bg-white px-4 py-6 dark:border-gray-800 dark:bg-gray-900 flex justify-center">
          <Spinner />
        </section>
      ) : snapshotQuery.isError ? (
        <section className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          Failed to load the treasury snapshot.
        </section>
      ) : (
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Link
            to="/admin/treasury"
            className="rounded-xl border border-gray-200 bg-white p-4 hover:border-gray-400 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-600"
          >
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Supplier</div>
            <div className="mt-1 text-base font-semibold text-gray-900 dark:text-white capitalize">
              CTX {status}
            </div>
          </Link>
          <Link
            to="/admin/payouts?state=failed"
            className={`rounded-xl border p-4 ${
              failed > 0
                ? 'border-red-200 bg-red-50 hover:border-red-400 dark:border-red-900/60 dark:bg-red-900/20 dark:hover:border-red-700'
                : 'border-gray-200 bg-white hover:border-gray-400 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-600'
            }`}
          >
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400">
              Failed payouts
            </div>
            <div
              className={`mt-1 text-base font-semibold ${
                failed > 0 ? 'text-red-700 dark:text-red-300' : 'text-gray-900 dark:text-white'
              } tabular-nums`}
            >
              {failed}
            </div>
          </Link>
          <StuckOrdersCard />
          <StuckPayoutsCard />
        </section>
      )}

      {/* Three stablecoin-operator dashboard cards (ADR 009/015/016).
          Drift = ledger health ("is our on-chain mint matched to what
          we owe?"); settlement-lag = SLA health ("is cashback hitting
          users fast enough?"); realization = flywheel health ("are
          users spending cashback back on Loop?"). Each self-hides
          independently so a fresh deployment sees only the signals
          it has data for. */}
      {denied ? null : (
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <AssetDriftWatcherCard />
          <SettlementLagCard />
          <CashbackRealizationCard />
        </section>
      )}

      {/* LOOP-asset outstanding-liability strip. Three cards,
          one per issued stablecoin — click drills into
          /admin/assets/:code. Placed above the flywheel
          headline so the first thing an op sees on /admin is
          "what does Loop owe users right now, per stablecoin".
          Hidden while the treasury snapshot is loading / errored
          / denied so the layout doesn't flash stubs. */}
      {denied || snapshotQuery.data === undefined ? null : (
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {LOOP_ASSET_CODES.map((code) => {
            const row = snapshotQuery.data.liabilities?.[code] ?? {
              outstandingMinor: '0',
              issuer: null,
            };
            return (
              <LiabilityCard
                key={code}
                code={code}
                outstandingMinor={row.outstandingMinor}
                issuer={row.issuer}
              />
            );
          })}
        </section>
      )}

      {/* Fleet-wide flywheel headline — "X% of recent fulfilled
          orders used recycled cashback". Mounted above the
          sparklines so the first thing an operator sees on /admin
          is the ADR-015 pivot indicator. Self-hides on error /
          loading / fleet-empty; renders a muted "not yet" banner
          when loop_asset share is zero so ops can distinguish "0"
          from "component crashed". */}
      {denied ? null : <FleetFlywheelHeadline />}

      {denied ? null : <CashbackSparkline />}

      {/* Settlement-side sparkline (#637). Pairs with cashback
          above: cashback = liability-creation per day, payouts =
          liability-settlement per day. Same 30-day window, same
          sparkline primitive — so the two read naturally side-by-
          side as in/out flows of the on-chain LOOP ledger. */}
      {denied ? null : <PayoutsSparkline />}

      {denied ? null : <OrdersSparkline />}

      {/* Fleet realization-rate trend (#731). Companion to the
          single-point realization card above: point = "are we
          recycling now?", trend = "is that direction holding?".
          Ops catches flywheel regressions before they cross the
          threshold on the point card. */}
      {denied ? null : <RealizationSparkline />}

      {denied ? null : <AdminAuditTail />}

      {denied ? null : <ConfigsHistoryCard />}

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {CARDS.map((card) => (
          <Link
            key={card.href}
            to={card.href}
            className="rounded-xl border border-gray-200 bg-white p-5 hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-600"
          >
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">{card.title}</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{card.description}</p>
          </Link>
        ))}
      </section>
    </main>
  );
}
