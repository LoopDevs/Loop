import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { LOOP_ASSET_CODES, PAYOUT_STATES } from '@loop/shared';
// F-WEBADMIN-01 (2026-06-30 cold audit): local fmtMinor replaced with
// bigint-safe shared helper — the one route file CF-23 (A2-1520) never
// migrated. This page renders the company-wide solvency figure, the
// single most monetarily sensitive aggregate in the admin panel.
import { formatMinorCurrency as fmtMinor } from '@loop/shared';
import type { Route } from './+types/admin.treasury';
import { getTreasurySnapshot, type TreasurySnapshot } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { useStaffRole } from '~/hooks/use-staff-role';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { RequireStaff } from '~/components/features/admin/RequireAdmin';
import { CsvDownloadButton } from '~/components/features/admin/CsvDownloadButton';
import { AssetDriftBadge } from '~/components/features/admin/AssetDriftBadge';
import { PayoutsByAssetTable } from '~/components/features/admin/PayoutsByAssetTable';
import { CtxCommissionCard } from '~/components/features/admin/CtxCommissionCard';
import { CreditFlowChart } from '~/components/features/admin/CreditFlowChart';
import { TopUsersByPendingPayoutCard } from '~/components/features/admin/TopUsersByPendingPayoutCard';
import { AdminMonthlyCashbackChart } from '~/components/features/admin/AdminMonthlyCashbackChart';
import { TreasuryReconciliationChart } from '~/components/features/admin/TreasuryReconciliationChart';
import { DiscordNotifiersCard } from '~/components/features/admin/DiscordNotifiersCard';
import { Spinner } from '~/components/ui/Spinner';
import { fmtStroops } from '~/utils/format-stellar';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Treasury — Loop' }];
}

// LOOP asset enumeration comes from `@loop/shared` so the treasury
// liability card renders the same set as the payout list / admin
// filter without drift.
const LOOP_LIABILITY_CODES = LOOP_ASSET_CODES;

/** Abbreviated Stellar pubkey for UI display — G...xyz. */
function truncPubkey(pk: string): string {
  if (pk.length <= 12) return pk;
  return `${pk.slice(0, 6)}…${pk.slice(-4)}`;
}

/**
 * Pill colour for a payout state count. Failed > 0 turns red
 * (page ops); submitted growing without matching confirmed is
 * yellow; confirmed is blue (informational); pending neutral.
 */
function payoutPillClass(state: string, count: string): string {
  if (state === 'failed' && count !== '0') {
    return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
  }
  if (state === 'submitted' && count !== '0') {
    return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
  }
  if (state === 'confirmed') {
    return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
  }
  return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
}

const KNOWN_TYPES = ['cashback', 'interest', 'refund', 'spend', 'withdrawal', 'adjustment'];

/**
 * `/admin/treasury` — admin-only snapshot of the credits ledger
 * + the CTX upstream state (ADR 009 / 011 / 051).
 *
 * Backend returns a read-optimised shape so the UI doesn't run its
 * own aggregation — see `src/admin/treasury.ts`.
 */
// A2-1101: see RequireAdmin.tsx for the shell-gate rationale.
export default function AdminTreasuryRoute(): React.JSX.Element {
  return (
    <RequireStaff minimum="support">
      <AdminTreasuryRouteInner />
    </RequireStaff>
  );
}

