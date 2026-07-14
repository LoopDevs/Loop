import { isRouteErrorResponse, useRouteError } from 'react-router';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/cashback.$slug-ssr';
import i18n from '~/i18n/i18next';
import { normalizeLocale } from '~/i18n/locale';
import { getPublicMerchant } from '~/services/public-stats';
import { NotFoundContent } from './not-found';
import CashbackMerchantLanding, {
  meta as baseMeta,
  ErrorBoundary as BaseErrorBoundary,
} from './cashback.$slug';

export default CashbackMerchantLanding;

/**
 * P2-10/P2-11: `/cashback/:slug` — SSR variant. The component (mobile build)
 * resolves the slug client-side and renders a "merchant not available" page on
 * a 404, which SSR served with **HTTP 200** — a soft-404 crawlers then indexed
 * as an empty placeholder. This loader resolves the slug against the same
 * public merchant endpoint server-side and throws a real HTTP 404 for an
 * unknown merchant, so crawlers/uptime checks see the right status (mirrors
 * `not-found-ssr.tsx` / `locale-layout-ssr.tsx`, whose thrown `Response` RR v7
 * propagates to the HTTP layer).
 *
 * Fails open: a non-404 backend error (network / 5xx) lets the page render, so
 * a transient upstream blip never 404s a real merchant — the client query then
 * drives the error boundary if it persists. The happy path is unchanged: the
 * loader returns `null` and the component's own client query still paints the
 * cashback pct.
 *
 * SPA mode (mobile static export) rejects `loader` exports, so the mobile build
 * wires the component-only `cashback.$slug.tsx` via `BUILD_TARGET` in
 * `routes.ts`; both render the same landing page.
 */
export async function loader({ params }: Route.LoaderArgs): Promise<null> {
  const slug = params.slug ?? '';
  // Scope the existence check to the visitor's country exactly as the component
  // does (`useLocale()`), so a merchant out of the URL's market 404s here too.
  const { country } = normalizeLocale(params.country, params.lang);
  try {
    await getPublicMerchant(slug, { country });
  } catch (err) {
    if (err instanceof ApiException && err.status === 404) {
      throw new Response(null, { status: 404, statusText: 'Not Found' });
    }
    // Fail open on any other error — never 404 a real merchant on a transient
    // upstream failure; the client query surfaces a persistent error instead.
  }
  return null;
}

export function meta(args: Route.MetaArgs): Route.MetaDescriptors {
  // A thrown 404 renders the shared not-found UI — hand crawlers the 404 title,
  // not the merchant title (the HTTP 404 status is the load-bearing signal).
  if (isRouteErrorResponse(args.error) && args.error.status === 404) {
    return [{ title: i18n.t('notFound:meta.title') }];
  }
  return baseMeta(args);
}

// Render the shared 404 UI for the loader's not-found Response; any other error
// falls back to the route's own error copy (unchanged behaviour).
export function ErrorBoundary(): React.JSX.Element {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundContent />;
  }
  return <BaseErrorBoundary />;
}
