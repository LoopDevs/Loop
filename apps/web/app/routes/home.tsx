import { Link } from 'react-router';
import { useEffect, useState } from 'react';
import type { Route } from './+types/home';
import { useAllMerchants, useMerchantsCashbackRatesMap } from '~/hooks/use-merchants';
import { useAuth } from '~/hooks/use-auth';
import { useAppConfig } from '~/hooks/use-app-config';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { Navbar } from '~/components/features/Navbar';
import { Footer } from '~/components/features/Footer';
import { MerchantCard } from '~/components/features/MerchantCard';
import { FavoritesStrip } from '~/components/features/FavoritesStrip';
import { RecentlyPurchasedStrip } from '~/components/features/RecentlyPurchasedStrip';
import { MerchantCardSkeleton } from '~/components/ui/Skeleton';
import { MobileHome } from '~/components/features/home/MobileHome';

export function meta(): Route.MetaDescriptors {
  return [
    { title: 'Loop — Earn cashback on every gift card' },
    {
      name: 'description',
      content:
        'Buy gift cards from your favourite merchants and earn cashback back to your wallet — on-chain, every time.',
    },
  ];
}

// A2-1109: hero.webp is the LCP candidate on the marketing home page —
// applied as a CSS `background-image`, which the preload scanner can't
// see (background images come from the parsed CSSOM, not the HTML).
// Emitting an explicit `<link rel="preload" as="image">` from the route
// tells the browser to start the fetch in parallel with the HTML/CSS
// download, which moves the LCP earlier. Scoped to this route so other
// pages (settings, admin, search) don't pay for bytes they never paint.
export function links(): Route.LinkDescriptors {
  return [{ rel: 'preload', as: 'image', href: '/hero.webp', type: 'image/webp' }];
}

