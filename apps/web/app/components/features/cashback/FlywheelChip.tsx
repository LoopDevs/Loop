import { useQuery } from '@tanstack/react-query';
import { formatMinorCurrency, pctBigint } from '@loop/shared';
import { getUserFlywheelStats } from '~/services/user';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

/**
 * "You've recycled £X of cashback across Y orders" chip for /orders
 * + /settings/cashback (ADR 015).
 *
 * The user-side companion to the admin payment-method-share card —
 * surfaces each user's personal participation in the ADR-015 cashback
 * flywheel: previously-earned cashback, emitted as a LOOP asset,
 * spent back into a new order.
 *
 * Behaviour:
 *  - Self-hides for users with zero recycled orders. A user who has
 *    never paid with LOOP asset shouldn't be framed by a "£0
 *    recycled" pill — they haven't started yet.
 *  - Silent no-op on error: the chip is a motivational accent, not a
 *    load-bearing surface.
 *  - bigint-safe formatter — the denominator totals (fleet-wide
 *    charge) can exceed Number.MAX_SAFE_INTEGER in aggregate, but
 *    this is user-scoped so the numbers stay small. Using bigint
 *    anyway keeps the helper shape consistent with every other
 *    cashback-adjacent component.
 */
export function FlywheelChip(): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['me', 'flywheel-stats'],
    queryFn: getUserFlywheelStats,
    retry: shouldRetry,
    // 60s staleness — matches the siblings. An order fulfills, the
    // balance moves, the chip refreshes on the next render window.
    staleTime: 60_000,
  });

  if (query.isPending) {
    return (
      <div className="flex justify-center py-2">
        <Spinner />
      </div>
    );
  }

  if (query.isError) return null;

  const stats = query.data;
  if (stats.recycledOrderCount === 0) return null;

  let recycled: bigint;
  let total: bigint;
  try {
    recycled = BigInt(stats.recycledChargeMinor);
    total = BigInt(stats.totalFulfilledChargeMinor);
  } catch {
    return null;
  }

  const pctOfCharge = pctBigint(recycled, total);

  return (
    <div
      role="status"
      className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200"
      aria-label="Cashback recycled"
    >
      <p className="font-medium">
        You&rsquo;ve recycled{' '}
        <span className="font-semibold">{formatMinorCurrency(recycled, stats.currency)}</span> of
        cashback across{' '}
        <span className="font-semibold">
          {stats.recycledOrderCount} {stats.recycledOrderCount === 1 ? 'order' : 'orders'}
        </span>
        .
      </p>
      {pctOfCharge !== null ? (
        <p className="mt-0.5 text-xs text-green-800 dark:text-green-300">
          That&rsquo;s {pctOfCharge} of your total spend — cashback working twice.
        </p>
      ) : null}
    </div>
  );
}
