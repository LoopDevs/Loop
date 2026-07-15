import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { LocaleLink as Link } from '~/components/ui/LocaleLink';
import type { Route } from './+types/cashback';
import { canonicalHref, countryLabel } from '~/i18n/seo';
import { getPublicTopCashbackMerchants, type TopCashbackMerchant } from '~/services/public-stats';
import { shouldRetry } from '~/hooks/query-retry';
import { useLocale } from '~/i18n/locale';
import { Navbar } from '~/components/features/Navbar';
import { Footer } from '~/components/features/Footer';
import { Phase2Gate } from '~/components/Phase2Gate';
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

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  const where = countryLabel(params.country);
  return [
    { title: where ? `Best cashback rates in ${where} — Loop` : 'Best cashback rates — Loop' },
    {
      name: 'description',
      content: `Earn cashback on gift cards from every merchant on Loop${
        where ? ` in ${where}` : ''
      }. Paid in LOOP-asset stablecoin — recycle it into more orders for compounding rewards.`,
    },
    { tagName: 'link', rel: 'canonical', href: canonicalHref(params, '/cashback') },
  ];
}

export default function CashbackIndexRoute(): React.JSX.Element {
  return (
    <Phase2Gate>
      <CashbackIndexBody />
    </Phase2Gate>
  );
}

function CashbackIndexBody(): React.JSX.Element {
  const { t } = useTranslation('cashback');
  // CAT-02 (2026-06-30 cold audit): scope the index to the visitor's
  // country, same rule home.tsx / brand.$slug.tsx already use — this
  // was one of three country-blind catalog surfaces.
  const { country } = useLocale();
  const query = useQuery({
    queryKey: ['public-top-cashback-merchants', LIMIT, country],
    queryFn: () => getPublicTopCashbackMerchants({ limit: LIMIT, country }),
    retry: shouldRetry,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <>
      <Navbar />
      <main className="container mx-auto max-w-4xl px-4 py-12">
        <header className="text-center mb-10">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">
            {t('index.heading')}
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-300 max-w-2xl mx-auto">
            {t('index.sub')}
          </p>
        </header>

        {query.isPending ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : query.isError ? (
          <p className="py-8 text-center text-red-600 dark:text-red-400">{t('index.loadError')}</p>
        ) : query.data.merchants.length === 0 ? (
          <p className="py-8 text-center text-gray-500 dark:text-gray-400">{t('index.empty')}</p>
        ) : (
          <ul className="space-y-3">
            {query.data.merchants.map((m) => (
              <MerchantRow key={m.id} merchant={m} />
            ))}
          </ul>
        )}

        <section className="mt-12 rounded-xl border border-gray-200 bg-white p-8 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
            {t('index.howItWorks.heading')}
          </h2>
          <ol className="list-decimal list-outside ps-6 space-y-3 text-gray-700 dark:text-gray-300">
            <li>{t('index.howItWorks.step1')}</li>
            <li>{t('index.howItWorks.step2')}</li>
            <li>{t('index.howItWorks.step3')}</li>
          </ol>
        </section>
      </main>
      <Footer />
    </>
  );
}

function MerchantRow({ merchant }: { merchant: TopCashbackMerchant }): React.JSX.Element {
  const { t } = useTranslation('cashback');
  const slug = merchant.slug;
  return (
    <li>
      <Link
        to={`/cashback/${slug}`}
        className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white p-4 hover:border-blue-400 hover:shadow-sm dark:border-gray-800 dark:bg-gray-900 dark:hover:border-blue-500"
        aria-label={t('index.rowAriaLabel', { name: merchant.name, pct: merchant.userCashbackPct })}
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
        <div className="shrink-0 text-end">
          <span className="text-xl font-semibold text-green-700 dark:text-green-400 tabular-nums">
            {merchant.userCashbackPct}%
          </span>
          <span className="ms-1 text-xs text-gray-500 dark:text-gray-400">
            {t('index.rowBack')}
          </span>
        </div>
      </Link>
    </li>
  );
}
