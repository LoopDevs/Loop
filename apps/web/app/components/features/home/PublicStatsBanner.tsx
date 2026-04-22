import { useQuery } from '@tanstack/react-query';
import { getPublicStats, type PublicStats } from '~/services/public';

/**
 * Home-page stats strip — "£X paid · N users · M merchants · K orders".
 *
 * Consumes `GET /api/public/stats` (unauthenticated, 1h CDN cache on
 * the backend). Renders silently nothing on the loading or error paths
 * — the hero above already conveys the product value, and a half-loaded
 * banner with "—" in every slot reads worse than an empty space. We
 * only show the strip once we have real numbers.
 *
 * Currency aggregation: the backend keys cashback totals by the user's
 * home currency. This component renders them in locale priority order
 * (GBP → USD → EUR). When only one currency has data we show one line;
 * with several we separate them with a middle dot.
 */
const CURRENCY_ORDER: readonly string[] = ['GBP', 'USD', 'EUR'];
const CURRENCY_SYMBOL: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };

export function PublicStatsBanner(): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['public-stats'],
    queryFn: getPublicStats,
    // Server already sends Cache-Control: max-age=3600; TanStack's
    // staleTime is the browser-side window. 10 minutes is plenty —
    // the number doesn't move that fast and this avoids refetching
    // on every route transition inside the app.
    staleTime: 10 * 60 * 1000,
    // Don't retry noisily — falling back to nothing is fine.
    retry: 0,
  });

  if (query.data === undefined) return null;
  const tiles = buildTiles(query.data);
  if (tiles.length === 0) return null;

  return (
    <section
      aria-label="Loop cashback to date"
      className="mb-12 rounded-2xl border border-gray-200 dark:border-gray-800 bg-white/70 dark:bg-gray-900/50 backdrop-blur px-6 py-4"
    >
      <ul className="flex flex-wrap items-baseline justify-center gap-x-6 gap-y-2 text-sm text-gray-600 dark:text-gray-400">
        {tiles.map((t) => (
          <li key={t.label} className="flex items-baseline gap-2">
            <span className="font-semibold text-gray-900 dark:text-white text-lg tabular-nums">
              {t.value}
            </span>
            <span className="text-xs uppercase tracking-wide">{t.label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface Tile {
  label: string;
  value: string;
}

/**
 * Shape the stats into display tiles. Cashback amounts get one tile
 * per currency (so a mixed-region deployment reads naturally); counts
 * are their own tiles. Empty buckets are dropped so we don't show
 * "£0 paid" or "0 users" on a fresh deployment — better to render
 * nothing than a discouraging zero.
 */
function buildTiles(stats: PublicStats): Tile[] {
  const tiles: Tile[] = [];

  // Cashback per currency, ordered.
  const currencies = Object.keys(stats.paidCashbackMinor).sort((a, b) => {
    const ai = CURRENCY_ORDER.indexOf(a);
    const bi = CURRENCY_ORDER.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  for (const c of currencies) {
    const minor = stats.paidCashbackMinor[c] ?? '0';
    if (minor === '0' || minor === '') continue;
    tiles.push({ label: `${c} paid`, value: formatMinor(minor, c) });
  }

  const paidUsers = safeBigInt(stats.paidUserCount);
  if (paidUsers > 0n) {
    tiles.push({
      label: paidUsers === 1n ? 'user earning' : 'users earning',
      value: paidUsers.toLocaleString('en-US'),
    });
  }

  const merchants = safeBigInt(stats.merchantsWithOrders);
  if (merchants > 0n) {
    tiles.push({
      label: merchants === 1n ? 'merchant' : 'merchants',
      value: merchants.toLocaleString('en-US'),
    });
  }

  const orders = safeBigInt(stats.fulfilledOrderCount);
  if (orders > 0n) {
    tiles.push({
      label: orders === 1n ? 'order fulfilled' : 'orders fulfilled',
      value: orders.toLocaleString('en-US'),
    });
  }

  return tiles;
}

/**
 * Minor-unit bigint-string → localised currency string. Bigint-safe
 * because the marketing surface could reasonably see billion-minor
 * totals and a Number cast would lose precision on the wire edge.
 */
function formatMinor(minor: string, currency: string): string {
  const negative = minor.startsWith('-');
  const digits = negative ? minor.slice(1) : minor;
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2);
  const fraction = padded.slice(-2);
  const symbol = CURRENCY_SYMBOL[currency] ?? '';
  const formattedWhole = Number(whole).toLocaleString('en-US');
  return `${negative ? '-' : ''}${symbol}${formattedWhole}.${fraction}`;
}

function safeBigInt(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}
