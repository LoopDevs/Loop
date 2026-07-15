import {
  buildAssetlinks,
  configuredAndroidFingerprints,
  WELL_KNOWN_CACHE_CONTROL,
  wellKnownNotConfigured,
} from '~/services/deep-link-association';

/**
 * `GET /.well-known/assetlinks.json` — Android App Links domain
 * verification, served at the marketing hosts (loopfinance.io / www /
 * beta) so Google's Digital Asset Links verifier — which fetches from
 * the exact host declared in the AndroidManifest intent-filter — can
 * confirm those hosts may open the Loop app. See
 * `~/services/deep-link-association.ts` for why this lives on the web
 * app and not only the backend, and the sync-source list.
 *
 * Resource route: exports only a `loader` (no component). Registered in
 * `routes.ts` for the SSR build only — the mobile SPA build rejects
 * `loader` exports and doesn't serve HTTP, so it has no `.well-known`.
 *
 * 404s with `WELL_KNOWN_NOT_CONFIGURED` until `ANDROID_CERT_SHA256` is
 * set on the web deployment — a real "file missing", which is exactly
 * how the verifier reads "App Links not offered" (the correct
 * pre-launch state), never a placeholder file that would fail
 * verification.
 */
export function loader(): Response {
  const fingerprints = configuredAndroidFingerprints(process.env['ANDROID_CERT_SHA256']);
  if (fingerprints.length === 0) {
    return Response.json(
      wellKnownNotConfigured('ANDROID_CERT_SHA256 is not configured on this deployment'),
      { status: 404 },
    );
  }
  return Response.json(buildAssetlinks(fingerprints), {
    headers: { 'Cache-Control': WELL_KNOWN_CACHE_CONTROL },
  });
}
