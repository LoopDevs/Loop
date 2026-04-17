import { useParams, Link } from 'react-router';
import type { Route } from './+types/gift-card.$name';
import { useMerchantBySlug } from '~/hooks/use-merchants';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { Navbar } from '~/components/features/Navbar';
import { Footer } from '~/components/features/Footer';
import { PurchaseContainer } from '~/components/features/purchase/PurchaseContainer';
import { Spinner } from '~/components/ui/Spinner';
import { LazyImage } from '~/components/ui/LazyImage';
import { getImageProxyUrl } from '~/utils/image';

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  // decodeURIComponent throws on malformed percent escapes (e.g. "%ZZ"). A
  // crawler hitting a junk URL like /gift-card/%ZZ would otherwise 500 the
  // SSR render. Fall back to the raw slug on malformed input.
  let name = params.name ?? '';
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep the raw value
  }
  name = name.replace(/-/g, ' ');
  return [
    { title: `${name} Gift Card — Loop` },
    { name: 'description', content: `Buy ${name} gift cards with XLM and save money.` },
  ];
}

export function ErrorBoundary(): React.JSX.Element {
  return (
    <div className="container mx-auto px-4 py-16 text-center">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
        Something went wrong
      </h1>
      <p className="text-gray-600 dark:text-gray-300 mb-6">We couldn&apos;t load this gift card.</p>
      <Link to="/" className="text-blue-600 underline">
        Back to home
      </Link>
    </div>
  );
}