function AdminTreasuryRouteInner(): React.JSX.Element {
  // ADR 037: CSV mass exports + Discord-config are admin-only.
  const { isAdminRole } = useStaffRole();
  const query = useQuery({
    queryKey: ['admin-treasury'],
    queryFn: getTreasurySnapshot,
    retry: shouldRetry,
    // Treasury is read-mostly but changes as new orders / credits
    // land. 10s staleness is a balance between "fresh enough for an
    // operator looking at incidents" and "not hammering the ledger
    // aggregation for a tab left open in the background".
    staleTime: 10_000,
  });

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
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
          Admin · Treasury
        </h1>
        <p className="text-red-600 dark:text-red-400">
          Failed to load treasury snapshot. You may not be an admin.
        </p>
      </main>
    );
  }

  const snapshot: TreasurySnapshot = query.data;
  const currencies = Object.keys({
    ...snapshot.outstanding,
    ...snapshot.totals,
  }).sort();

  return (
    <main className="max-w-5xl mx-auto px-6 py-12 space-y-10">
      <AdminNav />
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Admin · Treasury</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Snapshot of the credits ledger and the CTX upstream.
        </p>
      </header>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          Outstanding credit
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          What Loop owes users right now — sum of live user balances.
        </p>
        {currencies.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No credit ledger activity yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {currencies.map((c) => (
              <div
                key={c}
                className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900"
              >
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{c}</div>
                <div className="mt-1 text-xl font-semibold text-gray-900 dark:text-white tabular-nums">
                  {fmtMinor(snapshot.outstanding[c] ?? '0', c)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          Ledger movements (all-time)
        </h2>
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <th className="px-3 py-2 text-start font-medium text-gray-500 dark:text-gray-400">
                  Currency
                </th>
                {KNOWN_TYPES.map((t) => (
                  <th
                    key={t}
                    className="px-3 py-2 text-end font-medium text-gray-500 dark:text-gray-400 capitalize"
                  >
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-900 bg-white dark:bg-gray-900">
              {currencies.length === 0 ? (
                <tr>
                  <td
                    colSpan={KNOWN_TYPES.length + 1}
                    className="px-3 py-6 text-center text-gray-500 dark:text-gray-400"
                  >
                    No ledger movements yet.
                  </td>
                </tr>
              ) : (
                currencies.map((c) => {
                  const bucket = snapshot.totals[c] ?? {};
                  return (
                    <tr key={c}>
                      <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">{c}</td>
                      {KNOWN_TYPES.map((t) => (
                        <td
                          key={t}
                          className="px-3 py-2 text-end tabular-nums text-gray-700 dark:text-gray-300"
                        >
                          {bucket[t] !== undefined ? fmtMinor(bucket[t], c) : '—'}
                        </td>
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-6">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            30-day credit flow
          </p>
          <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
            Per-day credited vs. debited from the ledger, one currency at a time (ADR 009/015).
            &ldquo;Are we generating liability faster than we settle it?&rdquo; — sustained
            positive-net days mean cashback issuance is outpacing user settlement and treasury needs
            to plan Stellar-side funding ahead of the curve.
          </p>
          <CreditFlowChart />
        </div>
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Supplier flow (fulfilled)
          </h2>
          <Link
            to="/admin/orders?state=fulfilled"
            className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            See orders →
          </Link>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Fulfilled-order flow through CTX (ADR 052): face value sold, the cashback CTX applied as a
          checkout discount, and the commission Loop expects CTX to accrue. Keyed by the currency
          the user was charged in.
        </p>
        {Object.keys(snapshot.orderFlows).length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No fulfilled orders yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th className="px-3 py-2 text-start font-medium text-gray-500 dark:text-gray-400">
                    Currency
                  </th>
                  <th className="px-3 py-2 text-end font-medium text-gray-500 dark:text-gray-400">
                    Orders
                  </th>
                  <th className="px-3 py-2 text-end font-medium text-gray-500 dark:text-gray-400">
                    Face value
                  </th>
                  <th className="px-3 py-2 text-end font-medium text-gray-500 dark:text-gray-400">
                    User cashback
                  </th>
                  <th className="px-3 py-2 text-end font-medium text-gray-500 dark:text-gray-400">
                    Expected commission
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-900 bg-white dark:bg-gray-900">
                {Object.entries(snapshot.orderFlows)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([currency, flow]) => (
                    <tr key={currency}>
                      <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                        {currency}
                      </td>
                      <td className="px-3 py-2 text-end tabular-nums text-gray-700 dark:text-gray-300">
                        {flow.count}
                      </td>
                      <td className="px-3 py-2 text-end tabular-nums text-gray-700 dark:text-gray-300">
                        {fmtMinor(flow.faceValueMinor, currency)}
                      </td>
                      <td className="px-3 py-2 text-end tabular-nums text-gray-700 dark:text-gray-300">
                        {fmtMinor(flow.userCashbackMinor, currency)}
                      </td>
                      <td className="px-3 py-2 text-end tabular-nums text-gray-700 dark:text-gray-300">
                        {fmtMinor(flow.expectedCommissionMinor, currency)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          LOOP-asset liabilities
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Outstanding user claims on Loop&rsquo;s fiat reserves, by issued stablecoin.
          &ldquo;Issuer&rdquo; is the Stellar account that mints this asset — a missing issuer means
          the operator hasn&rsquo;t wired the env var for that LOOP asset yet, so on-chain cashback
          is off for that currency.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {LOOP_LIABILITY_CODES.map((code) => {
            const row = snapshot.liabilities?.[code] ?? { outstandingMinor: '0', issuer: null };
            const fiat = code.slice(0, 3); // USDLOOP → USD
            return (
              <Link
                key={code}
                to={`/admin/assets/${encodeURIComponent(code)}`}
                aria-label={`Open ${code} asset detail`}
                className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900 hover:border-gray-400 dark:hover:border-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <div className="flex items-baseline justify-between">
                  <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{code}</div>
                  {row.issuer === null ? (
                    <span className="text-[10px] uppercase tracking-wide font-semibold text-amber-700 dark:text-amber-400">
                      not configured
                    </span>
                  ) : (
                    <span className="text-[10px] font-mono text-gray-500 dark:text-gray-400">
                      {truncPubkey(row.issuer)}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xl font-semibold text-gray-900 dark:text-white tabular-nums">
                  {fmtMinor(row.outstandingMinor, fiat)}
                </div>
                {/* Circulation drift badge (#709/#710). Self-hides
                    when the issuer is not configured (Horizon has
                    nothing to read) or the query is still pending.
                    Shares the ['admin-asset-circulation', code]
                    cache key with the full AssetCirculationCard on
                    /admin/assets/:code. */}
                {row.issuer !== null ? (
                  <div className="mt-2">
                    <AssetDriftBadge assetCode={code} />
                  </div>
                ) : null}
              </Link>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          Loop-held assets
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          The yield-earning pile (ADR 015). USDC is what Loop wants to hold for defindex yield; XLM
          funds base reserves + is the procurement break-glass.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900">
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400">USDC</div>
            <div className="mt-1 text-xl font-semibold text-gray-900 dark:text-white tabular-nums">
              {fmtStroops(snapshot.assets?.USDC?.stroops ?? null, 'USDC')}
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900">
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400">XLM</div>
            <div className="mt-1 text-xl font-semibold text-gray-900 dark:text-white tabular-nums">
              {fmtStroops(snapshot.assets?.XLM?.stroops ?? null, 'XLM')}
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Stellar payouts</h2>
          <Link
            to="/admin/payouts"
            className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            See all →
          </Link>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Outbound LOOP-asset cashback (ADR 015/016). Non-zero{' '}
          <code className="text-xs">failed</code> means ops intervention needed — click through to
          review each row and retry, or investigate the classification.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {PAYOUT_STATES.map((state) => {
            const count = snapshot.payouts?.[state] ?? '0';
            return (
              <Link
                key={state}
                to={`/admin/payouts?state=${state}`}
                className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900 hover:border-gray-400 dark:hover:border-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <div className="flex items-center justify-between">
                  <div className="text-xs font-medium text-gray-500 dark:text-gray-400 capitalize">
                    {state}
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${payoutPillClass(state, count)}`}
                  >
                    {count}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Payouts by asset</h2>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Per-asset × per-state breakdown of <code className="text-xs">pending_payouts</code> (ADR
          015/016). The flat counts above answer <em>how many</em>; this table answers{' '}
          <em>which LOOP asset</em> is affected — a failed-row click drills to the payout list
          filtered to that state.
        </p>
        <PayoutsByAssetTable />
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Top users by in-flight payout
          </h2>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Funding prioritisation leaderboard — users owed the most on-chain payout right now,
          grouped by (user, asset) so a USDLOOP top-up decision stays independent of the GBPLOOP
          picture. Email opens the user detail; the payout count drills to that asset's in-flight
          list (ADR 015/016).
        </p>
        <TopUsersByPendingPayoutCard />
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Monthly cashback emissions (last 12 months)
          </h2>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Per-currency cashback Loop has credited to users per calendar month (ADR 009/015). The
          complement to the payment-method mix above: that one asks "how are users paying us?", this
          one asks "how much are we paying back?". A rising bar is a prerequisite for the flywheel —
          if we're not emitting cashback, users have nothing to recycle into the LOOP-asset rail.
        </p>
        <AdminMonthlyCashbackChart />
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Liability reconciliation (last 12 months)
          </h2>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Cashback minted vs. on-chain payouts settled per month (ADR 015/016). Minted is the
          liability we create when we credit a user; settled is the liability we extinguish when a
          LOOP-asset payout confirms on Stellar. The{' '}
          <span className="text-orange-700 dark:text-orange-300">net column</span> is the change in
          outstanding liability that month — positive means Loop&rsquo;s obligations grew, negative
          means they shrank.
        </p>
        <TreasuryReconciliationChart />
      </section>

      {/* Finance-exports row (#640). Daily granularity CSVs for
          both sides of the reconciliation above, for month-end
          close. Cashback side was Tier-3 CSV since #615; payouts
          side shipped in #639. Placed directly under the
          reconciliation chart so finance pulls both files in one
          visit — less context-switching than finding two separate
          CSV buttons scattered across the page. */}
      {/* ADR 037 §3: the finance-exports row is all Tier-3 bulk
          CSV — admin-only, hidden for support. */}
      {isAdminRole ? (
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Finance exports</h2>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            Daily-granularity CSVs for both sides of the reconciliation above (ADR 018 Tier-3).
            Finance runs these at month-end to tie the ledger to the on-chain Stellar record.
            Default window is the last 31 days; append <code>?days=366</code> for a full-year pull.
          </p>
          <div className="flex flex-wrap gap-3">
            <CsvDownloadButton
              path="/api/admin/cashback-activity.csv"
              filename={`cashback-activity-${new Date().toISOString().slice(0, 10)}.csv`}
              label="Cashback activity CSV"
            />
            <CsvDownloadButton
              path="/api/admin/payouts-activity.csv"
              filename={`payouts-activity-${new Date().toISOString().slice(0, 10)}.csv`}
              label="Payouts activity CSV"
            />
            <CsvDownloadButton
              path="/api/admin/treasury/credit-flow.csv"
              filename={`treasury-credit-flow-${new Date().toISOString().slice(0, 10)}.csv`}
              label="Credit-flow CSV"
            />
            <CsvDownloadButton
              path="/api/admin/treasury.csv"
              filename={`treasury-snapshot-${new Date().toISOString().slice(0, 10)}.csv`}
              label="Treasury snapshot CSV"
            />
          </div>
        </section>
      ) : null}

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">CTX commission</h2>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          CTX&apos;s record of the operator commission it owes Loop for attributed orders
          (ctx-interop) — the primary money surface now that ctx is the payment processor (ADR 052).
          Reconcile against the expected-commission column in the supplier flow above; the two
          drifting apart is the cross-company reconciliation alarm.
        </p>
        <CtxCommissionCard />
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">CTX upstream</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Loop&rsquo;s operator API key into CTX (ADR 051) and the upstream circuit breaker in front
          of every CTX call.
        </p>
        {!snapshot.ctxApi.configured ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Credentials unconfigured (<code>GIFT_CARD_API_KEY</code> not set).
          </p>
        ) : (
          <div className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3 text-sm">
            <span className="font-medium text-gray-900 dark:text-white">Circuit state</span>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                snapshot.ctxApi.state === 'closed'
                  ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                  : snapshot.ctxApi.state === 'half_open'
                    ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
                    : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
              }`}
            >
              {snapshot.ctxApi.state}
            </span>
          </div>
        )}
      </section>

      {/* ADR 037 §3: Discord-config is admin-only. */}
      {isAdminRole ? (
        <section>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
            Discord notifiers
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            Catalog of signals this backend emits to Discord (ADR 018). Sourced from the{' '}
            <code className="text-xs">DISCORD_NOTIFIERS</code> const — a catalog-invariant test
            makes sure a new <code className="text-xs">notify*</code> function can&rsquo;t land
            without its description, so this list is always in lockstep with the code.
          </p>
          <DiscordNotifiersCard />
        </section>
      ) : null}
    </main>
  );
}
