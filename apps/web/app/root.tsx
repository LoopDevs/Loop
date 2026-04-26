import { useEffect, useState, lazy, Suspense } from 'react';
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
} from 'react-router';
import { QueryClient, QueryCache, MutationCache, QueryClientProvider } from '@tanstack/react-query';
import * as Sentry from '@sentry/react';
import { scrubSentryEvent } from '~/utils/sentry-scrubber';
import { scrubErrorForSentry } from '~/utils/sentry-error-scrubber';
import { forwardQueryErrorToSentry } from '~/utils/query-error-reporting';
import type { Route } from './+types/root';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { useSessionRestore } from '~/hooks/use-session-restore';
import { setStatusBarOverlay, setStatusBarStyle } from '~/native/status-bar';
import { registerBackButton } from '~/native/back-button';
import { registerAppLockGuard } from '~/native/app-lock';
import { getPlatform } from '~/native/platform';
import { setupNotificationChannels } from '~/native/notifications';
import { setKeyboardAccessoryBarVisible } from '~/native/keyboard';
import { OfflineBanner } from '~/components/ui/OfflineBanner';
import { NativeBackButton } from '~/components/features/NativeBackButton';
import { ToastContainer } from '~/components/ui/ToastContainer';
import { useAuthStore } from '~/stores/auth.store';
import { useUiStore } from '~/stores/ui.store';
import { buildSecurityHeaders } from '~/utils/security-headers';
import { shouldRetry } from '~/hooks/query-retry';
import { NativeTabBar } from '~/components/features/NativeTabBar';
import { fetchAllMerchants } from '~/services/merchants';
import './app.css';

const Onboarding = lazy(() =>
  import('~/components/features/onboarding/Onboarding').then((m) => ({ default: m.Onboarding })),
);

// Initialize Sentry on client side
if (typeof window !== 'undefined' && import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    // A2-1310: prefer the explicit `VITE_LOOP_ENV` deploy tag so a
    // staging build bucketed as `MODE=production` can still report
    // events as `staging`. Falls back to `MODE` so existing deploys
    // without the env var set continue to behave as before.
    environment: (import.meta.env.VITE_LOOP_ENV as string | undefined) ?? import.meta.env.MODE,
    // A2-1309: release tag pivots a Sentry event back to the deploy
    // artifact. CI/CD sets `VITE_SENTRY_RELEASE` to the git SHA at
    // build time; left unset on dev so Sentry omits the attribute.
    ...(import.meta.env.VITE_SENTRY_RELEASE !== undefined &&
    import.meta.env.VITE_SENTRY_RELEASE !== ''
      ? { release: import.meta.env.VITE_SENTRY_RELEASE as string }
      : {}),
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
    // A2-1308: scrub known-secret keys out of every captured event.
    // Mirror of the backend Sentry init; utility is duplicated across
    // apps/web and apps/backend (they don't share a build).
    beforeSend: (event) => scrubSentryEvent(event),
  });
}

// A2-1322: forward unexpected TanStack Query / Mutation failures into
// Sentry. Before this hook, call-site `onError` was the only way errors
// reached Sentry — and nothing in the codebase did that, so broken admin
// shapes and backend 500s passed silently. The filter in
// `forwardQueryErrorToSentry` skips expected 4xx outcomes (401 on an
// admin surface visited by a non-admin, 422 on a validation denial, etc.)
// so Sentry signal stays meaningful.
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err, query) => {
      forwardQueryErrorToSentry(err, { source: 'tanstack-query', key: query.queryKey }, Sentry);
    },
  }),
  mutationCache: new MutationCache({
    onError: (err, _vars, _ctx, mutation) => {
      forwardQueryErrorToSentry(
        err,
        { source: 'tanstack-mutation', key: mutation.options.mutationKey },
        Sentry,
      );
    },
  }),
  defaultOptions: {
    queries: {
      // Use the shared retry predicate as the default so any new hook
      // picks up the right behaviour without having to opt in: don't
      // retry 4xx (won't become 2xx on retry — 400 stays 400, 429 means
      // back off), up to 2 retries for 5xx / timeout / network. Every
      // existing hook also sets `retry: shouldRetry` explicitly — those
      // stay valid and win by explicit override.
      retry: shouldRetry,
      staleTime: 5 * 60 * 1000,
    },
  },
});

