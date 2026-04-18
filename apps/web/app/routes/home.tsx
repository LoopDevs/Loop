import type { Route } from './+types/home';
import { useAllMerchants } from '~/hooks/use-merchants';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { Navbar } from '~/components/features/Navbar';
import { Footer } from '~/components/features/Footer';
import { MerchantCard } from '~/components/features/MerchantCard';
import { MerchantCardSkeleton } from '~/components/ui/Skeleton';

export function meta(): Route.MetaDescriptors {
  return [
    { title: 'Loop — Save money every time you shop' },
    { name: 'description', content: 'Buy discounted gift cards with XLM.' },
  ];
}

/** Thin wrapper that owns the QueryClient for this route tree. */
function HomeContent(): React.JSX.Element {
  const { isNative } = useNativePlatform();
  const { merchants, isLoading, isError } = useAllMerchants();

  const featured = [...merchants]
    .filter((m) => m.savingsPercentage !== undefined && m.savingsPercentage > 0)
    .sort((a, b) => (b.savingsPercentage ?? 0) - (a.savingsPercentage ?? 0))
    .slice(0, 6);

  return (
    <div>
      {!isNative && <Navbar />}

      {/* Hero — skipped on native where the app goes straight to the merchant
          grid. The pitch section is for web visitors who need convincing; on
          mobile the user has already installed the app. */}
      {!isNative && (
        <div className="text-white relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-gray-900 via-blue-900 to-gray-900" />
          <div className="relative z-0 text-center pt-16 pb-12 px-6 sm:pt-24 sm:pb-16 lg:pt-48 lg:pb-24">
            <h1 className="text-5xl font-bold mb-4">Save money every time you shop</h1>
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
                label="Save up to 25%"
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

        {/* Featured */}
        {featured.length > 0 && (
          <section className="mb-16">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">
                Featured Merchants
              </h2>
              <p className="text-lg text-gray-600 dark:text-gray-300 max-w-2xl mx-auto">
                Top-rated merchants with the highest savings
              </p>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
              {featured.map((merchant, i) => (
                <MerchantCard
                  key={merchant.id}
                  merchant={merchant}
                  displayIndex={i}
                  eager={i < 4}
                />
              ))}
            </div>
          </section>
        )}

        {/* All merchants */}
        <section>
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">All Merchants</h2>
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
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {!isNative && <Footer />}
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
