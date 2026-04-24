import { useQuery } from '@tanstack/react-query';
import { getUserPendingPayoutsSummary } from '~/services/user';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';

/**
 * User-facing "you have cashback settling" summary pill. Sits under
 * the CashbackBalanceCard on the Account screen so the user sees
 * in-flight cashback at a glance — "$12.50 USDLOOP settling · oldest
 * 2 min ago" — without drilling into /settings/cashback for the full
 * list.
 *
 * Reads `/api/users/me/pending-payouts/summary` which the backend
 * computes as a single GROUP BY, so this is cheap to poll. Self-
 * hides on loading / error / empty — a user with nothing in flight
 * gets no chip rather than "settling: $0.00".
 *
 * Totals are displayed per-asset because LOOP stablecoins are 1:1
 * with distinct fiats (USDLOOP = USD, GBPLOOP = GBP, EURLOOP = EUR)
 * — summing them into one number would hide a currency mismatch.
 */

const FIAT_BY_CODE: Record<string, string> = {
  USDLOOP: 'USD',
  GBPLOOP: 'GBP',
  EURLOOP: 'EUR',
};

/**
 * Stroops (7-decimal) → minor units (2-decimal fiat cents / pence).
 * A LOOP asset is pinned 1:1 to fiat with 100_000 stroops per minor.
 * Any extra fractional stroops are truncated — the UI displays whole
 * fiat cents, fractions of a cent aren't user-meaningful.
 */
export function stroopsToMinor(stroopsStr: string): bigint {
  try {
    return BigInt(stroopsStr) / 100_000n;
  } catch {
    return 0n;
  }
}

function formatAmount(stroopsStr: string, fiat: string): string {
  const minor = stroopsToMinor(stroopsStr);
  const major = Number(minor) / 100;
  try {
    // `narrowSymbol` picks `$` over `US$` regardless of the runtime
    // locale — users in en-GB environments get `$`, not `US$`, for
    // USDLOOP balances. Same behaviour on jsdom test runs.
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: fiat,
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    return `${major.toFixed(2)} ${fiat}`;
  }
}

export function formatOldestAgo(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const delta = Math.max(0, now - t);
  const s = Math.round(delta / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

export function PendingCashbackChip(): React.JSX.Element | null {
  // A2-1156: auth-gate so cold-start doesn't fire before session restore.
  const { isAuthenticated } = useAuth();
  const query = useQuery({
    queryKey: ['me', 'pending-payouts-summary'],
    queryFn: getUserPendingPayoutsSummary,
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  if (query.isPending || query.isError) return null;
  const rows = query.data.rows;
  if (rows.length === 0) return null;

  // Roll up across states (pending + submitted both count as
  // "settling") per asset. A user doesn't need to see the state
  // transition here — that's what the PendingPayoutsCard below shows.
  const byAsset = new Map<string, { stroops: bigint; oldestMs: number }>();
  for (const r of rows) {
    const fiat = FIAT_BY_CODE[r.assetCode];
    if (fiat === undefined) continue;
    const current = byAsset.get(r.assetCode);
    const s = (() => {
      try {
        return BigInt(r.totalStroops);
      } catch {
        return 0n;
      }
    })();
    const oldest = new Date(r.oldestCreatedAt).getTime();
    if (current === undefined) {
      byAsset.set(r.assetCode, { stroops: s, oldestMs: Number.isFinite(oldest) ? oldest : 0 });
    } else {
      byAsset.set(r.assetCode, {
        stroops: current.stroops + s,
        oldestMs:
          current.oldestMs > 0 && oldest > 0
            ? Math.min(current.oldestMs, oldest)
            : Math.max(current.oldestMs, oldest),
      });
    }
  }

  const assets = Array.from(byAsset.entries()).sort(([a], [b]) => a.localeCompare(b));
  if (assets.length === 0) return null;

  // Oldest across all assets drives the chip's age label; per-asset
  // ages matter for the full list, not this headline.
  const oldestMs = assets.reduce((acc, [, v]) => {
    if (v.oldestMs <= 0) return acc;
    return acc === 0 ? v.oldestMs : Math.min(acc, v.oldestMs);
  }, 0);

  return (
    <section
      aria-label="Cashback settling"
      className="mb-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-left dark:border-blue-900/60 dark:bg-blue-900/20"
    >
      <div className="flex items-baseline justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
          Cashback settling
        </div>
        {oldestMs > 0 ? (
          <div className="text-[10px] text-blue-700/70 dark:text-blue-300/70">
            oldest {formatOldestAgo(new Date(oldestMs).toISOString())}
          </div>
        ) : null}
      </div>
      <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
        {assets.map(([code, v]) => (
          <div key={code} className="flex items-baseline gap-1.5">
            <dt className="font-mono text-[11px] text-blue-700/80 dark:text-blue-300/80">{code}</dt>
            <dd className="font-semibold text-blue-900 dark:text-blue-100">
              {formatAmount(v.stroops.toString(), FIAT_BY_CODE[code]!)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
