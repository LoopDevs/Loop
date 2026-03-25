import { useEffect } from 'react';
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
} from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Route } from './+types/root';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { useSessionRestore } from '~/hooks/use-session-restore';
import { NativeTabBar } from '~/components/features/NativeTabBar';
import { setStatusBarOverlay, setStatusBarStyle } from '~/native/status-bar';
import { registerBackButton } from '~/native/back-button';
import { registerAppLockGuard } from '~/native/app-lock';
import { OfflineBanner } from '~/components/ui/OfflineBanner';
import { NativeBackButton } from '~/components/features/NativeBackButton';
import { Spinner } from '~/components/ui/Spinner';
import { useUiStore } from '~/stores/ui.store';
import './app.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5 * 60 * 1000,
    },
  },
});

export function meta(): Route.MetaDescriptors {
  return [
    { title: 'Loop — Save money every time you shop' },
    { name: 'description', content: 'Buy discounted gift cards and earn cashback with Loop.' },
  ];
}

export const links: Route.LinksFunction = () => [
  { rel: 'icon', href: '/loop-favicon.ico' },
  { rel: 'icon', type: 'image/png', href: '/loop-favicon.png' },
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap',
  },
];

export function Layout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no"
        />
        {/* Inline theme init prevents flash of unstyled content */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;var isDark=(t==='dark')||(t!=='light'&&d);document.documentElement.classList.add(isDark?'dark':'light');}catch(e){document.documentElement.classList.add('light');}})();`,
          }}
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

function NativeShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { isNative } = useNativePlatform();
  const location = useLocation();

  useEffect(() => {
    if (isNative) {
      document.documentElement.classList.add('native');
      void setStatusBarOverlay();
      // Match status bar to current theme
      const isDark = document.documentElement.classList.contains('dark');
      void setStatusBarStyle(isDark ? 'dark' : 'light');
      registerBackButton();
    }
  }, [isNative]);

  // Register biometric app lock guard on native
  useEffect(() => {
    if (!isNative) return;
    const cleanupAppLock = registerAppLockGuard();
    return () => {
      cleanupAppLock();
    };
  }, [isNative]);

  // Update status bar when theme changes
  useEffect(() => {
    if (!isNative) return;

    const observer = new MutationObserver(() => {
      const isDark = document.documentElement.classList.contains('dark');
      void setStatusBarStyle(isDark ? 'dark' : 'light');
    });

    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [isNative]);

  // Listen for system theme changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (): void => {
      const { themePreference, setThemePreference } = useUiStore.getState();
      if (themePreference === 'system') {
        // Re-resolve system theme
        setThemePreference('system');
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return (
    <>
      <OfflineBanner />
      <NativeBackButton />
      {isNative && <div className="native-safe-top" />}
      <div className={isNative ? 'native-tab-clearance' : ''}>
        {isNative ? (
          <div key={location.pathname} className="route-enter">
            {children}
          </div>
        ) : (
          children
        )}
      </div>
      <NativeTabBar />
    </>
  );
}

export default function App(): React.JSX.Element {
  const { isRestoring } = useSessionRestore();

  if (isRestoring) {
    return (
      <QueryClientProvider client={queryClient}>
        <div className="flex items-center justify-center min-h-screen">
          <Spinner />
        </div>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <NativeShell>
        <Outlet />
      </NativeShell>
    </QueryClientProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps): React.JSX.Element {
  let message = 'Oops!';
  let details = 'An unexpected error occurred.';
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? '404' : 'Error';
    details =
      error.status === 404
        ? 'The requested page could not be found.'
        : (error.statusText ?? details);
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack !== undefined && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