export default function GiftCardRoute(): React.JSX.Element {
  const { name = '' } = useParams<{ name: string }>();
  const { isNative } = useNativePlatform();
  const { merchant, isLoading, isError } = useMerchantBySlug(name);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner />
      </div>
    );
  }

  if (isError || merchant === undefined) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
          Merchant not found
        </h1>
        <Link to="/" className="text-blue-600 underline">
          Back to home
        </Link>
      </div>
    );
  }

  const heroUrl = merchant.cardImageUrl ? getImageProxyUrl(merchant.cardImageUrl, 1280) : undefined;
  const cardUrl = merchant.cardImageUrl ? getImageProxyUrl(merchant.cardImageUrl, 640) : undefined;
  const logoUrl = merchant.logoUrl ? getImageProxyUrl(merchant.logoUrl, 100) : undefined;
  const savings = merchant.savingsPercentage;

  return (
    <div>
      {!isNative && <Navbar />}

      {/* Hero Banner */}
      <div className="relative h-64 sm:h-80 lg:h-96 overflow-hidden">
        {heroUrl ? (
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${heroUrl})` }}
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-blue-500 to-purple-600" />
        )}
        <div className="absolute inset-0 bg-black/60" />

        {/* Wave shape divider */}
        <div className="absolute pointer-events-none inset-x-0 -bottom-1">
          <svg
            viewBox="0 0 2880 48"
            xmlns="http://www.w3.org/2000/svg"
            preserveAspectRatio="none"
            style={{
              transform: 'scale(2)',
              width: '100%',
              height: 'auto',
              transformOrigin: 'top center',
            }}
          >
            <path
              d="M0 48H1437.5H2880V0H2160C1442.5 52 720 0 720 0H0V48Z"
              className="fill-white dark:fill-gray-950"
            />
          </svg>
        </div>
      </div>

      {/* Content */}
      <div className="container mx-auto px-4 relative z-20 -mt-8">
        <div className="flex flex-col lg:flex-row gap-8 mb-12">
          {/* Right column — Purchase card (sticky on desktop) */}
          <div className="lg:w-2/5 xl:w-1/2 2xl:w-2/5 lg:order-2">
            <div className="lg:sticky lg:top-24">
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg overflow-hidden mb-6">
                {/* Card image */}
                <div className="aspect-video bg-gradient-to-br from-gray-200 to-gray-300 dark:from-gray-600 dark:to-gray-700 relative">
                  {cardUrl && (
                    <LazyImage
                      src={cardUrl}
                      alt={`${merchant.name} card`}
                      width={640}
                      height={360}
                      eager
                      className="w-full h-full"
                    />
                  )}
                </div>

                {/* Logo overlapping card image */}
                <div className="flex justify-start -mt-10 px-6 mb-4 relative z-20">
                  <div className="w-20 h-20 bg-gray-50 dark:bg-gray-700 rounded-lg border-[3px] border-white dark:border-gray-800 shadow-md flex items-center justify-center overflow-hidden">
                    {logoUrl ? (
                      <LazyImage
                        src={logoUrl}
                        alt={`${merchant.name} logo`}
                        width={80}
                        height={80}
                        eager
                        className="w-full h-full"
                      />
                    ) : (
                      <span className="text-gray-400 text-xl font-bold">
                        {merchant.name.charAt(0)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="p-6 pt-0">
                  <PurchaseContainer merchant={merchant} />
                </div>
              </div>

              {/* Features */}
              <div className="grid grid-cols-3 gap-4 text-center px-4">
                <div className="flex flex-col items-center">
                  <svg
                    className="w-6 h-6 text-gray-500 dark:text-gray-400 mb-2"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13 10V3L4 14h7v7l9-11h-7z"
                    />
                  </svg>
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                    Instant Delivery
                  </span>
                </div>
                <div className="flex flex-col items-center">
                  <svg
                    className="w-6 h-6 text-gray-500 dark:text-gray-400 mb-2"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    strokeWidth="2"
                  >
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <circle cx="12" cy="16" r="1" />
                    <path d="m7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                    Private & Secure
                  </span>
                </div>
                <div className="flex flex-col items-center">
                  <svg
                    className="w-6 h-6 text-gray-500 dark:text-gray-400 mb-2"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                    Save with Crypto
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Left column — Merchant info */}
          <div className="lg:w-3/5 xl:w-1/2 2xl:w-3/5 lg:order-1">
            {/* Desktop: merchant name + badges (hidden on mobile since purchase card shows it) */}
            <div className="hidden lg:block mb-8">
              <div className="flex items-center gap-6 mb-4">
                {logoUrl && (
                  <div className="w-24 h-24 bg-gray-50 dark:bg-gray-800 rounded-lg border-[3px] border-white dark:border-gray-700 shadow-md flex items-center justify-center overflow-hidden flex-shrink-0">
                    <LazyImage
                      src={logoUrl}
                      alt={`${merchant.name} logo`}
                      width={96}
                      height={96}
                      eager
                      className="w-full h-full"
                    />
                  </div>
                )}
                <div>
                  <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
                    {merchant.name} Gift Card
                  </h1>
                  <div className="flex flex-wrap gap-2">
                    {savings !== undefined && savings > 0 && (
                      <span className="bg-green-500 text-white px-3 py-1 rounded-full text-sm font-medium">
                        {savings.toFixed(1)}% savings
                      </span>
                    )}
                    {merchant.denominations?.type === 'min-max' &&
                      merchant.denominations.min !== undefined &&
                      merchant.denominations.max !== undefined && (
                        <span className="bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 px-3 py-1 rounded-full text-sm font-medium">
                          ${merchant.denominations.min}&ndash;${merchant.denominations.max}
                        </span>
                      )}
                  </div>
                </div>
              </div>
            </div>

            {/* Mobile: simple title (desktop has the detailed header above) */}
            <div className="lg:hidden mb-4">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                {merchant.name} Gift Card
              </h1>
              {savings !== undefined && savings > 0 && (
                <p className="text-green-600 font-semibold mt-1">Save {savings.toFixed(1)}%</p>
              )}
            </div>

            {/* About section */}
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 lg:p-8 mb-8">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
                About {merchant.name}
              </h2>

              {merchant.denominations && (
                <div className="mb-4">
                  {merchant.denominations.type === 'fixed' &&
                  merchant.denominations.denominations.length > 0 ? (
                    <div>
                      <span className="font-medium text-gray-900 dark:text-white text-sm">
                        Available Denominations:
                      </span>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {merchant.denominations.denominations.map((d) => (
                          <span
                            key={d}
                            className="bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 px-2 py-1 rounded text-sm"
                          >
                            ${d}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : merchant.denominations.type === 'min-max' &&
                    merchant.denominations.min !== undefined &&
                    merchant.denominations.max !== undefined ? (
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                      <span className="font-medium text-gray-900 dark:text-white">Range:</span> $
                      {merchant.denominations.min} &ndash; ${merchant.denominations.max}{' '}
                      {merchant.denominations.currency}
                    </p>
                  ) : null}
                </div>
              )}

              {merchant.description ? (
                <div className="text-gray-600 dark:text-gray-300 space-y-3 leading-relaxed text-sm">
                  {merchant.description.split('\n\n').map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 dark:text-gray-400 text-sm">
                  Purchase a {merchant.name} gift card and save with crypto. Delivered instantly to
                  your device.
                </p>
              )}
            </div>

            {merchant.instructions && (
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 lg:p-8 mb-8">
                <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
                  How to redeem
                </h2>
                <div className="text-gray-600 dark:text-gray-300 text-sm leading-relaxed whitespace-pre-wrap">
                  {merchant.instructions}
                </div>
              </div>
            )}

            {merchant.terms && (
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 lg:p-8 mb-8">
                <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
                  Terms & conditions
                </h2>
                <p className="text-gray-500 dark:text-gray-400 text-xs leading-relaxed whitespace-pre-wrap">
                  {merchant.terms}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {!isNative && <Footer />}
    </div>
  );
}
