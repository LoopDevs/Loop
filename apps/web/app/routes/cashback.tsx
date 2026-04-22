import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { merchantSlug } from '@loop/shared';
import type { Route } from './+types/cashback';
import { getPublicTopCashbackMerchants, type TopCashbackMerchant } from '~/services/public-stats';
import { shouldRetry } from '~/hooks/query-retry';
import { Navbar } from '~/components/features/Navbar';
import { Footer } from '~/components/features/Footer';
import { Spinner } from '~/components/ui/Spinner';
import { LazyImage } from '~/components/ui/LazyImage';
import { getImageProxyUrl } from '~/utils/image';

/**
 * `/cashback` — SEO index page listing every merchant with an
 * active cashback rate (#649).
 *
 * The fanout point for the per-merchant landing pages shipped in
 * #648: crawlers discover the full set of `/cashback/:slug`
 * routes from internal links here, and users searching "best
 * cashback rates" get the whole sorted list in one scroll.
 *
 * Data source is `/api/public/top-cashback-merchants` with `limit=50`
 * — the same never-500 / CDN-cached endpoint already fueling the
 * homepage "top cashback" band, so this page reuses the existing
 * server-side caching and won't 5xx on a DB hiccup.
 *
 * Each row links to the per-merchant landing (`/cashback/:slug`)
 * using the same `merchantSlug()` helper the rest of the web app
 * uses — slug consistency across surfaces.
 */

const LIMIT = 50;

export function meta(): Route.MetaDescriptors {
  return [
    { title: 'Best cashback rates — Loop' },
    {
      name: 'description',
      content:
        'Earn cashback on gift cards from every merchant on Loop. Paid in LOOP-asset stablecoin — recycle it into more orders for compounding rewards.',
    },
    { tagName: 'link', rel: 'canonical', href: 'https://loopfinance.io/cashback' },
  ];
}

export default function CashbackIndexRoute(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['public-top-cashback-merchants', LIMIT],
    queryFn: () => getPublicTopCashbackMerchants({ limit: LIMIT }),
    retry: shouldRetry,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <>
      <Navbar />
      <main className="container mx-auto max-w-4xl px-4 py-12">
        <header className="text-center mb-10">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">
            Best cashback rates on Loop
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-300 max-w-2xl mx-auto">
            Earn cashback every time you buy a gift card. Paid in LOOP-asset stablecoin that
            compounds when you spend it on your next order.
          </p>
        </header>

        {query.isPending ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : query.isError ? (
          <p className="py-8 text-center text-red-600 dark:text-red-400">
            Couldn&rsquo;t load the cashback list. Please refresh.
          </p>
        ) : query.data.merchants.length === 0 ? (
          <p className="py-8 text-center text-gray-500 dark:text-gray-400">
            No merchants with cashback configured yet — check back soon.
          </p>
        ) : (
          <ul className="space-y-3">
            {query.data.merchants.map((m) => (
              <MerchantRow key={m.id} merchant={m} />
            ))}
          </ul>
        )}

        <section className="mt-12 rounded-xl border border-gray-200 bg-white p-8 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
            How Loop cashback works
          </h2>
          <ol className="list-decimal list-outside pl-6 space-y-3 text-gray-700 dark:text-gray-300">
            <li>Pick a merchant and buy a gift card — pay in XLM, USDC, or your LOOP balance.</li>
            <li>
              Cashback lands in LOOP-asset stablecoin (USDLOOP / GBPLOOP / EURLOOP), pinned 1:1 to
              your home currency.
            </li>
            <li>
              Spend LOOP on your next order. Cashback from order #1 pays for order #2 — the
              flywheel.
            </li>
          </ol>
        </section>
      </main>
      <Footer />
    </>
  );
}

function MerchantRow({ merchant }: { merchant: TopCashbackMerchant }): React.JSX.Element {
  const slug = merchantSlug(merchant.name);
  return (
    <li>
      <Link
        to={`/cashback/${slug}`}
        className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white p-4 hover:border-blue-400 hover:shadow-sm dark:border-gray-800 dark:bg-gray-900 dark:hover:border-blue-500"
        aria-label={`${merchant.name}: ${merchant.userCashbackPct}% cashback`}
      >
        <div className="h-12 w-12 shrink-0">
          {merchant.logoUrl !== null ? (
            <LazyImage
              src={getImageProxyUrl(merchant.logoUrl, 96, 96)}
              alt=""
              className="h-12 w-12 rounded-lg object-cover"
            />
          ) : (
            <div className="h-12 w-12 rounded-lg bg-gray-100 dark:bg-gray-800" aria-hidden="true" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold text-gray-900 dark:text-white truncate">
            {merchant.name}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <span className="text-xl font-semibold text-green-700 dark:text-green-400 tabular-nums">
            {merchant.userCashbackPct}%
          </span>
          <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">back</span>
        </div>
      </Link>
    </li>
  );
}
