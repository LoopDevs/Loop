import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/cashback.$slug';
import { getPublicMerchant } from '~/services/public-stats';
import { CashbackCalculator } from '~/components/features/cashback/CashbackCalculator';
import { shouldRetry } from '~/hooks/query-retry';
import { Navbar } from '~/components/features/Navbar';
import { Footer } from '~/components/features/Footer';
import { Phase2Gate } from '~/components/Phase2Gate';
import { Spinner } from '~/components/ui/Spinner';
import { LazyImage } from '~/components/ui/LazyImage';
import { getImageProxyUrl } from '~/utils/image';

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

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  let slug = params.slug ?? '';
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // Malformed percent-escape on a crawler URL; keep raw.
  }
  const name = niceName(slug);
  return [
    { title: `Cashback at ${name} — Loop` },
    {
      name: 'description',
      content: `Earn cashback on ${name} gift cards with Loop. Paid in LOOP-asset stablecoin — recycle it into more orders for compounding rewards.`,
    },
    { tagName: 'link', rel: 'canonical', href: `https://loopfinance.io/cashback/${slug}` },
  ];
}

export function ErrorBoundary(): React.JSX.Element {
  return (
    <>
      <Navbar />
      <main className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
          Something went wrong
        </h1>
        <p className="text-gray-600 dark:text-gray-300 mb-6">
          We couldn&apos;t load this merchant. Try again in a minute.
        </p>
        <Link to="/" className="text-blue-600 underline">
          Back to home
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
  const { slug = '' } = useParams<{ slug: string }>();
  const query = useQuery({
    queryKey: ['public-merchant', slug],
    queryFn: () => getPublicMerchant(slug),
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
            merchantId={query.data?.id ?? slug}
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
            How cashback compounds on Loop
          </h2>
          <ol className="list-decimal list-outside pl-6 space-y-3 text-gray-700 dark:text-gray-300">
            <li>Buy a gift card and pay with XLM, USDC, or your existing LOOP-asset balance.</li>
            <li>
              Earn cashback in LOOP-asset stablecoin (USDLOOP / GBPLOOP / EURLOOP), pinned 1:1 to
              your home currency.
            </li>
            <li>
              Spend that LOOP-asset balance on your next order. The cashback you earned on this
              purchase pays for the next one — flywheel.
            </li>
          </ol>
        </section>

        <section className="mt-8 text-center">
          <Link
            to="/"
            className="text-sm text-gray-600 underline hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Browse all merchants →
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
  merchantId,
  isPending,
}: {
  name: string;
  logoUrl: string | null;
  userCashbackPct: string | null;
  merchantId: string;
  isPending: boolean;
}): React.JSX.Element {
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
      <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">Cashback at {name}</h1>
      {isPending ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : userCashbackPct !== null ? (
        <p className="text-2xl text-green-700 dark:text-green-400 mb-6">
          Earn <span className="font-semibold">{userCashbackPct}%</span> back on every {name} gift
          card
        </p>
      ) : (
        <p className="text-lg text-gray-600 dark:text-gray-400 mb-6">
          {name} is coming soon — sign up to be notified when cashback goes live.
        </p>
      )}
      <Link
        to={`/gift-card/${encodeURIComponent(merchantId)}`}
        className="inline-block rounded-lg bg-blue-600 px-6 py-3 text-base font-semibold text-white hover:bg-blue-700"
      >
        Shop {name} gift cards
      </Link>
    </section>
  );
}

function NotFoundCopy({ slug, name }: { slug: string; name: string }): React.JSX.Element {
  return (
    <section className="text-center">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-3">
        {name} isn&rsquo;t on Loop
      </h1>
      <p className="text-gray-600 dark:text-gray-400 mb-6">
        We couldn&rsquo;t find a merchant with slug{' '}
        <code className="font-mono text-sm">{slug}</code>. Browse the full catalog to see
        what&rsquo;s available.
      </p>
      <Link
        to="/"
        className="inline-block rounded-lg bg-blue-600 px-6 py-3 text-base font-semibold text-white hover:bg-blue-700"
      >
        Browse merchants
      </Link>
    </section>
  );
}
