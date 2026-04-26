import { useNavigate } from 'react-router';
import { Navbar } from '~/components/features/Navbar';
import { Button } from '~/components/ui/Button';
import { useNativePlatform } from '~/hooks/use-native-platform';

// Plain literal — Route types from `./+types/not-found` only exist
// in the mobile typegen output (this file is the mobile-build splat).
// The SSR build's typegen never sees this route since `routes.ts`
// switches the splat to `not-found-ssr.tsx`. Avoid the conditional
// import; the meta shape is small enough to inline.
export function meta(): Array<{ title: string }> {
  return [{ title: 'Page not found — Loop' }];
}

// A2-1111: pure component, no loader. SPA mode (mobile static export)
// rejects `loader` exports — RR v7 fails the build with
// "SPA Mode: invalid route export(s)". The SSR build wires the splat
// to `not-found-ssr.tsx` instead, which has the loader that throws a
// real HTTP 404 for crawlers / uptime checkers; this file is the
// mobile-build splat route and exports the shared 404 UI.
export function NotFoundContent(): React.JSX.Element {
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

export default function NotFoundRoute(): React.JSX.Element {
  return <NotFoundContent />;
}
