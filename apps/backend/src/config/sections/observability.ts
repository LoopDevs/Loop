/**
 * config sections: `observability:` (error tracking, alerting, metrics)
 * and `mobile:` (the native shells' server-side settings).
 *
 * See `./server.ts` for what a section module is.
 */
import { z } from 'zod';

// SEC-10: Discord webhook URLs are secrets that, if pointed at an
// attacker-controlled host, leak every alert/audit embed (order data,
// admin-action metadata, drift figures) off-platform. `z.string().url()`
// alone accepts ANY scheme/host — `http://evil.example/x`, a `file://`
// URL, a look-alike domain — so a copy-paste error or a malicious
// override silently exfiltrates. Constrain to a real HTTPS Discord
// webhook endpoint: https scheme, an official Discord host, and the
// `/api/webhooks/` (optionally version-prefixed) path. Self-hosted
// Discord is not a thing, so there is no legitimate non-Discord value.
const DISCORD_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'ptb.discord.com',
  'canary.discord.com',
  'ptb.discordapp.com',
  'canary.discordapp.com',
]);
const DISCORD_WEBHOOK_PATH = /^\/api\/(v\d+\/)?webhooks\//;
const discordWebhookUrl = z
  .string()
  .url()
  .refine(
    (raw) => {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        return false;
      }
      return (
        u.protocol === 'https:' &&
        DISCORD_WEBHOOK_HOSTS.has(u.hostname.toLowerCase()) &&
        DISCORD_WEBHOOK_PATH.test(u.pathname)
      );
    },
    {
      message:
        'must be an https Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>)',
    },
  );

export const observabilitySchema = z
  .object({
    // A2-1310: deploy-time logical environment tag, used as Sentry's
    // `environment` field. Distinct from the top-level `env:` on
    // purpose: a staging deployment runs `env: production` (so it
    // behaves like production) but wants its events bucketed as
    // `staging`. Pair with `VITE_LOOP_ENV` on the web build so backend
    // and web events land in the same Sentry environment. Unset → falls
    // back to the top-level `env:`.
    environmentTag: z.string().min(1).optional(),

    sentry: z
      .object({
        // Get the DSN from sentry.io. Unset → Sentry is not initialised.
        dsn: z.string().url().optional(),
        // A2-1309: release tag. Pair with `VITE_SENTRY_RELEASE` on the
        // web side. CI/CD should set this to the git SHA (or a version +
        // SHA composite) so Sentry can pivot from an event to the exact
        // deploy artifact that produced it. Absent → Sentry omits the
        // `release` attribute on every event; keep it unset locally so
        // dev runs don't poison the "release" pivot in the Sentry UI.
        release: z.string().min(1).optional(),
      })
      .prefault({}),

    discord: z
      .object({
        ordersWebhook: discordWebhookUrl.optional(),
        monitoringWebhook: discordWebhookUrl.optional(),
        // ADR 017/018 — the admin action trail: one embed per admin
        // mutation after it commits, plus the bulk-read tripwire
        // (A2-2008 / CF-10). Kept on its own webhook so the channel it
        // posts to can have a narrower audience than #monitoring.
        adminAuditWebhook: discordWebhookUrl.optional(),
      })
      .prefault({}),

    metrics: z
      .object({
        // A2-1606: shared-secret bearer token for `/metrics`. When set,
        // the route requires `Authorization: Bearer <token>` on every
        // request. When unset the route is open in development/test and
        // 404s in production, so probes can't scrape circuit state
        // anonymously.
        bearerToken: z.string().min(16).optional(),
      })
      .prefault({}),
  })
  .prefault({});

export const mobileSchema = z
  .object({
    // P2-14 (forced-update gate). The oldest native app build the
    // backend still supports, per platform. Surfaced on the public
    // `/api/config` so the native shell's `ForceUpdateGate`
    // (apps/web/app/components/ForceUpdateGate.tsx) can hard-block an
    // older build with an "update required" screen.
    //
    // SERVER-SIDE source of truth: raising the floor is a config change,
    // not an app-store resubmission — the client only stamps
    // `X-Client-Version`, it never decides its own minimum. Dotted
    // numeric, e.g. "0.4.0". iOS and Android are independent so a floor
    // can be raised on one platform (say, an App Store hotfix shipped
    // ahead of Play) without gating the other. Web is never gated — it
    // is always served fresh, so it has no minimum. Unset → no gate,
    // the pre-launch default.
    minSupportedVersion: z
      .object({
        ios: z.string().min(1).optional(),
        android: z.string().min(1).optional(),
      })
      .prefault({}),

    // M-3 domain-verification files. Each gates its `/.well-known/*`
    // endpoint to a 404 `WELL_KNOWN_NOT_CONFIGURED` when unset — the
    // operator fills these in once the corresponding native credential
    // exists, not before: `apple.teamId` after Apple Developer Program
    // enrolment (go-live-plan L1-4), `android.certFingerprints` after
    // the release keystore is created (go-live-plan L1-5). No boot guard
    // — absent is a valid pre-launch state, and deep linking degrades to
    // "verification file missing" rather than an outage (see
    // well-known/deep-link-verification.ts).
    deepLinks: z
      .object({
        apple: z
          .object({
            teamId: z.string().min(1).optional(),
          })
          .prefault({}),
        android: z
          .object({
            // SHA-256 certificate fingerprints in colon-hex form (e.g.
            // "AA:BB:CC:..."). A list so a debug and a release keystore
            // fingerprint can sit side by side during rollout — this was
            // `ANDROID_CERT_SHA256`, a comma-separated string every
            // consumer had to split and trim itself.
            certFingerprints: z.array(z.string().min(1)).default([]),
          })
          .prefault({}),
      })
      .prefault({}),
  })
  .prefault({});
