import { useEffect } from 'react';
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Route } from './+types/root';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { NativeTabBar } from '~/components/features/NativeTabBar';
import { setStatusBarOverlay, setStatusBarStyle } from '~/native/status-bar';
import { registerBackButton } from '~/native/back-button';
import { OfflineBanner } from '~/components/ui/OfflineBanner';
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
            __html: `(function(){try{var t=localStorage.getItem('theme'),d=window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.add(t==='dark'||(t===null&&d)?'dark':'light');}catch(e){document.documentElement.classList.add('light');}})();`,
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

  return (
    <>
      <OfflineBanner />
      {isNative && <div className="native-safe-top" />}
      <div className={isNative ? 'native-tab-clearance' : ''}>{children}</div>
      <NativeTabBar />
    </>
  );
}

export default function App(): React.JSX.Element {
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
