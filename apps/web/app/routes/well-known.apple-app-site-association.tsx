import {
  buildAppleAppSiteAssociation,
  configuredAppleTeamId,
  WELL_KNOWN_CACHE_CONTROL,
  wellKnownNotConfigured,
} from '~/services/deep-link-association';

/**
 * `GET /.well-known/apple-app-site-association` — iOS Universal Links
 * domain verification, served at the marketing hosts (loopfinance.io /
 * www / beta) so Apple's association fetcher — which fetches from the
 * exact host declared in the App.entitlements `applinks:` list — can
 * confirm those hosts may open the Loop app. See
 * `~/services/deep-link-association.ts` for why this lives on the web
 * app and not only the backend, and the sync-source list.
 *
 * Apple requires `Content-Type: application/json` and no file
 * extension. `Response.json` sets that content type, and the route path
 * (`.well-known/apple-app-site-association`, no extension) is declared
 * verbatim in `routes.ts`.
 *
 * Resource route: exports only a `loader` (no component). SSR build
 * only — the mobile SPA build rejects `loader` exports and doesn't
 * serve HTTP.
 *
 * 404s with `WELL_KNOWN_NOT_CONFIGURED` until `APPLE_TEAM_ID` is set on
 * the web deployment — a real "file missing", which iOS reads as
 * "Universal Links not offered" (the correct pre-launch state) and,
 * unlike a placeholder file with an empty Team ID, is not negatively
 * cached by the OS.
 */
export function loader(): Response {
  const teamId = configuredAppleTeamId(process.env['APPLE_TEAM_ID']);
  if (teamId === null) {
    return Response.json(
      wellKnownNotConfigured('APPLE_TEAM_ID is not configured on this deployment'),
      { status: 404 },
    );
  }
  return Response.json(buildAppleAppSiteAssociation(teamId), {
    headers: { 'Cache-Control': WELL_KNOWN_CACHE_CONTROL },
  });
}
