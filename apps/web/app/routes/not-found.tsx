import { useNavigate } from 'react-router';
import type { Route } from './+types/not-found';
import { Navbar } from '~/components/features/Navbar';
import { Button } from '~/components/ui/Button';
import { useNativePlatform } from '~/hooks/use-native-platform';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Page not found — Loop' }];
}

// A2-1111: previously the splat route returned HTTP 200 with 404
// content (a "soft 404"), so crawlers and uptime checkers treated
// unknown URLs as successful pages. Throwing a 404 Response from
// the loader makes the SSR response carry the right status code,
// which RR v7 propagates through entry.server.tsx to the HTTP layer.
// Guarded on `typeof window === 'undefined'` so client-side navigation
// (Capacitor mobile + SPA after first load) keeps rendering the
// component normally — the throw is purely for the SSR/crawler path.
export function loader(_: Route.LoaderArgs): null {
  if (typeof window === 'undefined') {
    throw new Response(null, { status: 404, statusText: 'Not Found' });
  }
  return null;
}

function NotFoundContent(): React.JSX.Element {
  const { isNative } = useNativePlatform();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {!isNative && <Navbar />}
      <main className="flex items-center justify-center min-h-[80vh] px-4">
        <div className="text-center">
          <h1 className="text-6xl font-bold text-gray-300 dark:text-gray-700 mb-4">404</h1>
          <p className="text-xl text-gray-600 dark:text-gray-400 mb-6">Page not found</p>
          <Button
            onClick={() => {
              void navigate('/');
            }}
          >
            Go home
          </Button>
        </div>
      </main>
    </div>
  );
}

// Renders for the loader-thrown 404 (SSR / crawler path) so the
// dedicated 404 UI shows with HTTP 404 instead of the root
// ErrorBoundary's plain-text fallback.
export function ErrorBoundary(): React.JSX.Element {
  return <NotFoundContent />;
}

// Renders for client-side navigation to an unknown URL where the
// guarded loader returns null instead of throwing.
export default function NotFoundRoute(): React.JSX.Element {
  return <NotFoundContent />;
}
