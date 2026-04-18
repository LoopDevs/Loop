import { useEffect, lazy, Suspense } from 'react';
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
import * as Sentry from '@sentry/react';
import type { Route } from './+types/root';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { useSessionRestore } from '~/hooks/use-session-restore';
import { NativeTabBar } from '~/components/features/NativeTabBar';
import { setStatusBarOverlay, setStatusBarStyle } from '~/native/status-bar';
import { registerBackButton } from '~/native/back-button';
import { registerAppLockGuard } from '~/native/app-lock';
import { getPlatform } from '~/native/platform';
import { setupNotificationChannels } from '~/native/notifications';
import { OfflineBanner } from '~/components/ui/OfflineBanner';
import { NativeBackButton } from '~/components/features/NativeBackButton';
import { ToastContainer } from '~/components/ui/ToastContainer';
import { useAuthStore } from '~/stores/auth.store';
import { useUiStore } from '~/stores/ui.store';
import { buildSecurityHeaders } from '~/utils/security-headers';
import './app.css';

const AuthRoute = lazy(() => import('~/routes/auth'));

// Initialize Sentry on client side
if (typeof window !== 'undefined' && import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
  });
}

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
    { name: 'description', content: 'Buy discounted gift cards with XLM on Loop.' },
  ];
}

// Inter is fetched from Google Fonts at page load. This is a documented and
// accepted third-party runtime dependency — see
// `docs/adr/005-known-limitations.md` §10. Allowlisted in CSP by
// `buildSecurityHeaders`. Audit A-032.
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
  // Audit A-027 — CSP is emitted via <meta http-equiv> because RR v7 SPA
  // mode (our mobile static export) rejects a route-module `headers`
  // export and the build fails. HTTP headers that can't live in meta
  // (X-Frame-Options, HSTS, Permissions-Policy, etc.) are applied at
  // the deploy edge — Fly.io's `force_https=true` already delivers
  // HSTS-equivalent. `buildSecurityHeaders` is the single source of
  // truth, locked by `security-headers.test.ts`.
  const csp = buildSecurityHeaders({
    apiOrigin:
      typeof import.meta.env !== 'undefined' && import.meta.env['VITE_API_URL']
        ? (import.meta.env['VITE_API_URL'] as string)
        : 'https://api.loopfinance.io',
  })['Content-Security-Policy'];
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        {csp !== undefined && <meta httpEquiv="Content-Security-Policy" content={csp} />}
        <meta name="referrer" content="strict-origin-when-cross-origin" />
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

      // iOS: enable keyboard accessory bar (Done/Previous/Next)
      if (getPlatform() === 'ios') {
        void (async () => {
          try {
            const { Keyboard } = await import('@capacitor/keyboard');
            await Keyboard.setAccessoryBarVisible({ isVisible: true });
          } catch {
            /* Keyboard plugin not available */
          }
        })();
      }

      // Android: set up notification channels
      if (getPlatform() === 'android') {
        void setupNotificationChannels();
      }
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
      <ToastContainer />
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

function NativeSplash(): React.JSX.Element {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <img src="/loop-logo.svg" alt="Loop" className="h-10 animate-pulse dark:hidden" />
      <img src="/loop-logo-white.svg" alt="Loop" className="h-10 animate-pulse hidden dark:block" />
    </div>
  );
}

export default function App(): React.JSX.Element {
  const { isRestoring } = useSessionRestore();
  const { isNative } = useNativePlatform();
  const isAuthenticated = useAuthStore((s) => s.accessToken !== null);

  // On native: gate the entire app behind auth
  if (isNative) {
    if (isRestoring) {
      return (
        <QueryClientProvider client={queryClient}>
          <NativeShell>
            <NativeSplash />
          </NativeShell>
        </QueryClientProvider>
      );
    }

    if (!isAuthenticated) {
      return (
        <QueryClientProvider client={queryClient}>
          <NativeShell>
            <Suspense fallback={<NativeSplash />}>
              <AuthRoute />
            </Suspense>
          </NativeShell>
        </QueryClientProvider>
      );
    }
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
  // Report to Sentry
  if (typeof window !== 'undefined') {
    Sentry.captureException(error);
  }

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
