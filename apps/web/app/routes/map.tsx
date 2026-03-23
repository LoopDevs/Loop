import { lazy, Suspense } from 'react';
import type { Route } from './+types/map';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { Navbar } from '~/components/features/Navbar';
import { Spinner } from '~/components/ui/Spinner';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Map — Loop' }];
}

// Dynamically import the map component — Leaflet requires browser APIs
const ClusterMap = lazy(() => import('~/components/features/ClusterMap'));

export function ErrorBoundary(): React.JSX.Element {
  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Map unavailable</h1>
        <p className="text-gray-600 dark:text-gray-300 mb-6">We couldn&apos;t load the map.</p>
        <a href="/map" className="text-blue-600 underline">
          Try again
        </a>
      </div>
    </div>
  );
}

export default function MapRoute(): React.JSX.Element {
  const { isNative } = useNativePlatform();

  return (
    <div className={`flex flex-col ${isNative ? 'native-full-height' : 'h-screen'}`}>
      {!isNative && <Navbar />}
      <div className="flex-1 relative">
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-full">
              <Spinner />
            </div>
          }
        >
          <ClusterMap />
        </Suspense>
      </div>
    </div>
  );
}
