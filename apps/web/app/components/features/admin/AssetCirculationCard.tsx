import { useQuery } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type { LoopAssetCode } from '@loop/shared';
import { getAssetCirculation } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { ADMIN_LOCALE } from '~/utils/locale';

/**
 * Per-asset circulation-drift card (ADR 015). Renders on
 * `/admin/assets/:code`. Pulls three numbers from
 * `/api/admin/assets/:code/circulation`:
 *
 *   - On-chain stroops — Horizon's view of the asset's total issued
 *     amount, net of what the issuer holds (what's "in the wild")
 *   - Ledger liability — sum of `user_credits.balance_minor` for
 *     the fiat that pins this asset
 *   - Drift — on-chain minus ledger × 1e5 (1 cent = 1e5 stroops)
 *
 * Drift pill colour:
 *   - zero: muted (rare — payouts are never exactly in lockstep)
 *   - positive: amber (over-minted — transient during processing
 *     or actual over-issuance; ops should investigate)
 *   - negative: blue (settlement backlog — payout worker is
 *     catching up)
 *
 * Horizon failures from the backend come back as 503 — we surface
 * a targeted "on-chain read failed" line so the user knows the
 * ledger side is still authoritative. Other failures degrade
 * silently (render nothing).
 */
interface DriftRow {
  onChainStroops: bigint;
  ledgerLiabilityMinor: bigint;
  driftStroops: bigint;
}

/** `"12345670000"` + `"USDLOOP"` → `"1234.567 USDLOOP"`. Trims trailing zeros. */
export function formatStroops(stroops: bigint, assetCode: string): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / 10_000_000n;
  const fractionRaw = (abs % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
  const fraction = fractionRaw.length > 0 ? `.${fractionRaw}` : '';
  const sign = negative ? '-' : '';
  return `${sign}${whole.toString()}${fraction} ${assetCode}`;
}

/** `"1500"` + `"USD"` → `"$15.00"`. Uses Intl; falls back for unknown codes. */
export function formatMinor(minor: bigint, fiat: string): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const n = Number(abs);
  if (!Number.isFinite(n)) return `${negative ? '-' : ''}${abs.toString()} ${fiat}`;
  try {
    const formatted = new Intl.NumberFormat(ADMIN_LOCALE, {
      style: 'currency',
      currency: fiat,
    }).format(n / 100);
    return negative ? `-${formatted}` : formatted;
  } catch {
    return `${negative ? '-' : ''}${(n / 100).toFixed(2)} ${fiat}`;
  }
}

function formatAsOf(ms: number): string {
  // A2-1521: admin view — pin to ADMIN_LOCALE so the timestamp
  // matches the numeric formatter above. Prior `undefined` read
  // the operator's browser locale, producing "23 Apr, 14:32" for
  // a UK operator vs "Apr 23, 2:32 PM" for a US one on the same
  // row.
  return new Date(ms).toLocaleString(ADMIN_LOCALE, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function AssetCirculationCard({
  assetCode,
}: {
  assetCode: LoopAssetCode;
}): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['admin-asset-circulation', assetCode],
    queryFn: () => getAssetCirculation(assetCode),
    retry: shouldRetry,
    staleTime: 30_000,
  });

  if (query.isPending) {
    return (
      <div className="flex justify-center py-4">
        <Spinner />
      </div>
    );
  }

  // 503 = Horizon read failed. Render a muted "on-chain unavailable"
  // line so the rest of the drill page still functions. Other errors
  // render silently: treasury snapshot already covers the liability.
  if (query.isError) {
    if (query.error instanceof ApiException && query.error.status === 503) {
      return (
        <p className="py-3 text-sm text-amber-700 dark:text-amber-400">
          On-chain circulation read failed — ledger liability on the treasury page remains
          authoritative.
        </p>
      );
    }
    return null;
  }

  const row: DriftRow = {
    onChainStroops: BigInt(query.data.onChainStroops),
    ledgerLiabilityMinor: BigInt(query.data.ledgerLiabilityMinor),
    driftStroops: BigInt(query.data.driftStroops),
  };

  const drift = row.driftStroops;
  const driftSign = drift === 0n ? 'zero' : drift > 0n ? 'positive' : 'negative';
  const driftPill = {
    zero: {
      label: 'In sync',
      classes: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    },
    positive: {
      label: 'Over-minted',
      classes: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    },
    negative: {
      label: 'Settlement backlog',
      classes: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    },
  }[driftSign];

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Circulation drift
          </p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            On-chain as of {formatAsOf(query.data.onChainAsOfMs)}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${driftPill.classes}`}
        >
          {driftPill.label}
        </span>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
          <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">On-chain</dt>
          <dd className="mt-1 text-base font-semibold text-gray-900 dark:text-white tabular-nums">
            {formatStroops(row.onChainStroops, assetCode)}
          </dd>
        </div>
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
          <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">Ledger liability</dt>
          <dd className="mt-1 text-base font-semibold text-gray-900 dark:text-white tabular-nums">
            {formatMinor(row.ledgerLiabilityMinor, query.data.fiatCurrency)}
          </dd>
        </div>
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
          <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">Drift</dt>
          <dd
            className={`mt-1 text-base font-semibold tabular-nums ${
              driftSign === 'positive'
                ? 'text-amber-700 dark:text-amber-400'
                : driftSign === 'negative'
                  ? 'text-blue-700 dark:text-blue-400'
                  : 'text-gray-900 dark:text-white'
            }`}
            aria-label={`Drift: ${driftPill.label}`}
          >
            {drift > 0n ? '+' : ''}
            {formatStroops(row.driftStroops, assetCode)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
