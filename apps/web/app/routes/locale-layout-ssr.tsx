import { isRouteErrorResponse, useRouteError } from 'react-router';
import { isSupportedCountryCode, isSupportedLang } from '@loop/shared';
import type { Route } from './+types/locale-layout-ssr';
import { NotFoundContent } from './not-found';

export { LocaleLayout as default } from './locale-layout';

/**
 * ADR 034 locale layout (`/:country/:lang/*`) — SSR variant. The loader
 * validates the locale segments and throws a real HTTP 404 for an unrouted
 * country/language so crawlers and uptime checks see the right status (mirrors
 * `not-found-ssr.tsx`). No data fetch — pure param validation, so this is not a
 * loader-fetch exception to the pure-API-client rule. SPA mode rejects `loader`
 * exports, so the mobile build wires `locale-layout.tsx` (component-only)
 * instead via `BUILD_TARGET` in `routes.ts`.
 */
export function loader({ params }: Route.LoaderArgs): null {
  if (!isSupportedCountryCode(params.country) || !isSupportedLang(params.lang)) {
    throw new Response(null, { status: 404, statusText: 'Not Found' });
  }
  return null;
}

// Render the shared 404 UI for the loader's locale-not-found Response. Any other
// error (e.g. a 500 thrown by a nested child route) is re-thrown so it bubbles to
// the parent boundary instead of being masked as a 404.
export function ErrorBoundary(): React.JSX.Element {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundContent />;
  }
  throw error;
}
