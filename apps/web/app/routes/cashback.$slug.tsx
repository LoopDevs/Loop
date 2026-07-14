import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { LocaleLink as Link } from '~/components/ui/LocaleLink';
import { ApiException } from '@loop/shared';
import type { MetaDescriptor } from 'react-router';
import { canonicalHref } from '~/i18n/seo';
import { getPublicMerchant } from '~/services/public-stats';
import { CashbackCalculator } from '~/components/features/cashback/CashbackCalculator';
import { shouldRetry } from '~/hooks/query-retry';
import { useLocale } from '~/i18n/locale';
import { Navbar } from '~/components/features/Navbar';
import { Footer } from '~/components/features/Footer';
import { Phase2Gate } from '~/components/Phase2Gate';
import { Spinner } from '~/components/ui/Spinner';
import { LazyImage } from '~/components/ui/LazyImage';
import { getImageProxyUrl } from '~/utils/image';
import i18n from '~/i18n/i18next';

/**
 * `/cashback/:slug` — SEO landing page for one merchant (#648).
 *
 * Backs the ADR-020 public merchant endpoint shipped in #647.
 * Visitors arriving from a "cashback at amazon" search land on a
 * page whose title, description, and h1 are keyword-rich — the
 * flywheel story in one screen. The CTA funnels into the same
 * /gift-card/:slug purchase flow authenticated users use.
 *
 * Architecture:
 *   - Loader emits meta (title, description, canonical link)
 *     from the slug param. No server-side data fetching per
 *     CLAUDE.md's "web is a pure API client" rule — crawlers
 *     still get the core meta tags in the SSR HTML; the
 *     cashback pct lands client-side once the query resolves.
 *   - Component uses TanStack Query against the public
 *     endpoint. 404 → "merchant not available" copy with a
 *     link back to home. Never-500 means the fetch will almost
 *     never fail; if it does, we render the error boundary.
 */

function niceName(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// P2-10/P2-11: this is now the component-only (mobile / SPA) variant — the SSR
// build wires `cashback.$slug-ssr.tsx` (loader throws a real 404 for an unknown
// merchant), so SSR typegen never sees this route and `./+types/cashback.$slug`
// doesn't exist under it. Inline the meta types instead of importing them, the
// same pattern `not-found.tsx` / `locale-layout.tsx` use for their mobile-only
// files. `cashback.$slug-ssr.tsx` re-exports this `meta`.
export function meta({
  params,
}: {
  params: { slug?: string | undefined; country?: string | undefined; lang?: string | undefined };
}): MetaDescriptor[] {
  let slug = params.slug ?? '';
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // Malformed percent-escape on a crawler URL; keep raw.
  }
  const name = niceName(slug);
  return [
    { title: i18n.t('cashback:merchant.meta.title', { name }) },
    {
      name: 'description',
      content: i18n.t('cashback:merchant.meta.description', { name }),
    },
    { tagName: 'link', rel: 'canonical', href: canonicalHref(params, `/cashback/${slug}`) },
  ];
}

export function ErrorBoundary(): React.JSX.Element {
  const { t } = useTranslation('cashback');
  return (
    <>
      <Navbar />
      <main className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
          {t('common:errorBoundary.heading')}
        </h1>
        <p className="text-gray-600 dark:text-gray-300 mb-6">{t('merchant.errorBoundary.body')}</p>
        <Link to="/" className="text-blue-600 underline">
          {t('merchant.errorBoundary.link')}
        </Link>
      </main>
      <Footer />
    </>
  );
}

export default function CashbackMerchantLanding(): React.JSX.Element {
  return (
    <Phase2Gate>
      <CashbackMerchantLandingBody />
    </Phase2Gate>
  );
}

