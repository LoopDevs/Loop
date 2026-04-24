import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { LOOP_ASSET_CODES, isLoopAssetCode, type LoopAssetCode } from '@loop/shared';
import type { Route } from './+types/admin.assets.$assetCode';
import { shouldRetry } from '~/hooks/query-retry';
import {
  getTreasurySnapshot,
  getPayoutsByAsset,
  getTopUsersByPendingPayout,
  getPayoutsActivity,
  type PayoutsByAssetRow,
  type TopUserByPendingPayoutEntry,
  type PayoutsActivityDay,
} from '~/services/admin';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { RequireAdmin } from '~/components/features/admin/RequireAdmin';
import { AssetCirculationCard } from '~/components/features/admin/AssetCirculationCard';
import { Spinner } from '~/components/ui/Spinner';
import { shortDay } from '~/components/features/admin/PaymentMethodActivityChart';
import { ADMIN_LOCALE } from '~/utils/locale';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Asset — Loop' }];
}

/** `USDLOOP` → `USD`. The ISO fiat code drives Intl formatting. */
function fiatOf(code: LoopAssetCode): string {
  return code.slice(0, 3);
}

// A2-812: local `isLoopAsset` was a duplicate of `isLoopAssetCode`
// from `@loop/shared/loop-asset`. Now imported for parity with the
// backend admin/asset-circulation handler.

function fmtMinor(minor: string, fiat: string): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat(ADMIN_LOCALE, { style: 'currency', currency: fiat }).format(
      n / 100,
    );
  } catch {
    return `${(n / 100).toFixed(2)} ${fiat}`;
  }
}

function fmtStroops(stroops: string, assetCode: LoopAssetCode): string {
  const negative = stroops.startsWith('-');
  const digits = negative ? stroops.slice(1) : stroops;
  const padded = digits.padStart(8, '0');
  const whole = padded.slice(0, -7);
  const fractionRaw = padded.slice(-7).replace(/0+$/, '');
  const fraction = fractionRaw.length > 0 ? `.${fractionRaw}` : '';
  const sign = negative ? '-' : '';
  return `${sign}${Number(whole).toLocaleString(ADMIN_LOCALE)}${fraction} ${assetCode}`;
}

function truncPubkey(pk: string): string {
  if (pk.length <= 12) return pk;
  return `${pk.slice(0, 6)}…${pk.slice(-4)}`;
}

const PAYOUT_STATES = ['pending', 'submitted', 'confirmed', 'failed'] as const;
type PayoutState = (typeof PAYOUT_STATES)[number];

const STATE_PILL: Record<PayoutState, string> = {
  pending: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  submitted: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  confirmed: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
};

/**
 * `/admin/assets/:assetCode` — single-asset drill for a LOOP
 * stablecoin (ADR 015). Companion to `/admin/operators/:operatorId`
 * — that page is the CTX-supplier drill, this is the
 * liability-side drill.
 *
 * Sections:
 *   - Header — outstanding fiat liability, Stellar issuer pubkey
 *     with a Stellar Expert deep-link
 *   - Payouts by state (this asset) — 4 pills linking into the
 *     `/admin/payouts` filter for that (state, asset) cell
 *   - Top holders — users owed the most on-chain payout for this
 *     asset (from the leaderboard, filtered client-side)
 *   - 30-day settlement chart — daily count + stroop volume
 *     bars from payouts-activity, filtered to this asset
 *
 * All data comes from endpoints already loaded by `/admin/treasury`
 * or `/admin/payouts` — shared TanStack keys dedupe the fetches.
 * No new backend surface is needed.
 */
// A2-1101: see RequireAdmin.tsx for the shell-gate rationale.
export default function AdminAssetDetailRoute(): React.JSX.Element {
  return (
    <RequireAdmin>
      <AdminAssetDetailRouteInner />
    </RequireAdmin>
  );
}

