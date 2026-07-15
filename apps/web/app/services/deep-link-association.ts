/**
 * FE-03 — builders for the two OS App-Link / Universal-Link
 * domain-verification files, served by THIS web app at the public
 * marketing hosts (loopfinance.io / www / beta):
 *
 *   - `GET /.well-known/assetlinks.json`            (Android App Links)
 *   - `GET /.well-known/apple-app-site-association` (iOS Universal Links)
 *
 * WHY the web app and not the backend: the native intent-filter
 * (AndroidManifest) and associated-domains entitlement (App.entitlements)
 * declare the hosts `loopfinance.io`, `www.loopfinance.io`,
 * `beta.loopfinance.io` — and Apple/Google fetch the verification file
 * from `https://<that-exact-host>/.well-known/...`. Those hosts are
 * served by `@loop/web` (react-router-serve on Fly, app `loopfinance-web`);
 * the API lives on the separate host `api.loopfinance.io`. The backend
 * ALSO exposes these files (`apps/backend/src/well-known/deep-link-verification.ts`),
 * but a file served only at `api.loopfinance.io` is never fetched by the
 * verifiers, so App Links / Universal Links verification silently fails.
 * These resource routes close that gap by serving byte-identical files at
 * the marketing hosts.
 *
 * SOURCE OF TRUTH — keep in sync with, in order of authority:
 *   - `apps/backend/src/well-known/deep-link-verification.ts` (the
 *     canonical gating + JSON shape — mirror any change here),
 *   - `apps/mobile/native-overlays/ios/App/App/App.entitlements` +
 *     the Android intent-filter hosts in
 *     `apps/mobile/scripts/apply-native-overlays.sh` (the host list),
 *   - `apps/web/app/native/deep-link.ts` `ALLOWED_DEEP_LINK_HOSTS`.
 *
 * The two gating env vars are PUBLIC values (an Apple Team ID and
 * release-keystore SHA-256 fingerprints — both intended to be visible),
 * so setting them on the `loopfinance-web` Fly app as well as the backend
 * is fine. Absent → the route 404s (matching how both OS verifiers read a
 * missing file: "app linking not offered", the correct pre-enrollment
 * state), never a placeholder file that would fail verification and get
 * negatively cached.
 */

/** iOS bundle identifier — matches `apps/mobile/capacitor.config.ts` `appId`. */
export const IOS_BUNDLE_ID = 'io.loopfinance.app';
/** Android package name — same identifier as the iOS bundle id. */
export const ANDROID_PACKAGE_NAME = 'io.loopfinance.app';

/**
 * `Cache-Control` for both files — short enough that an operator filling
 * in the gating env var doesn't wait long for the verifiers to pick it
 * up, long enough to bound scrape traffic on a static file. Matches the
 * backend handler.
 */
export const WELL_KNOWN_CACHE_CONTROL = 'public, max-age=300';

/**
 * Returns the usable Apple Team ID, or null when unset / structurally
 * unusable. Mirrors the backend's `configuredAppleTeamId` (API-02): a
 * blank / whitespace / punctuation-bearing value would mangle the
 * `appID` and fail Apple verification (which iOS then negatively
 * caches), so "not configured" must key on a USABLE value, not merely a
 * defined one. Apple's App ID Prefix / Team ID is alphanumeric.
 */
export function configuredAppleTeamId(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return /^[A-Za-z0-9]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Parses the Android cert-fingerprint env into its non-empty, trimmed
 * entries. Returns `[]` when unset, blank, or collapsing to nothing
 * (e.g. `","`). Mirrors the backend's `configuredAndroidFingerprints`;
 * the caller treats `[]` as "not configured" so it never serves an
 * assetlinks file with an empty fingerprint list.
 */
export function configuredAndroidFingerprints(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((fingerprint) => fingerprint.trim())
    .filter((fingerprint) => fingerprint.length > 0);
}

/** Canonical `apple-app-site-association` JSON body for a given Team ID. */
export function buildAppleAppSiteAssociation(teamId: string): unknown {
  return {
    applinks: {
      apps: [],
      details: [
        {
          appID: `${teamId}.${IOS_BUNDLE_ID}`,
          paths: ['*'],
        },
      ],
    },
  };
}

/** Canonical `assetlinks.json` JSON body for a set of cert fingerprints. */
export function buildAssetlinks(fingerprints: string[]): unknown {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: ANDROID_PACKAGE_NAME,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];
}

/** Shared `WELL_KNOWN_NOT_CONFIGURED` 404 body, matching the backend. */
export function wellKnownNotConfigured(message: string): { code: string; message: string } {
  return { code: 'WELL_KNOWN_NOT_CONFIGURED', message };
}
