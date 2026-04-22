import { useQuery } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import { getAdminUserFlywheelStats } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { formatMinorCurrency, pctBigint } from '@loop/shared';
import { Spinner } from '~/components/ui/Spinner';

/**
 * Admin `/admin/users/:userId` — recycled-vs-total flywheel chip
 * (#600). Support-facing mirror of the user-facing `FlywheelChip` on
 * `/orders`. Renders the target user's LOOP-asset paid order count +
 * charge, with the percentage of their total fulfilled spend that
 * came through the recycling rail.
 *
 * Reuses the user-side chip's `formatMinor` + `pctBigint` helpers
 * rather than duplicating bigint arithmetic — same math, same
 * output, one source of truth. ADR 019 will consolidate to
 * `@loop/shared` once there's a third admin caller.
 *
 * Behaviour diffs vs. user-side chip:
 *   - Doesn't self-hide on zero recycled orders. Operators need to
 *     see "this user hasn't recycled anything yet" vs. the chip
 *     being missing because it crashed. Renders a neutral
 *     "no recycled orders yet" line instead.
 *   - Silent no-op on 404 (user was deleted between list and drill
 *     — parent page already surfaces "user not found").
 *   - Renders a red inline error on non-404 failure — dashboard,
 *     not a motivational accent.
 */
export function AdminUserFlywheelChip({ userId }: { userId: string }): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['admin-user-flywheel-stats', userId],
    queryFn: () => getAdminUserFlywheelStats(userId),
    enabled: userId.length > 0,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  if (query.isPending) {
    return (
      <div className="inline-flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <Spinner />
        <span>Loading flywheel…</span>
      </div>
    );
  }

  if (query.isError) {
    if (query.error instanceof ApiException && query.error.status === 404) {
      return null;
    }
    return <p className="text-xs text-red-600 dark:text-red-400">Failed to load flywheel stats.</p>;
  }

  const stats = query.data;

  if (stats.recycledOrderCount === 0) {
    return (
      <p
        className="text-xs text-gray-500 dark:text-gray-400"
        aria-label="Flywheel: no recycled orders yet"
      >
        No recycled orders yet — user hasn&rsquo;t paid with LOOP asset.
      </p>
    );
  }

  let recycled: bigint;
  let total: bigint;
  try {
    recycled = BigInt(stats.recycledChargeMinor);
    total = BigInt(stats.totalFulfilledChargeMinor);
  } catch {
    // Malformed bigint from server — bail out of the chip rather
    // than print NaN. The rest of the drill-down page still renders.
    return null;
  }

  const pct = pctBigint(recycled, total);

  return (
    <div
      className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-green-200 bg-green-50 px-3 py-1.5 text-sm dark:border-green-900 dark:bg-green-950/40"
      aria-label="Flywheel stats"
    >
      <span className="font-semibold text-green-900 dark:text-green-200">
        {formatMinorCurrency(recycled, stats.currency)}
      </span>
      <span className="text-xs text-green-800 dark:text-green-300">
        recycled · {stats.recycledOrderCount} {stats.recycledOrderCount === 1 ? 'order' : 'orders'}
      </span>
      {pct !== null ? (
        <>
          <span aria-hidden="true" className="text-green-300 dark:text-green-800">
            ·
          </span>
          <span className="text-xs text-green-800 dark:text-green-300">{pct} of spend</span>
        </>
      ) : null}
    </div>
  );
}