/** Thin wrapper that owns the QueryClient for this route tree. */
function HomeContent(): React.JSX.Element {
  const [hydrated, setHydrated] = useState(false);
  const { isNative } = useNativePlatform();
  const { isAuthenticated } = useAuth();
  const { merchants, isLoading, isError } = useAllMerchants();
  // Phase 1 (LOOP_PHASE_1_ONLY=true) delivers cashback as instant
  // discount at order creation — no balance, no on-chain withdraw.
  // Hero copy below switches between Phase-1 framing ("Save on
  // every gift card") and Phase-2 framing ("Earn cashback…")
  // accordingly. Meta tags stay Phase-2-leaning for now — they
  // drive search-result indexing rather than the in-page
  // experience, and changing them has SEO implications worth
  // batching with the eventual marketing-site copy refresh.
  const { config } = useAppConfig();
  const phase1Only = config.phase1Only;
  // Bulk cashback-rate map (ADR 011 / 015). One fetch for the whole
  // page — the lookup below is O(1) per card, so both grids share it.
  const { lookup: lookupCashback } = useMerchantsCashbackRatesMap();

  // Featured set — merchants with an active cashback config ranked
  // by rate, falling back to upstream savings % when the rates map
  // hasn't loaded yet (otherwise the featured strip would be empty
  // on a cold page load). A merchant surfaces as long as it has
  // either a cashback rate or a savings percentage.
  const featured = [...merchants]
    .map((m) => {
      const pctStr = lookupCashback(m.id);
      const cashbackPct = pctStr !== null ? Number(pctStr) : 0;
      const savingsPct = m.savingsPercentage ?? 0;
      return { m, cashbackPct, savingsPct };
    })
    .filter(({ cashbackPct, savingsPct }) => cashbackPct > 0 || savingsPct > 0)
    .sort((a, b) => {
      // Cashback rate dominates the sort; savings breaks ties so
      // "5% cashback + 10% savings" beats "5% cashback + 2% savings".
      if (b.cashbackPct !== a.cashbackPct) return b.cashbackPct - a.cashbackPct;
      return b.savingsPct - a.savingsPct;
    })
    .slice(0, 6)
    .map(({ m }) => m);
  const visibleMerchants = hydrated ? merchants : [];
  const visibleFeatured = hydrated ? featured : [];
  const visibleLoading = !hydrated || isLoading;

  useEffect(() => {
    setHydrated(true);
  }, []);

  return (
    <div>
      {!isNative && <Navbar />}

      {/* Desktop hero + directory, hidden on mobile widths. Skipped
          on native regardless — mobile widths always get
          MobileHome, and desktop layouts aren't applicable inside a
          phone webview. Rendered first so Playwright selectors that
          do `a[href^="/gift-card/"].first()` pick the visible
          desktop link, not the hidden mobile one sitting in the DOM. */}
      <div className={isNative ? 'hidden' : 'hidden md:block'}>
        {/* Hero — skipped on native where the app goes straight to the merchant
            grid. The pitch section is for web visitors who need convincing; on
            mobile the user has already installed the app. */}
        {!isNative && (
          <section className="relative overflow-hidden border-b border-line bg-surface">
            {/* Clean light hero — subtle grid texture + a soft blue glow
                top-centre for depth, no heavy photography. */}
            <div className="absolute inset-0 bg-grid opacity-60" aria-hidden="true" />
            <div
              className="absolute inset-x-0 -top-40 h-96 bg-[radial-gradient(closest-side,rgba(26,86,219,0.10),transparent)]"
              aria-hidden="true"
            />
            <div className="relative mx-auto max-w-4xl text-center px-6 pt-20 pb-16 sm:pt-28 sm:pb-20">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 ring-1 ring-blue-100">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-600" />
                {phase1Only ? 'Up to 15% off, instantly' : 'Cashback on every order'}
              </span>
              <h1 className="mt-6 text-4xl sm:text-6xl font-semibold tracking-[-0.03em] text-ink leading-[1.05]">
                {phase1Only ? (
                  <>
                    Save on every
                    <br className="hidden sm:block" />{' '}
                    <span className="text-blue-600">gift card</span>
                  </>
                ) : (
                  <>
                    Earn cashback on
                    <br className="hidden sm:block" /> every{' '}
                    <span className="text-blue-600">gift card</span>
                  </>
                )}
              </h1>
              <p className="mt-5 text-lg text-ink-muted max-w-xl mx-auto">
                {phase1Only
                  ? 'Buy from merchants you already shop at. Save up to 15% instantly — pay with XLM or USDC, redeem online or in-store.'
                  : 'Buy from merchants you already shop at. Every order pays back to your Loop balance — withdraw on-chain whenever you’re ready.'}
              </p>
              <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
                {!isAuthenticated && (
                  <Link
                    to="/onboarding"
                    className="inline-flex items-center justify-center rounded-md bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-xs hover:bg-blue-700 active:bg-blue-800 transition-colors"
                  >
                    Get started — it’s free
                  </Link>
                )}
                <a
                  href="#directory"
                  className="inline-flex items-center justify-center gap-1 rounded-md border border-line-strong bg-white px-5 py-3 text-sm font-semibold text-ink hover:bg-gray-50 transition-colors"
                >
                  Browse brands
                  <span aria-hidden="true">→</span>
                </a>
              </div>
              <div className="mt-12 grid grid-cols-3 gap-4 max-w-2xl mx-auto">
                <Feature
                  icon={
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 10V3L4 14h7v7l9-11h-7z"
                      />
                    </svg>
                  }
                  label="Instant delivery"
                />
                <Feature
                  icon={
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                  }
                  label="500,000+ locations"
                />
                <Feature
                  icon={
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  }
                  label={phase1Only ? 'Save on every order' : 'Cashback every order'}
                />
              </div>
            </div>
          </section>
        )}

        <div className="container mx-auto px-4 py-12 lg:py-20">
          {isError && (
            <p className="text-center text-red-500 mb-8">
              Failed to load merchants. Please try again.
            </p>
          )}

          {/* How it works — three-step explainer for unauthenticated
              crawlers + first-time visitors (#661). SEO content for
              the "how does Loop cashback work" query class; internal
              links down to /cashback and /trustlines give the
              acquisition funnel two natural next clicks. Rendered
              only when not authenticated (signed-in users already
              know the flow; the band would be just noise). */}
          {!isAuthenticated && <HowItWorksStrip />}

          {/* "Recently purchased" + "Your favourites" strips — both
              self-gate on isAuthenticated and a non-empty list, so
              brand-new and signed-out users see the existing layout
              unchanged. Recently-purchased renders first because a
              returning buyer is most likely to want to repeat-purchase
              before they want to browse pinned-but-unused merchants. */}
          <RecentlyPurchasedStrip variant="desktop" />
          <FavoritesStrip variant="desktop" />

          {/* Featured */}
          {visibleFeatured.length > 0 && (
            <section className="mb-16">
              <div className="text-center mb-10">
                <h2 className="text-3xl font-semibold tracking-[-0.02em] text-ink mb-3">
                  Top cashback rates
                </h2>
                <p className="text-base text-ink-muted max-w-2xl mx-auto">
                  Featured merchants with the highest cashback on Loop right now.
                </p>
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
                {visibleFeatured.map((merchant, i) => (
                  <MerchantCard
                    key={merchant.id}
                    merchant={merchant}
                    displayIndex={i}
                    eager={i < 4}
                    userCashbackPct={lookupCashback(merchant.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* All merchants */}
          <section id="directory" className="scroll-mt-24">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">
                All Merchants
              </h2>
              <p className="text-lg text-gray-600 dark:text-gray-300 max-w-2xl mx-auto">
                Browse our complete collection of gift cards
              </p>
            </div>
            {visibleLoading ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 px-4 sm:px-6">
                {Array.from({ length: 8 }).map((_, i) => (
                  <MerchantCardSkeleton key={i} />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6">
                {visibleMerchants.map((merchant, i) => (
                  <MerchantCard
                    key={merchant.id}
                    merchant={merchant}
                    displayIndex={i + 6}
                    eager={i < 4}
                    userCashbackPct={lookupCashback(merchant.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        {!isNative && <Footer />}
      </div>

      {/* Mobile + native: the new dashboard+directory layout. Web
          renders it at `<md` widths alongside the Navbar; native
          has no Navbar so it's the whole chrome. Desktop (md+)
          hides it via the wrapper class; placed after the desktop
          tree so Playwright selectors pick the visible variant. */}
      <div className={isNative ? '' : 'md:hidden'}>
        <MobileHome />
      </div>
    </div>
  );
}

function Feature({ icon, label }: { icon: React.ReactNode; label: string }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-line bg-surface px-3 py-4">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 text-blue-600">
        {icon}
      </span>
      <div className="text-xs sm:text-sm font-medium text-ink-muted text-center">{label}</div>
    </div>
  );
}

/**
 * Three-step cashback-flywheel explainer strip for unauthenticated
 * homepage visitors (#661). Keyword-rich body copy ("cashback on
 * gift cards", "LOOP asset stablecoin", "compounds") so crawlers
 * have content to rank; internal links to /cashback and
 * /trustlines give first-time visitors two natural next clicks
 * without breaking the main merchant-browse flow.
 *
 * Self-hides for authenticated users — they already know how it
 * works; the strip would just add noise between the stats band
 * and the merchant grid. Non-authenticated = pre-funnel audience,
 * the only people the explainer helps.
 */
function HowItWorksStrip(): React.JSX.Element {
  return (
    <section
      aria-labelledby="how-it-works-heading"
      className="mb-16 rounded-xl border border-gray-200 bg-white p-8 dark:border-gray-800 dark:bg-gray-900"
    >
      <div className="text-center mb-8">
        <h2
          id="how-it-works-heading"
          className="text-2xl font-bold text-gray-900 dark:text-white mb-2"
        >
          How Loop cashback works
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-300 max-w-xl mx-auto">
          Every gift card pays back. Your cashback compounds into more cashback — a flywheel, not a
          one-shot rebate.
        </p>
      </div>
      <ol className="grid grid-cols-1 md:grid-cols-3 gap-6 text-sm">
        <Step
          index={1}
          heading="Buy a gift card"
          body="Pay with XLM, USDC, or your existing LOOP-asset balance. We check out at the merchant on your behalf — same brand, same card."
        />
        <Step
          index={2}
          heading="Earn in LOOP asset"
          body="Cashback lands in USDLOOP / GBPLOOP / EURLOOP — Stellar stablecoins pinned 1:1 to your home currency. Verified issuers live on the /trustlines page."
          linkTo="/trustlines"
          linkLabel="See the verified issuers →"
        />
        <Step
          index={3}
          heading="Spend it again"
          body="Use your LOOP-asset balance to pay for your next gift card. Cashback on order #1 pays part of order #2 — the flywheel."
          linkTo="/cashback"
          linkLabel="Browse all cashback rates →"
        />
      </ol>
    </section>
  );
}

function Step({
  index,
  heading,
  body,
  linkTo,
  linkLabel,
}: {
  index: number;
  heading: string;
  body: string;
  linkTo?: string;
  linkLabel?: string;
}): React.JSX.Element {
  return (
    <li className="flex flex-col">
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-green-100 text-sm font-semibold text-green-800 dark:bg-green-900/40 dark:text-green-300 mb-3">
        {index}
      </span>
      <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-1">{heading}</h3>
      <p className="text-gray-600 dark:text-gray-300">{body}</p>
      {linkTo !== undefined && linkLabel !== undefined ? (
        <Link
          to={linkTo}
          className="mt-2 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          {linkLabel}
        </Link>
      ) : null}
    </li>
  );
}

export default function Home(): React.JSX.Element {
  return <HomeContent />;
}

export function ErrorBoundary(): React.JSX.Element {
  return (
    <div className="container mx-auto px-4 py-16 text-center">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
        Something went wrong
      </h1>
      <p className="text-gray-600 dark:text-gray-300 mb-6">
        We couldn&apos;t load the merchant directory.
      </p>
      <a href="/" className="text-blue-600 underline">
        Reload page
      </a>
    </div>
  );
}