function AdminAssetDetailRouteInner(): React.JSX.Element {
  const { assetCode = '' } = useParams<{ assetCode: string }>();

  const upper = assetCode.toUpperCase();
  const validAsset = isLoopAssetCode(upper);

  const snapshotQuery = useQuery({
    queryKey: ['admin-treasury'],
    queryFn: getTreasurySnapshot,
    enabled: validAsset,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  const byAssetQuery = useQuery({
    queryKey: ['admin-payouts-by-asset'],
    queryFn: getPayoutsByAsset,
    enabled: validAsset,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  const topUsersQuery = useQuery({
    queryKey: ['admin-top-users-by-pending-payout', 50],
    queryFn: () => getTopUsersByPendingPayout({ limit: 50 }),
    enabled: validAsset,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  const activityQuery = useQuery({
    queryKey: ['admin-payouts-activity', 30],
    queryFn: () => getPayoutsActivity(30),
    enabled: validAsset,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  const assetRow: PayoutsByAssetRow | undefined = useMemo(
    () => byAssetQuery.data?.rows.find((r) => r.assetCode === upper),
    [byAssetQuery.data, upper],
  );

  const topHoldersForAsset: TopUserByPendingPayoutEntry[] = useMemo(
    () => (topUsersQuery.data?.entries ?? []).filter((e) => e.assetCode === upper).slice(0, 20),
    [topUsersQuery.data, upper],
  );

  const perDayForAsset = useMemo(() => {
    if (!validAsset) return [];
    const days = activityQuery.data?.rows ?? [];
    return days.map((d: PayoutsActivityDay) => {
      const entry = d.byAsset.find((a) => a.assetCode === upper);
      return {
        day: d.day,
        stroops: entry?.stroops ?? '0',
        count: entry?.count ?? 0,
      };
    });
  }, [activityQuery.data, upper, validAsset]);

  if (!validAsset) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <AdminNav />
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-2">Admin · Asset</h1>
        <p className="text-sm text-red-600 dark:text-red-400">
          Unknown asset code <code className="font-mono">{assetCode}</code>. Valid:{' '}
          {LOOP_ASSET_CODES.join(', ')}.
        </p>
      </main>
    );
  }

  const fiat = fiatOf(upper);
  const liability = snapshotQuery.data?.liabilities?.[upper];

  return (
    <main className="max-w-5xl mx-auto px-6 py-12 space-y-10">
      <AdminNav />
      <header>
        <nav className="mb-2 text-sm">
          <Link to="/admin/treasury" className="text-blue-600 hover:underline dark:text-blue-400">
            ← Treasury
          </Link>
        </nav>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white font-mono">{upper}</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          LOOP stablecoin — pinned 1:1 to {fiat} (ADR 015).
        </p>
      </header>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          Outstanding liability
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          What Loop owes users denominated in this asset — sum of user-credit balances in {fiat},
          re-keyed as the Stellar-side claim.
        </p>
        {snapshotQuery.isPending ? (
          <Spinner />
        ) : snapshotQuery.isError ? (
          <p className="text-sm text-red-600 dark:text-red-400">
            Failed to load treasury snapshot.
          </p>
        ) : liability === undefined ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No outstanding liability — this asset has never been issued to a user.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400">
                Outstanding
              </div>
              <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white tabular-nums">
                {fmtMinor(liability.outstandingMinor, fiat)}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Issuer</div>
              {liability.issuer === null ? (
                <div className="mt-1 text-sm font-medium text-amber-700 dark:text-amber-400">
                  Not configured — on-chain cashback disabled for {upper}.
                </div>
              ) : (
                <div className="mt-1 flex items-baseline gap-2">
                  <code className="text-sm font-mono text-gray-700 dark:text-gray-300">
                    {truncPubkey(liability.issuer)}
                  </code>
                  <a
                    href={`https://stellar.expert/explorer/public/account/${liability.issuer}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                  >
                    View on Stellar Expert →
                  </a>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Circulation drift (#709) — on-chain issuance vs ledger
          liability. Only renders when the issuer is configured;
          otherwise there's no asset to read from Horizon. Self-
          handles Horizon failure with a targeted amber line. */}
      {liability !== undefined && liability.issuer !== null ? (
        <section>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
            On-chain vs ledger
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            Stablecoin safety metric (ADR 015). Compares Horizon&rsquo;s issued circulation against
            the ledger liability above. Settlement backlog drift is expected during steady state as
            the payout worker submits transactions; sustained over-mint is the &ldquo;investigate
            now&rdquo; signal.
          </p>
          <AssetCirculationCard assetCode={upper} />
        </section>
      ) : null}

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          Payouts by state
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          How many {upper} payouts are in each state right now. A rising{' '}
          <code className="text-xs">failed</code> bucket means ops should triage — click through for
          the filtered list.
        </p>
        {byAssetQuery.isPending ? (
          <Spinner />
        ) : byAssetQuery.isError ? (
          <p className="text-sm text-red-600 dark:text-red-400">Failed to load payout states.</p>
        ) : assetRow === undefined ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No {upper} payouts yet — backlog is empty.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {PAYOUT_STATES.map((state) => {
              const bucket = assetRow[state];
              const count = bucket.count;
              return (
                <Link
                  key={state}
                  to={`/admin/payouts?state=${state}&assetCode=${encodeURIComponent(upper)}`}
                  className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900 hover:border-gray-400 dark:hover:border-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium text-gray-500 dark:text-gray-400 capitalize">
                      {state}
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_PILL[state]}`}
                    >
                      {count}
                    </span>
                  </div>
                  <div className="mt-2 text-sm tabular-nums text-gray-700 dark:text-gray-300">
                    {fmtStroops(bucket.stroops, upper)}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          Top holders (in-flight)
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Users owed the most {upper} right now across pending + submitted payout rows. Funding
          prioritisation view — if operator reserves are short, these users see stalls first.
        </p>
        {topUsersQuery.isPending ? (
          <Spinner />
        ) : topUsersQuery.isError ? (
          <p className="text-sm text-red-600 dark:text-red-400">Failed to load top holders.</p>
        ) : topHoldersForAsset.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No users are owed {upper} right now.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">
                    User
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-gray-500 dark:text-gray-400">
                    In-flight
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-gray-500 dark:text-gray-400">
                    Payouts
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-900 bg-white dark:bg-gray-900">
                {topHoldersForAsset.map((e) => (
                  <tr key={e.userId}>
                    <td className="px-3 py-2">
                      <Link
                        to={`/admin/users/${encodeURIComponent(e.userId)}`}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {e.email}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-900 dark:text-white">
                      {fmtStroops(e.totalStroops, upper)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-500 dark:text-gray-400">
                      {e.payoutCount}
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
          Settlement activity (30d)
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Per-day confirmed-payout volume for {upper} from the payouts-activity series. Empty days
          zero-fill so a dormant rail renders as a stable strip of zeros.
        </p>
        {activityQuery.isPending ? (
          <Spinner />
        ) : activityQuery.isError ? (
          <p className="text-sm text-red-600 dark:text-red-400">
            Failed to load settlement activity.
          </p>
        ) : (
          <SettlementChart rows={perDayForAsset} assetCode={upper} />
        )}
      </section>
    </main>
  );
}

function SettlementChart({
  rows,
  assetCode,
}: {
  rows: Array<{ day: string; stroops: string; count: number }>;
  assetCode: LoopAssetCode;
}): React.JSX.Element {
  const max = rows.reduce((m, r) => {
    const v = BigInt(r.stroops);
    return v > m ? v : m;
  }, 0n);
  if (max === 0n) {
    return (
      <p className="py-2 text-sm text-gray-500 dark:text-gray-400">
        No confirmed {assetCode} payouts in the last 30 days.
      </p>
    );
  }
  return (
    <ul role="list" className="space-y-1">
      {rows.map((r) => {
        const v = BigInt(r.stroops);
        const widthPct = max === 0n ? 0 : Number((v * 1000n) / max) / 10;
        return (
          <li
            key={r.day}
            className="flex items-center gap-2 text-xs"
            aria-label={`${shortDay(r.day)}: ${r.count} payouts totalling ${fmtStroops(r.stroops, assetCode)}`}
          >
            <span className="shrink-0 w-16 tabular-nums text-gray-500 dark:text-gray-400">
              {shortDay(r.day)}
            </span>
            <span className="flex h-3 flex-1 overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
              <span
                className="bg-blue-500/70 dark:bg-blue-400/60"
                style={{ width: `${widthPct}%` }}
                aria-hidden="true"
              />
            </span>
            <span className="shrink-0 w-32 tabular-nums text-right text-gray-700 dark:text-gray-300">
              {r.count > 0 ? fmtStroops(r.stroops, assetCode) : '—'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
