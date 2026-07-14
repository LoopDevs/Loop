import { isRouteErrorResponse, useRouteError } from 'react-router';
import { brandSlug, groupMerchants, merchantInCountry } from '@loop/shared';
import type { Route } from './+types/brand.$slug-ssr';
import i18n from '~/i18n/i18next';
import { normalizeLocale } from '~/i18n/locale';
import { fetchAllMerchants } from '~/services/merchants';
import { NotFoundContent } from './not-found';
import BrandRoute, { meta as baseMeta } from './brand.$slug';

export default BrandRoute;

/**
 * P2-10/P2-11: `/brand/:slug` — SSR variant. The component (mobile build)
 * derives the brand group client-side from the merchant catalogue and renders
 * a "Brand not found" page for an unknown slug, which SSR served with **HTTP
 * 200** — a soft-404 crawlers then indexed. This loader reproduces the same
 * country-scoped grouping server-side and throws a real HTTP 404 when no brand
 * group matches, so crawlers/uptime checks see the right status (mirrors
 * `not-found-ssr.tsx` / `locale-layout-ssr.tsx`).
 *
 * Fails open: a transient catalogue-fetch failure lets the page render rather
 * than 404-ing a real brand — the client `useAllMerchants` query then drives
 * the not-found / error state. The happy path is unchanged: the loader returns
 * `null` and the component still groups + renders the variants client-side.
 *
 * SPA mode rejects `loader` exports, so the mobile build wires the
 * component-only `brand.$slug.tsx` via `BUILD_TARGET` in `routes.ts`.
 */
export async function loader({ params }: Route.LoaderArgs): Promise<null> {
  const slug = params.slug ?? '';
  // Scope to the URL's country BEFORE grouping, exactly as the component does.
  const { country } = normalizeLocale(params.country, params.lang);
  let merchants;
  try {
    merchants = (await fetchAllMerchants()).merchants;
  } catch {
    // Fail open — a transient catalogue-fetch failure must not 404 a real brand.
    return null;
  }
  const countryMerchants = merchants.filter((m) => merchantInCountry(m, country));
  // Same guarded decode + case-insensitive brandSlug() normalisation the
  // component uses (CAT-03) so the two never disagree on what resolves.
  let decoded = slug;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    // keep the raw value (malformed percent-escape)
  }
  const normalizedSlug = brandSlug(decoded);
  const group = groupMerchants(countryMerchants).find((g) => brandSlug(g.name) === normalizedSlug);
  if (group === undefined) {
    throw new Response(null, { status: 404, statusText: 'Not Found' });
  }
  return null;
}

export function meta(args: Route.MetaArgs): Route.MetaDescriptors {
  // A thrown 404 renders the shared not-found UI — hand crawlers the 404 title,
  // not the brand title (the HTTP 404 status is the load-bearing signal).
  if (isRouteErrorResponse(args.error) && args.error.status === 404) {
    return [{ title: i18n.t('notFound:meta.title') }];
  }
  return baseMeta(args);
}

// Render the shared 404 UI for the loader's not-found Response. Any other error
// is re-thrown so it bubbles to the root boundary (the component route exports
// no ErrorBoundary, so this preserves its prior behaviour for non-404 errors).
export function ErrorBoundary(): React.JSX.Element {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundContent />;
  }
  throw error;
}
