import { isRouteErrorResponse, useRouteError } from 'react-router';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/gift-card.$name-ssr';
import i18n from '~/i18n/i18next';
import { fetchMerchantBySlug } from '~/services/merchants';
import { NotFoundContent } from './not-found';
import GiftCardRoute, {
  meta as baseMeta,
  ErrorBoundary as BaseErrorBoundary,
} from './gift-card.$name';

export default GiftCardRoute;

/**
 * P2-10/P2-11: `/gift-card/:name` — SSR variant. The component (mobile build)
 * resolves the slug client-side (`useMerchantBySlug`) and renders a "not found"
 * page on a 404, which SSR served with **HTTP 200** — a soft-404 crawlers then
 * indexed as an empty conversion page. This loader resolves the slug against
 * the same public by-slug endpoint server-side and throws a real HTTP 404 for
 * an unknown merchant so crawlers/uptime checks see the right status (mirrors
 * `not-found-ssr.tsx` / `locale-layout-ssr.tsx`).
 *
 * Fails open: a non-404 backend error (network / 5xx) lets the page render so a
 * transient upstream blip never 404s a real merchant — the client query drives
 * the error boundary if it persists. The happy path is unchanged: the loader
 * returns `null` and the component's own client queries still render the
 * purchase page.
 *
 * SPA mode rejects `loader` exports, so the mobile build wires the
 * component-only `gift-card.$name.tsx` via `BUILD_TARGET` in `routes.ts`.
 */
export async function loader({ params }: Route.LoaderArgs): Promise<null> {
  // Match the component's `useMerchantBySlug`: trim, and treat a blank slug as
  // not-found (it disables the fetch there and renders the not-found page).
  const name = (params.name ?? '').trim();
  if (name.length === 0) {
    throw new Response(null, { status: 404, statusText: 'Not Found' });
  }
  try {
    await fetchMerchantBySlug(name);
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
