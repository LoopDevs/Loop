import { useNavigate } from 'react-router';
import type { Route } from './+types/not-found';
import { Navbar } from '~/components/features/Navbar';
import { Button } from '~/components/ui/Button';
import { useNativePlatform } from '~/hooks/use-native-platform';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Page not found — Loop' }];
}

export default function NotFoundRoute(): React.JSX.Element {
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
