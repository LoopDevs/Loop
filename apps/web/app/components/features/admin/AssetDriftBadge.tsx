import { useQuery } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type { LoopAssetCode } from '@loop/shared';
import { getAssetCirculation } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';

/**
 * Compact drift pill for the `/admin/treasury` LOOP-liability
 * cards. Shares the `['admin-asset-circulation', code]` cache key
 * with the full `AssetCirculationCard` on `/admin/assets/:code`,
 * so flipping between the two surfaces doesn't re-fetch Horizon.
 *
 * Self-hides while loading. Renders a muted "—" when Horizon is
 * unavailable (503) — the liability side on the same card is
 * already authoritative, so we don't need to shout. Non-503
 * errors render nothing.
 *
 * Design: single short label so the badge fits inside a liability
 * card header next to the truncated issuer pubkey without pushing
 * layout. The full three-number breakdown lives on the asset
 * drill page one click away.
 */
export interface DriftBadgeVariant {
  label: string;
  classes: string;
}

export function classifyDrift(driftStroops: bigint): 'zero' | 'positive' | 'negative' {
  if (driftStroops === 0n) return 'zero';
  return driftStroops > 0n ? 'positive' : 'negative';
}

const VARIANTS: Record<'zero' | 'positive' | 'negative', DriftBadgeVariant> = {
  zero: {
    label: 'In sync',
    classes: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  },
  positive: {
    label: 'Over-minted',
    classes: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  },
  negative: {
    label: 'Backlog',
    classes: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  },
};

export function AssetDriftBadge({
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

  if (query.isPending) return null;

  if (query.isError) {
    if (query.error instanceof ApiException && query.error.status === 503) {
      return (
        <span
          className="text-[10px] text-gray-400 dark:text-gray-500"
          aria-label="On-chain read unavailable"
          title="On-chain circulation read failed — ledger liability remains authoritative"
        >
          —
        </span>
      );
    }
    return null;
  }

  const variant = VARIANTS[classifyDrift(BigInt(query.data.driftStroops))];
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${variant.classes}`}
      aria-label={`Circulation drift: ${variant.label}`}
      title={`Circulation drift: ${variant.label}`}
    >
      {variant.label}
    </span>
  );
}
