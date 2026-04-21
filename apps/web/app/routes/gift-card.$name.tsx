import { useParams, Link, useNavigate } from 'react-router';
import type { Route } from './+types/gift-card.$name';
import { useMerchantBySlug, useMerchant, useMerchantCashbackRate } from '~/hooks/use-merchants';
import { useAuth } from '~/hooks/use-auth';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { Navbar } from '~/components/features/Navbar';
import { Footer } from '~/components/features/Footer';
import { PurchaseContainer } from '~/components/features/purchase/PurchaseContainer';
import { Spinner } from '~/components/ui/Spinner';
import { LazyImage } from '~/components/ui/LazyImage';
import { getImageProxyUrl } from '~/utils/image';
import { currencySymbol } from '~/utils/money';

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
  const navigate = useNavigate();
  const { merchant: cachedMerchant, isLoading, isError } = useMerchantBySlug(name);
  const { isAuthenticated } = useAuth();
  // Enriched detail — authenticated CTX proxy call. Overwrites the
  // cached description / terms / instructions with long-form content
  // when the user is signed in. Kicks off only after we know the
  // merchant's id, and only on auth — 401s otherwise.
  const { merchant: enrichedMerchant } = useMerchant(cachedMerchant?.id ?? '', {
    enabled: isAuthenticated && cachedMerchant !== undefined,
  });
  const merchant = enrichedMerchant ?? cachedMerchant;

  // Cashback-rate preview (ADR 011 / 015). Hook must sit at the top
  // of the component so Rules-of-Hooks isn't broken by the early
  // returns below; pass the resolved id through, or an empty string
  // when the merchant hasn't loaded yet — the hook's internal
  // `enabled` guard skips the fetch in that case.
  const { userCashbackPct } = useMerchantCashbackRate(merchant?.id ?? '');

  const handleBack = (): void => {
    if (window.history.length > 1) {
      void navigate(-1);
    } else {
      void navigate('/');
    }
  };

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
  const logoUrl = merchant.logoUrl ? getImageProxyUrl(merchant.logoUrl, 160) : undefined;
  const savings = merchant.savingsPercentage;
  // Numeric(5,2) string from /cashback-rate (e.g. "2.50"). Parse for
  // the display formatter only — never coerce back to Number for
  // arithmetic; the contract is bigint-string-shape. Null when the
  // merchant has no active cashback config; the tile simply won't
  // render in that case.
  const cashbackPctNum = userCashbackPct !== null ? Number(userCashbackPct) : null;
  const cashbackPctShown =
    cashbackPctNum !== null && Number.isFinite(cashbackPctNum) && cashbackPctNum > 0
      ? cashbackPctNum
      : null;

  return (
    <div>
      {!isNative && <Navbar />}

      {/* Floating back button — native only. On web the Navbar (now
          shown at all widths) carries the home link + browser back
          button, so a second chevron would be clutter. */}
      {isNative && (
        <header
          className="fixed top-0 left-0 z-[1200] flex items-center gap-2 pl-3 pr-4 pointer-events-none"
          style={{ paddingTop: 'var(--safe-top)' }}
        >
          <button
            type="button"
            onClick={handleBack}
            aria-label="Back"
            className="pointer-events-auto h-10 w-10 rounded-full bg-black/45 text-white backdrop-blur-md shadow-lg flex items-center justify-center"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
              aria-hidden="true"
            >
              <path d="M15 18 9 12l6-6" />
            </svg>
          </button>
          <span className="text-white text-sm font-semibold drop-shadow max-w-[60vw] truncate">
            {merchant.name}
          </span>
        </header>
      )}

      {/* Hero — desktop-only backdrop. On mobile the purchase card
          below holds the cover image directly, so a second background
          image would just duplicate it. Classic dark-wash + wave
          divider so the sidebar purchase card peeks out of it. */}
      <div className="hidden lg:block relative h-96 overflow-hidden">
        {heroUrl ? (
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${heroUrl})` }}
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-blue-500 to-purple-600" />
        )}
        <div className="absolute inset-0 bg-black/60" />
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

      {/* Content. On desktop the container is pulled up with a sizable
          negative margin so the purchase card peeks into the hero
          backdrop behind it — classic "product card on banner" look.
          z-10 keeps the card in front of the hero. On mobile there
          is no container, no horizontal padding, no top gutter —
          the purchase card IS the top of the page. */}
      <div className="lg:container lg:mx-auto lg:px-4 lg:-mt-48 relative z-10">
        <div className="flex flex-col lg:flex-row lg:gap-8 mb-12">
          {/* Right column — Purchase card. On mobile the rounded /
              shadow / side-margin card chrome is stripped so the box
              flows straight off the hero above, edge to edge. On
              desktop the original rounded card with its own embedded
              card image + overlapping logo is preserved. */}
          <div className="lg:w-2/5 xl:w-1/2 2xl:w-2/5 lg:order-2">
            <div className="lg:sticky lg:top-24">
              <div className="bg-white dark:bg-gray-800 overflow-hidden mb-6 lg:rounded-xl lg:shadow-lg native-bleed-top lg:mt-0">
                {/* Card cover image — always rendered. Mobile overlays
                    logo + name on the image; desktop keeps the image
                    clean and places the logo below via -mt. */}
                <div className="relative aspect-video bg-gradient-to-br from-gray-200 to-gray-300 dark:from-gray-600 dark:to-gray-700">
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
                  {/* Mobile-only overlay: logo + name on the cover. */}
                  <div className="lg:hidden absolute inset-x-0 bottom-0 pt-10 pb-3 px-4 bg-gradient-to-t from-black/70 via-black/30 to-transparent flex items-center gap-3">
                    <div className="h-12 w-12 rounded-lg bg-white dark:bg-gray-900 shadow flex items-center justify-center overflow-hidden flex-shrink-0">
                      {logoUrl ? (
                        <LazyImage
                          src={logoUrl}
                          alt=""
                          width={80}
                          height={80}
                          eager
                          className="w-full h-full"
                        />
                      ) : (
                        <span className="text-gray-500 text-sm font-bold">
                          {merchant.name.charAt(0)}
                        </span>
                      )}
                    </div>
                    <h1 className="text-white text-lg font-bold drop-shadow truncate">
                      {merchant.name}
                    </h1>
                  </div>
                </div>

                {/* Desktop-only: logo overlapping below the card image. */}
                <div className="hidden lg:flex justify-start -mt-10 px-6 mb-4 relative z-20">
                  <div className="w-20 h-20 bg-gray-50 dark:bg-gray-700 rounded-lg shadow-md flex items-center justify-center overflow-hidden">
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

                <div className="p-6 lg:pt-0">
                  <PurchaseContainer merchant={merchant} />
                </div>
              </div>

              {/* Features — extra tiles (savings %, cashback %) render
                  only when the merchant has values for them. The grid
                  always stays centred; with 2–4 tiles that works out
                  of the box with `grid-cols-<n>`. Cashback tile is an
                  ADR 011 / 015 surface — when an admin configures a
                  merchant cashback-rate, users see it here before
                  committing to a purchase. */}
              <div
                className={`grid gap-4 text-center px-4 ${
                  ['grid-cols-2', 'grid-cols-3', 'grid-cols-4'][
                    (savings !== undefined && savings > 0 ? 1 : 0) +
                      (cashbackPctShown !== null ? 1 : 0)
                  ]
                }`}
              >
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
                {savings !== undefined && savings > 0 && (
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
                      {savings.toFixed(1)}% Savings
                    </span>
                  </div>
                )}
                {cashbackPctShown !== null && (
                  <div className="flex flex-col items-center">
                    <svg
                      className="w-6 h-6 text-green-600 dark:text-green-500 mb-2"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M10 21l2-9 9-2-11-10v21z"
                      />
                    </svg>
                    <span className="text-xs font-medium text-green-700 dark:text-green-400">
                      {cashbackPctShown.toFixed(2).replace(/\.0+$/, '')}% Cashback
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Left column — Merchant info */}
          <div className="lg:w-3/5 xl:w-1/2 2xl:w-3/5 lg:order-1 px-4 lg:px-0">
            {/* Desktop: merchant name + badges (hidden on mobile since purchase card shows it) */}
            <div className="hidden lg:block mb-8">
              <div className="flex items-center gap-6 mb-4">
                {logoUrl && (
                  <div className="w-24 h-24 bg-gray-50 dark:bg-gray-800 rounded-lg shadow-md flex items-center justify-center overflow-hidden flex-shrink-0">
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
                  <h1 className="text-3xl font-bold text-white mb-2 drop-shadow">
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
                          {currencySymbol(merchant.denominations.currency)}
                          {merchant.denominations.min} &ndash;{' '}
                          {currencySymbol(merchant.denominations.currency)}
                          {merchant.denominations.max}
                        </span>
                      )}
                  </div>
                </div>
              </div>
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
                            {currencySymbol(merchant.denominations!.currency)}
                            {d}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : merchant.denominations.type === 'min-max' &&
                    merchant.denominations.min !== undefined &&
                    merchant.denominations.max !== undefined ? (
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                      <span className="font-medium text-gray-900 dark:text-white">Range:</span>{' '}
                      {currencySymbol(merchant.denominations.currency)}
                      {merchant.denominations.min} &ndash;{' '}
                      {currencySymbol(merchant.denominations.currency)}
                      {merchant.denominations.max}
                    </p>
                  ) : null}
                </div>
              )}

              {merchant.description ? (
                <div className="text-gray-600 dark:text-gray-300 space-y-3 leading-relaxed text-sm">
                  {merchant.description
                    // Accept any run of newlines (with optional whitespace on
                    // blank lines) as a paragraph break. A strict `\n\n`
                    // split rendered \r\n\r\n sources and single-newline-only
                    // descriptions as one wall of text.
                    .split(/\n\s*\n+/)
                    .map((p) => p.trim())
                    .filter((p) => p.length > 0)
                    .map((p, i) => (
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
