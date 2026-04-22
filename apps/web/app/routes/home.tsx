import type { Route } from './+types/home';
import { useAllMerchants, useMerchantsCashbackRatesMap } from '~/hooks/use-merchants';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { Navbar } from '~/components/features/Navbar';
import { Footer } from '~/components/features/Footer';
import { MerchantCard } from '~/components/features/MerchantCard';
import { MerchantCardSkeleton } from '~/components/ui/Skeleton';
import { MobileHome } from '~/components/features/home/MobileHome';
import { CashbackStatsBand } from '~/components/features/home/CashbackStatsBand';

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

/** Thin wrapper that owns the QueryClient for this route tree. */
function HomeContent(): React.JSX.Element {
  const { isNative } = useNativePlatform();
  const { merchants, isLoading, isError } = useAllMerchants();
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
          <div className="text-white relative overflow-hidden">
            {/* hero.webp at the bottom of the stack, gradient as a fallback
              beneath it (visible while the webp loads or if it 404s).
              A dark overlay on top keeps the hero copy readable against
              whatever photography comes through. */}
            <div className="absolute inset-0 bg-gradient-to-br from-gray-900 via-blue-900 to-gray-900" />
            <div
              className="absolute inset-0 bg-cover bg-center"
              style={{ backgroundImage: 'url(/hero.webp)' }}
            />
            <div className="absolute inset-0 bg-black/55" />
            <div className="relative z-0 text-center pt-16 pb-12 px-6 sm:pt-24 sm:pb-16 lg:pt-48 lg:pb-24">
              <h1 className="text-5xl font-bold mb-4">Earn cashback on every gift card</h1>
              <p className="text-lg md:text-xl text-white/80 max-w-2xl mx-auto">
                Buy from merchants you already shop at. Every order pays back to your Loop balance —
                withdraw on-chain whenever you&rsquo;re ready.
              </p>
              <div className="flex flex-row justify-center items-center gap-8 md:gap-16 mt-12 mb-12">
                <Feature
                  icon={
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M13 10V3L4 14h7v7l9-11h-7z"
                      />
                    </svg>
                  }
                  label="Instant Delivery"
                />
                <Feature
                  icon={
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                  }
                  label="100,000+ Locations"
                />
                <Feature
                  icon={
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  }
                  label="Cashback on every order"
                />
              </div>
            </div>
            <div className="absolute pointer-events-none inset-x-0 bottom-0">
              <svg
                viewBox="0 0 2880 48"
                xmlns="http://www.w3.org/2000/svg"
                preserveAspectRatio="none"
                className="w-full"
                style={{ transform: 'scale(2)', transformOrigin: 'top center' }}
              >
                <path
                  d="M0 48H1437.5H2880V0H2160C1442.5 52 720 0 720 0H0V48Z"
                  className="hero-shape-fill"
                />
              </svg>
            </div>
          </div>
        )}

        <div className="container mx-auto px-4 py-12 lg:py-20">
          {isError && (
            <p className="text-center text-red-500 mb-8">
              Failed to load merchants. Please try again.
            </p>
          )}

          <div className="mb-12">
            <CashbackStatsBand />
          </div>

          {/* Featured */}
          {featured.length > 0 && (
            <section className="mb-16">
              <div className="text-center mb-12">
                <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">
                  Top cashback rates
                </h2>
                <p className="text-lg text-gray-600 dark:text-gray-300 max-w-2xl mx-auto">
                  Featured merchants with the highest cashback on Loop right now.
                </p>
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
                {featured.map((merchant, i) => (
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
          <section>
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">
                All Merchants
              </h2>
              <p className="text-lg text-gray-600 dark:text-gray-300 max-w-2xl mx-auto">
                Browse our complete collection of gift cards
              </p>
            </div>
            {isLoading ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 px-4 sm:px-6">
                {Array.from({ length: 8 }).map((_, i) => (
                  <MerchantCardSkeleton key={i} />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6">
                {merchants.map((merchant, i) => (
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
    <div className="text-center">
      <div className="flex justify-center mb-2">{icon}</div>
      <div className="text-sm sm:text-base font-medium">{label}</div>
    </div>
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