function CashbackMerchantLandingBody(): React.JSX.Element {
  const { t } = useTranslation('cashback');
  const { slug = '' } = useParams<{ slug: string }>();
  // CAT-02 (2026-06-30 cold audit): a merchant out of the visitor's
  // country/currency scope now 404s server-side (same rule
  // home.tsx / brand.$slug.tsx already use) instead of resolving any
  // slug regardless of locale.
  const { country } = useLocale();
  const query = useQuery({
    queryKey: ['public-merchant', slug, country],
    queryFn: () => getPublicMerchant(slug, { country }),
    enabled: slug.length > 0,
    retry: shouldRetry,
    // Merchant detail is near-static; long cache ok.
    staleTime: 5 * 60 * 1000,
  });

  const fallbackName = niceName(slug);

  return (
    <>
      <Navbar />
      <main className="container mx-auto max-w-3xl px-4 py-12">
        {query.isError && query.error instanceof ApiException && query.error.status === 404 ? (
          <NotFoundCopy slug={slug} name={fallbackName} />
        ) : (
          <HeroCopy
            name={query.data?.name ?? fallbackName}
            logoUrl={query.data?.logoUrl ?? null}
            userCashbackPct={query.data?.userCashbackPct ?? null}
            merchantSlug={query.data?.slug ?? slug}
            isPending={query.isPending}
          />
        )}

        {/* Pre-signup cashback calculator (#735). Renders only when
            the public merchant endpoint has resolved a real id —
            the NotFoundCopy branch above handles the 404 case, so
            by the time we get here we have the merchant id or the
            slug fallback (which the backend also resolves). */}
        {query.data !== undefined && query.data.userCashbackPct !== null ? (
          <div className="mt-8">
            <CashbackCalculator merchantId={query.data.id} />
          </div>
        ) : null}

        <section className="mt-12 rounded-xl border border-gray-200 bg-white p-8 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
            {t('merchant.howItWorks.heading')}
          </h2>
          <ol className="list-decimal list-outside pl-6 space-y-3 text-gray-700 dark:text-gray-300">
            <li>{t('merchant.howItWorks.step1')}</li>
            <li>{t('merchant.howItWorks.step2')}</li>
            <li>{t('merchant.howItWorks.step3')}</li>
          </ol>
        </section>

        <section className="mt-8 text-center">
          <Link
            to="/"
            className="text-sm text-gray-600 underline hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
          >
            {t('merchant.browseAll')}
          </Link>
        </section>
      </main>
      <Footer />
    </>
  );
}

function HeroCopy({
  name,
  logoUrl,
  userCashbackPct,
  merchantSlug,
  isPending,
}: {
  name: string;
  logoUrl: string | null;
  userCashbackPct: string | null;
  merchantSlug: string;
  isPending: boolean;
}): React.JSX.Element {
  const { t } = useTranslation('cashback');
  return (
    <section className="text-center">
      {logoUrl !== null ? (
        <div className="mx-auto mb-6 h-24 w-24">
          <LazyImage
            src={getImageProxyUrl(logoUrl, 192, 192)}
            alt={`${name} logo`}
            className="h-24 w-24 rounded-2xl object-cover"
            eager
          />
        </div>
      ) : null}
      <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">
        {t('merchant.hero.heading', { name })}
      </h1>
      {isPending ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : userCashbackPct !== null ? (
        <p className="text-2xl text-green-700 dark:text-green-400 mb-6">
          {t('merchant.hero.earnPrefix')}
          <span className="font-semibold">{userCashbackPct}%</span>
          {t('merchant.hero.earnSuffix', { name })}
        </p>
      ) : (
        <p className="text-lg text-gray-600 dark:text-gray-400 mb-6">
          {t('merchant.hero.comingSoon', { name })}
        </p>
      )}
      <Link
        to={`/gift-card/${encodeURIComponent(merchantSlug)}`}
        className="inline-block rounded-lg bg-blue-600 px-6 py-3 text-base font-semibold text-white hover:bg-blue-700"
      >
        {t('merchant.hero.shopCta', { name })}
      </Link>
    </section>
  );
}

function NotFoundCopy({ slug, name }: { slug: string; name: string }): React.JSX.Element {
  const { t } = useTranslation('cashback');
  return (
    <section className="text-center">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-3">
        {t('merchant.notFound.heading', { name })}
      </h1>
      <p className="text-gray-600 dark:text-gray-400 mb-6">
        {t('merchant.notFound.bodyPrefix')}
        <code className="font-mono text-sm">{slug}</code>
        {t('merchant.notFound.bodySuffix')}
      </p>
      <Link
        to="/"
        className="inline-block rounded-lg bg-blue-600 px-6 py-3 text-base font-semibold text-white hover:bg-blue-700"
      >
        {t('merchant.notFound.browse')}
      </Link>
    </section>
  );
}