// Merchant catalog cold-start cache. The app shell is on disk (no
// network), but the catalog itself is fetched from api.loopfinance.io.
// Persist the last-known response to localStorage so the home route
// renders instantly on cold start with whatever we saw last, while a
// background refetch updates the cache. Worst case on a brand-new
// install is one network round-trip before home has data — same as
// before this cache existed.
const MERCHANTS_CACHE_KEY = 'loop_merchants_all_v1';
const MERCHANTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
interface MerchantsCacheEntry {
  ts: number;
  data: Awaited<ReturnType<typeof fetchAllMerchants>>;
}
if (typeof window !== 'undefined') {
  // Seed queryClient from disk cache synchronously so the very first
  // render of home has data. Mark the entry with an old
  // `dataUpdatedAt` so it's treated as stale — the background
  // prefetch below still fires to revalidate, and mounting
  // useAllMerchants returns the cached data instantly. Quietly skip
  // malformed entries.
  try {
    const raw = localStorage.getItem(MERCHANTS_CACHE_KEY);
    if (raw !== null) {
      const entry = JSON.parse(raw) as MerchantsCacheEntry;
      if (
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.ts === 'number' &&
        Date.now() - entry.ts < MERCHANTS_CACHE_TTL_MS
      ) {
        queryClient.setQueryData(['merchants-all'], entry.data, {
          // dataUpdatedAt in the past so TanStack considers the entry
          // stale — triggers a background refetch while still
          // returning cached data to subscribers.
          updatedAt: entry.ts,
        });
      }
    }
  } catch {
    /* corrupt or unavailable — ignore */
  }

  // Revalidate in the background. On a cache hit, home still shows
  // instantly with the stale data; the cache update on success is
  // picked up by subscribed useAllMerchants consumers.
  void queryClient.prefetchQuery({
    queryKey: ['merchants-all'],
    queryFn: async () => {
      const data = await fetchAllMerchants();
      try {
        const entry: MerchantsCacheEntry = { ts: Date.now(), data };
        localStorage.setItem(MERCHANTS_CACHE_KEY, JSON.stringify(entry));
      } catch {
        /* quota or disabled — ignore */
      }
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });
}

// A2-1108 + A2-1112: root-level OpenGraph + Twitter card defaults so
// every Loop URL surfaces a sensible preview when shared (Slack /
// Discord / WhatsApp / Twitter unfurls). Per-route `meta()` can
// override individual entries (sitemap, privacy, terms) — these are
// the fallback for routes that don't.
const SITE_URL = 'https://loopfinance.io';
const OG_DEFAULT_TITLE = 'Loop — Save money every time you shop';
const OG_DEFAULT_DESCRIPTION =
  'Buy discounted gift cards with XLM and earn cashback on every purchase.';
const OG_DEFAULT_IMAGE = `${SITE_URL}/loop-logo.svg`;

export function meta(): Route.MetaDescriptors {
  return [
    { title: OG_DEFAULT_TITLE },
    { name: 'description', content: OG_DEFAULT_DESCRIPTION },
    // OpenGraph (Facebook / LinkedIn / Slack / Discord)
    { property: 'og:type', content: 'website' },
    { property: 'og:site_name', content: 'Loop' },
    { property: 'og:title', content: OG_DEFAULT_TITLE },
    { property: 'og:description', content: OG_DEFAULT_DESCRIPTION },
    { property: 'og:url', content: SITE_URL },
    { property: 'og:image', content: OG_DEFAULT_IMAGE },
    // Twitter card
    { name: 'twitter:card', content: 'summary' },
    { name: 'twitter:title', content: OG_DEFAULT_TITLE },
    { name: 'twitter:description', content: OG_DEFAULT_DESCRIPTION },
    { name: 'twitter:image', content: OG_DEFAULT_IMAGE },
  ];
}

// Inter is fetched from Google Fonts at page load. This is a documented and
// accepted third-party runtime dependency — see
// `docs/adr/005-known-limitations.md` §10. Allowlisted in CSP by
// `buildSecurityHeaders`. Audit A-032.
export const links: Route.LinksFunction = () => [
  // A2-001 / A2-004: SVG favicon is the canonical icon. Modern
  // browsers (Chrome 80+, Firefox 41+, Safari 9+) all support
  // SVG favicons; older fallbacks aren't load-bearing pre-launch.
  // The .ico / .png variants stayed at 0 bytes for the entire
  // audit window — link to the populated SVG instead so the tab
  // icon actually renders.
  { rel: 'icon', type: 'image/svg+xml', href: '/loop-favicon.svg' },
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap',
  },
];

