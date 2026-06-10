import { isbot } from 'isbot';
import { redirect } from 'react-router';
import { DEFAULT_LANG, resolveCountryPath, type GeoResponse } from '@loop/shared';
import type { Route } from './+types/home-geo-redirect';

// The home component + its meta/links render unchanged at `/` for the bot /
// x-default case below.
export { default, meta, links } from './home';

// Resolved server-side at request time (same pattern as sitemap.tsx).
function apiBaseUrl(): string {
  return import.meta.env.VITE_API_URL ?? 'https://api.loopfinance.io';
}

/**
 * Geo-resolve the visitor's country from the backend `/api/public/geo`
 * (MaxMind GeoLite2), forwarding the client IP. Fails open to `''` →
 * {@link resolveCountryPath} falls back to the default market.
 */
async function geoCountry(request: Request): Promise<string> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    // Forward the client IP so the backend resolves the visitor's country, not
    // the SSR server's. The backend only trusts these behind TRUST_PROXY.
    for (const h of ['x-forwarded-for', 'x-real-ip']) {
      const v = request.headers.get(h);
      if (v) headers[h] = v;
    }
    // Cap the geo lookup so a slow / hung backend never blocks the homepage
    // redirect — fail open to the default market instead.
    const res = await fetch(`${apiBaseUrl()}/api/public/geo`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return '';
    return ((await res.json()) as GeoResponse).countryCode ?? '';
  } catch {
    return '';
  }
}

/**
 * ADR 034 §Decision-3 — the `/` geo-redirect. A bare `/` 302s to `/<country>/en`
 * so every page knows its country from the URL (no US flash). This is the second
 * documented loader-fetch exception after `sitemap.tsx`: the redirect target
 * varies per visitor, so it must be resolved server-side and **must be a 302**
 * (a cached 301 would pin one visitor's country for everyone).
 *
 * Bots are NOT redirected — a crawler (mostly US-IP) gets the x-default home
 * rendered at `/`, so `/` never looks "always US" to Google; variants stay
 * discoverable via the sitemap + reciprocal hreflang. SSR-only: the mobile build
 * wires `home.tsx` directly at `/` (no SSR to redirect; the shell pins a locale).
 */
export async function loader({ request }: Route.LoaderArgs): Promise<null> {
  if (isbot(request.headers.get('user-agent') ?? '')) return null;
  const country = resolveCountryPath(await geoCountry(request));
  throw redirect(`/${country}/${DEFAULT_LANG}`);
}
