/**
 * `GET /.well-known/apple-app-site-association` +
 * `GET /.well-known/assetlinks.json` (M-3 deep linking).
 *
 * Domain-verification files iOS (Universal Links) and Android (App
 * Links) fetch once per install to confirm loopfinance.io / www / beta
 * are allowed to open the Loop app instead of the browser. Both are
 * public, unauthenticated, PII-free, and each gated on an operator-
 * filled env var that only exists post-enrollment:
 *
 * - `APPLE_TEAM_ID` — set after Apple Developer Program enrollment
 *   (go-live-plan L1-4).
 * - `ANDROID_CERT_SHA256` — set after the release keystore is created
 *   (go-live-plan L1-5; comma-separated to support a debug + release
 *   fingerprint side by side during rollout).
 *
 * Absent env var → 404 `WELL_KNOWN_NOT_CONFIGURED` rather than a
 * partial/placeholder verification file. Both Apple's and Google's
 * verifiers treat "file missing" as "app linking not offered" — the
 * correct pre-enrollment state — whereas a syntactically-valid file
 * with an empty/placeholder appID or fingerprint would fail
 * verification loudly and (for iOS in particular) risks getting
 * negatively cached by the OS.
 *
 * Native-side wiring (Android intent-filter, iOS associated-domains
 * entitlement) lives in `apps/mobile/scripts/apply-native-overlays.sh`;
 * the web-side allowlist these files exist to justify is
 * `ALLOWED_DEEP_LINK_HOSTS` in `apps/web/app/native/deep-link.ts`. Keep
 * all three host lists in sync.
 */
import type { Context } from 'hono';
import { env } from '../env.js';

const IOS_BUNDLE_ID = 'io.loopfinance.app';
const ANDROID_PACKAGE_NAME = 'io.loopfinance.app';

/** `Cache-Control` for both handlers — short enough that an operator filling in the gating env var doesn't have to wait long for verifiers to pick it up, long enough to bound scrape traffic on a static file. */
const CACHE_CONTROL = 'public, max-age=300';

/**
 * Serves `apple-app-site-association` (iOS Universal Links, M-3).
 * No file extension and no `Content-Type` sniffing on Apple's side —
 * `c.json` sets `application/json`, which is what Apple's association
 * fetcher expects.
 */
export function appleAppSiteAssociationHandler(c: Context): Response {
  if (env.APPLE_TEAM_ID === undefined) {
    return c.json(
      {
        code: 'WELL_KNOWN_NOT_CONFIGURED',
        message: 'APPLE_TEAM_ID is not configured on this deployment',
      },
      404,
    );
  }

  c.header('Cache-Control', CACHE_CONTROL);
  return c.json({
    applinks: {
      apps: [],
      details: [
        {
          appID: `${env.APPLE_TEAM_ID}.${IOS_BUNDLE_ID}`,
          paths: ['*'],
        },
      ],
    },
  });
}

/** Serves `assetlinks.json` (Android App Links, M-3). */
export function assetlinksHandler(c: Context): Response {
  if (env.ANDROID_CERT_SHA256 === undefined) {
    return c.json(
      {
        code: 'WELL_KNOWN_NOT_CONFIGURED',
        message: 'ANDROID_CERT_SHA256 is not configured on this deployment',
      },
      404,
    );
  }

  const fingerprints = env.ANDROID_CERT_SHA256.split(',')
    .map((fingerprint) => fingerprint.trim())
    .filter((fingerprint) => fingerprint.length > 0);

  c.header('Cache-Control', CACHE_CONTROL);
  return c.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: ANDROID_PACKAGE_NAME,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ]);
}
