import { useQuery } from '@tanstack/react-query';
import { getPaymentMethodShare, type AdminPaymentMethod } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { pctBigint } from '~/components/features/cashback/FlywheelChip';
import { Spinner } from '~/components/ui/Spinner';

/**
 * `/admin` — at-a-glance fleet-wide flywheel scalar (ADR 015).
 *
 * One sentence: "X.Y% of fulfilled orders this window were paid with
 * recycled LOOP-asset cashback." Gives ops a top-of-dashboard pulse
 * on whether the pivot is working without having to open
 * `/admin/treasury` and read the payment-method share card.
 *
 * Consumes the same `/api/admin/orders/payment-method-share` endpoint
 * the treasury card uses — so the two renders reflect one source of
 * truth. Self-hides on loading / error / zero-activity so the
 * dashboard doesn't open with a broken-looking banner when the
 * backend is unreachable or the fleet is empty.
 */
export function FleetFlywheelHeadline(): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['admin-payment-method-share', 'fulfilled'],
    queryFn: () => getPaymentMethodShare({ state: 'fulfilled' }),
    retry: shouldRetry,
    // Match the stale-time of the treasury card that reads the same
    // key — dedupe means clicking from /admin to /admin/treasury
    // doesn't re-fetch.
    staleTime: 60_000,
  });

  if (query.isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Spinner />
        <span>Loading flywheel…</span>
      </div>
    );
  }

  if (query.isError) return null;

  const snap = query.data;
  if (snap.totalOrders === 0) return null;

  const loopAsset = snap.byMethod.loop_asset;
  const loopAssetCount = loopAsset.orderCount;
  if (loopAssetCount === 0) {
    // Render a muted "not yet" state so ops sees "we know, it's 0"
    // rather than "is this component broken?". This differs from the
    // treasury-side card which only renders when loop_asset > 0 — the
    // dashboard top is the one place that benefits from the negative
    // confirmation.
    return (
      <section
        role="status"
        className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 dark:border-gray-800 dark:bg-gray-900/60 dark:text-gray-300"
        aria-label="Fleet flywheel status"
      >
        No LOOP-asset paid orders in the last window — the flywheel hasn&rsquo;t started yet.
      </section>
    );
  }

  const totalCharge = sumTotalCharge(snap.byMethod);
  let loopAssetCharge: bigint;
  try {
    loopAssetCharge = BigInt(loopAsset.chargeMinor);
  } catch {
    // Malformed bigint from server — bail out of the banner rather
    // than render a NaN next to a money symbol. Rest of the dashboard
    // still renders.
    return null;
  }

  const pctOrders = ((loopAssetCount / snap.totalOrders) * 100).toFixed(1);
  const pctCharge = pctBigint(loopAssetCharge, totalCharge);

  return (
    <section
      role="status"
      aria-label="Fleet flywheel status"
      className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200"
    >
      <p className="font-medium">
        <span className="font-semibold">{pctOrders}%</span> of the last{' '}
        <span className="font-semibold">{snap.totalOrders.toLocaleString('en-US')}</span> fulfilled
        orders were paid with recycled LOOP-asset cashback
        {pctCharge !== null ? (
          <>
            {' '}
            (<span className="font-semibold">{pctCharge}</span> of charge)
          </>
        ) : null}
        .
      </p>
      <p className="mt-1 text-xs text-green-800 dark:text-green-300">
        Cashback credited on earlier orders, being spent back into new ones. See{' '}
        <a
          href="/admin/treasury"
          className="underline decoration-green-600/50 underline-offset-2 hover:decoration-green-600 dark:decoration-green-400/50 dark:hover:decoration-green-400"
        >
          /admin/treasury
        </a>{' '}
        for the full rail breakdown.
      </p>
    </section>
  );
}

const ALL_METHODS: readonly AdminPaymentMethod[] = ['xlm', 'usdc', 'credit', 'loop_asset'];

function sumTotalCharge(byMethod: {
  [K in AdminPaymentMethod]: { orderCount: number; chargeMinor: string };
}): bigint {
  let total = 0n;
  for (const m of ALL_METHODS) {
    try {
      total += BigInt(byMethod[m].chargeMinor);
    } catch {
      /* malformed — skip this rail, keep summing the rest */
    }
  }
  return total;
}