export function Layout({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Re-apply the theme class after hydration. React 19's hydration can
  // strip attributes that were added to <html> between SSR and client
  // mount — in our case the inline `__html` script below adds a
  // `dark` / `light` class before body paints, and React has been
  // observed to remove it on hydration (visible as the page flashing
  // from dark to unstyled). This effect runs once and asserts whatever
  // class the user's stored preference resolves to. No-op when the
  // class is already correct.
  useEffect(() => {
    const stored = (() => {
      try {
        return localStorage.getItem('theme');
      } catch {
        return null;
      }
    })();
    const prefersDark =
      typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = stored === 'dark' || (stored !== 'light' && prefersDark);
    const next = isDark ? 'dark' : 'light';
    const el = document.documentElement;
    if (!el.classList.contains(next)) {
      el.classList.remove('light', 'dark');
      el.classList.add(next);
    }
  }, []);

  // Audit A-027 — CSP is emitted via <meta http-equiv> because RR v7 SPA
  // mode (our mobile static export) rejects a route-module `headers`
  // export and the build fails. HTTP headers that can't live in meta
  // (X-Frame-Options, HSTS, Permissions-Policy, etc.) are applied at
  // the deploy edge — Fly.io's `force_https=true` already delivers
  // HSTS-equivalent. `buildSecurityHeaders` is the single source of
  // truth, locked by `security-headers.test.ts`.
  //
  // A subset of CSP directives — `frame-ancestors`, `report-uri`,
  // `sandbox` — are explicitly ignored by browsers when delivered via
  // meta, and Chrome logs a console.error every page load. That breaks
  // the smoke e2e's `expect(consoleErrors).toHaveLength(0)` assertion
  // and adds noise for operators reading devtools. Strip those
  // directives from the meta-emitted string; clickjacking defense on
  // web comes from `X-Frame-Options: DENY` which the edge must deliver
  // as an HTTP header (tracked alongside the other non-meta headers
  // above), and the Capacitor webview doesn't need frame-ancestors.
  const fullCsp = buildSecurityHeaders({
    apiOrigin:
      typeof import.meta.env !== 'undefined' && import.meta.env['VITE_API_URL']
        ? (import.meta.env['VITE_API_URL'] as string)
        : 'https://api.loopfinance.io',
  })['Content-Security-Policy'];
  const csp = fullCsp
    ?.split(';')
    .map((d) => d.trim())
    .filter((d) => !/^(frame-ancestors|report-uri|sandbox)\b/.test(d))
    .join('; ');
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        {csp !== undefined && <meta httpEquiv="Content-Security-Policy" content={csp} />}
        <meta name="referrer" content="strict-origin-when-cross-origin" />
        {/* Viewport intentionally omits `maximum-scale=1, user-scalable=no`.
         * Those two disable pinch-zoom, which fails WCAG SC 1.4.4 (Resize
         * Text): a low-vision user on mobile web loopfinance.io must be
         * able to zoom text up to 200%. Capacitor's native webview is
         * fine without the restriction — users don't typically pinch-
         * zoom inside an app and the layout is responsive, so
         * accidentally zooming just reflows cleanly. `viewport-fit=cover`
         * stays so safe-area insets still work on notched devices. */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
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

  // Drive `--status-bar-intensity` from scroll position. Consumed by
  // the `html.native body::before` gradient in app.css to darken the
  // top-of-page backdrop the further the user has scrolled — at rest
  // the tint is subtle so the content behind peeks through, and once
  // page chrome is gone (scrolled past the hero) the tint intensifies
  // so status bar icons stay legible.
  useEffect(() => {
    const update = (): void => {
      const progress = Math.min(1, Math.max(0, window.scrollY / 50));
      document.documentElement.style.setProperty('--status-bar-intensity', String(progress));
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  // Measure the real Navbar + bottom TabBar heights and expose them as
  // `--nav-height` / `--tab-height` so overlay UI (e.g. MapBottomSheet)
  // can sit exactly between them on any device. Hard-coded rem values
  // don't account for the iOS safe-area inset or dynamic layout
  // changes (search open / closed). ResizeObserver fires whenever the
  // observed element resizes for any reason — safe-area change,
  // orientation flip, search expand, tab bar show/hide at lg.
  //
  // Both bars share `nav.fixed` as a selector, so we disambiguate on
  // vertical position: the one at top-0 is the Navbar, the one at
  // bottom-0 is the TabBar.
  useEffect(() => {
    const topNav = document.querySelector('nav[data-nav="top"]') as HTMLElement | null;
    const bottomNav = document.querySelector('nav[data-nav="tab"]') as HTMLElement | null;
    const root = document.documentElement;
    const update = (): void => {
      if (topNav !== null) {
        root.style.setProperty('--nav-height', `${topNav.getBoundingClientRect().height}px`);
      }
      // Tab bar is display:none at lg — clientHeight is 0 then; callers
      // can treat `--tab-height` as 0 in that case.
      const tabH = bottomNav !== null ? bottomNav.getBoundingClientRect().height : 0;
      root.style.setProperty('--tab-height', `${tabH}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    if (topNav !== null) ro.observe(topNav);
    if (bottomNav !== null) ro.observe(bottomNav);
    // Also re-measure on viewport resize so the lg breakpoint flip
    // (tab bar display:none ↔ flex) is reflected immediately.
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => {
    if (!isNative) return;
    document.documentElement.classList.add('native');
    void setStatusBarOverlay();
    // Match status bar to current theme
    const isDark = document.documentElement.classList.contains('dark');
    void setStatusBarStyle(isDark ? 'dark' : 'light');

    // Android back button — returns a disposer we MUST call on
    // unmount. Without it, every NativeShell re-mount (sign-out /
    // sign-in, onboarding ↔ home) stacks another listener and a
    // single back gesture fires all of them, popping multiple
    // history entries at once (i.e. /gift-card → /orders/:id
    // instead of /gift-card → /).
    const cleanupBackButton = registerBackButton();

    // iOS: enable keyboard accessory bar (Done/Previous/Next). Wrapper
    // lives in app/native/ so the @capacitor/keyboard import does not
    // sit in root.tsx (audit A-005 — Capacitor boundary compliance).
    void setKeyboardAccessoryBarVisible(true);

    // Android: set up notification channels
    if (getPlatform() === 'android') {
      void setupNotificationChannels();
    }

    return () => {
      cleanupBackButton();
    };
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
      <div
        className={
          isNative
            ? 'native-safe-page native-tab-clearance'
            : // Web at mobile widths also renders the tab bar below,
              // so reserve the same bottom space there too; lg+ hides
              // the tab bar (CSS) and we drop the padding.
              'lg:pb-0 pb-16'
        }
      >
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
  // Pins the onboarding UI once we enter it so a mid-flow
  // `setSession` (fired by the OTP-verify step) doesn't flip the
  // outer gate and yank the user past the welcome-in payoff. Unpins
  // only when the user taps "Open Loop" (`onComplete`).
  const [onboardingInFlight, setOnboardingInFlight] = useState(false);

  // Any native user without a session lands in onboarding. Entering is
  // the signal — the pin then keeps the flow mounted until explicit
  // completion. If the user signs out later, isAuthenticated flips,
  // this effect fires, and onboarding re-enters.
  useEffect(() => {
    if (isNative && !isAuthenticated && !isRestoring && !onboardingInFlight) {
      setOnboardingInFlight(true);
    }
  }, [isNative, isAuthenticated, isRestoring, onboardingInFlight]);

  // On native: strict auth gate. Previous behaviour was optimistic
  // — if the user had a prior-session hint, we'd render home while
  // the background refresh raced to validate the token. A user
  // with an expired refresh token could browse unauthenticated for
  // the duration of the refresh, then get kicked to onboarding
  // mid-task. Now: splash while restoring, onboarding immediately
  // if the refresh determines unauth. Trade-off is a ~0.5-1s
  // splash on cold start (the refresh is kicked off at module-
  // load so the wall-clock is short), but no browse-before-kick
  // window.
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

    // Render onboarding whenever we're unauthenticated OR we're
    // still pinned mid-flow. `onboardingInFlight` stays true across
    // the OTP-success render so the user sees the welcome-in payoff
    // before the shell takes over — without it, `isAuthenticated`
    // would flip true and yank them to home mid-screen.
    if (!isAuthenticated || onboardingInFlight) {
      return (
        <QueryClientProvider client={queryClient}>
          <Suspense fallback={<NativeSplash />}>
            <Onboarding onComplete={() => setOnboardingInFlight(false)} />
          </Suspense>
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
  // Report to Sentry — inside useEffect so a re-render triggered by (say) a
  // parent provider change doesn't fire a duplicate capture for the same
  // error. React Router remounts the boundary on a new error, so the
  // [error]-keyed effect fires exactly once per distinct failure.
  //
  // A2-1312: React Router loader errors can carry `Response` payloads
  // (`throw new Response(await res.text(), { status: 500 })`) — the
  // body would then land in Sentry as a serialised string field. The
  // scrubber strips `.response` / `.cause` when they're `Response` /
  // `Request`, and redacts email / bearer / stellar-secret shapes
  // out of the error message before Sentry sees it.
  useEffect(() => {
    Sentry.captureException(scrubErrorForSentry(error));
  }, [error]);

  let message = 'Oops!';
  let details = 'An unexpected error occurred.';
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    // A2-1103: 403 gets its own dedicated copy so users hitting an
    // admin route they aren't allowed in see "you don't have access"
    // rather than the generic "page could not be found" 404 fallback.
    // The admin shell (RequireAdmin) handles its own banner without
    // throwing, but loaders/actions are free to `throw new Response(…,
    // { status: 403 })` and this branch will catch them with the
    // right copy.
    if (error.status === 404) {
      message = '404';
      details = 'The requested page could not be found.';
    } else if (error.status === 403) {
      message = '403';
      details = "You don't have access to this page.";
    } else if (error.status === 401) {
      message = '401';
      details = 'You need to sign in to view this page.';
    } else {
      message = 'Error';
      details = error.statusText ?? details;
    }
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
