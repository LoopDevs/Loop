import type { Route } from './+types/not-found-ssr';
import { NotFoundContent } from './not-found';

// A2-1111: SSR-only splat route. The loader unconditionally throws a
// 404 Response so RR v7 propagates the status to the HTTP layer via
// `entry.server.tsx`. Crawlers and uptime checkers now see HTTP 404
// for unknown URLs instead of a "soft 404" (HTTP 200 with 404 content).
//
// SPA mode rejects `loader` exports, so this file is only wired into
// `routes.ts` when `BUILD_TARGET !== 'mobile'`. The mobile build uses
// `routes/not-found.tsx` (component-only) for client-side fallback.
export function loader(_: Route.LoaderArgs): never {
  throw new Response(null, { status: 404, statusText: 'Not Found' });
}

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Page not found — Loop' }];
}

// Renders for the loader-thrown 404 so the dedicated 404 UI shows
// with HTTP 404 instead of the root ErrorBoundary's plain-text fallback.
export function ErrorBoundary(): React.JSX.Element {
  return <NotFoundContent />;
}

// The default export is required by RR but never rendered — the
// loader always throws before the component would mount.
export default function NotFoundSsrRoute(): React.JSX.Element {
  return <NotFoundContent />;
}
