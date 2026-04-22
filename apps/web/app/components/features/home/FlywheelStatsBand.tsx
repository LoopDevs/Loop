import { useQuery } from '@tanstack/react-query';
import { getPublicFlywheelStats } from '~/services/public-stats';

/**
 * Home-page flywheel-stats band — one-sentence forward-looking
 * signal below the cashback totals (#609 endpoint).
 *
 * Reads like: "X.Y% of the last 30 days of orders were paid with
 * recycled cashback" — the marketing pitch for the ADR-015 pivot.
 *
 * Self-hides in three states:
 *   - first-fetch in flight (avoid the "0%" flash before the real
 *     number arrives);
 *   - fetch error (the public endpoint never-500s, so hitting this
 *     branch means an edge / network issue — marketing pages
 *     shouldn't flash a red error to visitors);
 *   - `recycledOrders === 0` (pre-flywheel state: a "0% recycled"
 *     banner is counter-propaganda. Once the number is non-zero the
 *     band shows up for every visitor forever).
 *
 * Colour + copy match the admin FleetFlywheelHeadline so the signal
 * is legible across both surfaces (internal ops + external marketing)
 * even though the endpoints and framing are separate.
 */
export function FlywheelStatsBand(): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['public-flywheel-stats'],
    queryFn: getPublicFlywheelStats,
    // Cache aggressively — the backend also sets Cache-Control:
    // public, max-age=300 so the edge hits origin once per 5min per
    // geo.
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  if (query.isPending || query.isError) return null;
  const data = query.data;
  if (data.recycledOrders === 0) return null;

  return (
    <section
      aria-label="Loop flywheel stats"
      className="max-w-4xl mx-auto rounded-2xl border border-green-200 bg-green-50 px-6 py-4 text-sm text-green-800 dark:border-green-900/60 dark:bg-green-900/20 dark:text-green-300"
    >
      <p className="text-center">
        <span className="font-semibold">{data.pctRecycled}%</span> of the last{' '}
        <span className="font-semibold">{data.fulfilledOrders.toLocaleString('en-US')}</span>{' '}
        fulfilled orders were paid with <span className="font-semibold">recycled cashback</span> —
        the Loop flywheel in action.
      </p>
    </section>
  );
}
