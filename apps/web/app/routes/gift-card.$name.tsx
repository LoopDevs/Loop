import { useParams, Link } from 'react-router';
import type { Route } from './+types/gift-card.$name';
import { useMerchantBySlug } from '~/hooks/use-merchants';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { Navbar } from '~/components/features/Navbar';
import { Footer } from '~/components/features/Footer';
import { PurchaseContainer } from '~/components/features/purchase/PurchaseContainer';
import { Spinner } from '~/components/ui/Spinner';
import { getImageProxyUrl } from '~/utils/image';

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  const name = decodeURIComponent(params.name ?? '').replace(/-/g, ' ');
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
        <h1 className="text-2xl font-bold mb-4">Merchant not found</h1>
        <Link to="/" className="text-primary underline">
          Back to home
        </Link>
      </div>
    );
  }

  const savings = merchant.savingsPercentage;
  const logoUrl = merchant.logoUrl ? getImageProxyUrl(merchant.logoUrl, 400) : undefined;

  return (
    <div>
      {!isNative && <Navbar />}

      <div className="container mx-auto px-4 py-8 lg:py-12 max-w-5xl">
        <div className="flex items-center gap-4 mb-8">
          {logoUrl !== undefined && (
            <img
              src={logoUrl}
              alt={`${merchant.name} logo`}
              className="w-16 h-16 object-contain rounded-lg"
            />
          )}
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{merchant.name}</h1>
            {savings !== undefined && savings > 0 && (
              <p className="text-green-600 font-semibold">Save {savings.toFixed(1)}%</p>
            )}
          </div>
        </div>

        <PurchaseContainer merchant={merchant} />

        {merchant.description !== undefined && (
          <div className="mt-8 prose dark:prose-invert max-w-none">
            <p className="text-gray-600 dark:text-gray-300">{merchant.description}</p>
          </div>
        )}
      </div>

      {!isNative && <Footer />}
    </div>
  );
}
