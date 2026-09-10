// M-3 deep-linking well-known files
import type { Context } from 'hono';
import { config } from '../config/index.js';

const IOS_BUNDLE_ID = 'io.loopfinance.app';
const ANDROID_PACKAGE_NAME = 'io.loopfinance.app';

// 5-min TTL: fast enough for operator config changes, slow enough to bound static-file scrape traffic
const CACHE_CONTROL = 'public, max-age=300';

// API-02: blank/whitespace env vars must be treated as unconfigured to avoid serving structurally-broken verification files that iOS negatively caches
function configuredAppleTeamId(): string | null {
  const raw = config.mobile.deepLinks.apple.teamId;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return /^[A-Za-z0-9]+$/.test(trimmed) ? trimmed : null;
}

// Returns [] for unset/blank/whitespace-only values so callers can treat empty as "not configured"
function configuredAndroidFingerprints(): string[] {
  return config.mobile.deepLinks.android.certFingerprints
    .map((fingerprint) => fingerprint.trim())
    .filter((fingerprint) => fingerprint.length > 0);
}

// Apple's association fetcher expects application/json; no file extension or Content-Type sniffing on their side
export function appleAppSiteAssociationHandler(c: Context): Response {
  const teamId = configuredAppleTeamId();
  if (teamId === null) {
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
          appID: `${teamId}.${IOS_BUNDLE_ID}`,
          paths: ['*'],
        },
      ],
    },
  });
}

export function assetlinksHandler(c: Context): Response {
  const fingerprints = configuredAndroidFingerprints();
  if (fingerprints.length === 0) {
    return c.json(
      {
        code: 'WELL_KNOWN_NOT_CONFIGURED',
        message: 'ANDROID_CERT_SHA256 is not configured on this deployment',
      },
      404,
    );
  }

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
