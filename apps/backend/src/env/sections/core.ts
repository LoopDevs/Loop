/**
 * env section (hardening D2 split): a field-map spread into the
 * composed `EnvSchema` in `../../env.ts`. Add new vars for this
 * domain HERE — keeps `env.ts` from being a merge-conflict magnet.
 */
import { z } from 'zod';
import { envBoolean } from '../schema-helpers.js';
import { DEFAULT_CLIENT_IDS } from '@loop/shared';

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

export const coreEnvFields = {
  // Coerce + bound: process.env.PORT is always a string, but downstream code
  // treats it as a number. Rejecting non-numeric input here gives a clear
  // startup error instead of binding to NaN at runtime.
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // 'silent' and 'fatal' are valid pino levels; include them so tests and
  // emergency ops configs don't require bypassing schema validation.
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

  // Upstream gift card API. Must be http or https — a file://, data:, or ftp://
  // URL would be accepted by z.string().url() but is never correct here, and
  // would either SSRF a local file or break upstream fetches at runtime.
  GIFT_CARD_API_BASE_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
      message: 'must use http or https protocol',
    }),
  // Client IDs for upstream auth — one per platform. Defaults come from
  // `@loop/shared/DEFAULT_CLIENT_IDS` so `apps/web` (which sends
  // `X-Client-Id`) and the backend allowlist in `requireAuth()` can't
  // drift silently (audit A-018). Env overrides stay supported for
  // per-deployment variation; `parseEnv` warns below if the effective
  // value diverges from the shared default so operators remember to
  // update the web bundle too.
  CTX_CLIENT_ID_WEB: z.string().default(DEFAULT_CLIENT_IDS.web),
  CTX_CLIENT_ID_IOS: z.string().default(DEFAULT_CLIENT_IDS.ios),
  CTX_CLIENT_ID_ANDROID: z.string().default(DEFAULT_CLIENT_IDS.android),
  // Operator API credentials. Required: ctx is the payment processor
  // (ADR 052) — they authenticate every upstream surface (order
  // create + status mirror, merchant catalog + /locations scoping,
  // both /ws topic subscriptions), so a deployment without them can't
  // do anything useful and refuses to boot rather than come up with
  // orders that never leave `unpaid`.
  GIFT_CARD_API_KEY: z.string().min(1),
  GIFT_CARD_API_SECRET: z.string().min(1),

  // Refresh interval (hours). The merchant sweep has no equivalent var:
  // it's hardcoded hourly (merchants/sync-interval.ts) — it's only the
  // fallback reconciler behind the ws maintainer, not worth a knob.
  LOCATION_REFRESH_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),

  // A2-1922: comma-separated list of CTX merchant IDs to filter out
  // of the catalog at sync time. Operator-controlled deny-list for
  // merchants Loop refuses to resell — slurs in the brand name,
  // upstream CTX entries we want temporarily hidden during a dispute,
  // or commercial relationships Loop hasn't agreed to. Filter applies
  // at `mapUpstreamMerchant` so denied IDs never enter the in-memory
  // store, never reach the public API, and never show up in the
  // admin catalog. CTX's upstream catalog is unchanged.
  //
  // ID-based rather than name-substring matching because IDs are
  // stable; CTX may rename a merchant without notice. If a name-
  // pattern filter is needed for a class of brands, that's a
  // follow-up (admin DB column rather than an env var).
  LOOP_MERCHANT_DENYLIST: z.string().optional(),

  // Path to an operator-provided MaxMind GeoLite2-Country .mmdb (ADR 033). Powers the
  // GET /api/public/geo first-guess for the region selector. Unset → that endpoint
  // returns the US default and the web client falls back to navigator.language.
  MAXMIND_GEOLITE2_PATH: z.string().optional(),

  // M-3 (deep linking) domain-verification files. Both gate their
  // `/.well-known/*` endpoint 404 `WELL_KNOWN_NOT_CONFIGURED` when
  // unset — the operator fills these in once the corresponding native
  // credential exists, not before: `APPLE_TEAM_ID` after Apple
  // Developer Program enrollment (go-live-plan L1-4),
  // `ANDROID_CERT_SHA256` after the release keystore is created
  // (go-live-plan L1-5). No boot guard — absent is a valid pre-launch
  // state (deep linking degrades to "verification file missing", not
  // an outage; see apps/backend/src/well-known/deep-link-verification.ts).
  APPLE_TEAM_ID: z.string().optional(),
  // Comma-separated SHA-256 certificate fingerprints (colon-hex, e.g.
  // "AA:BB:CC:..."), supporting a debug + release keystore fingerprint
  // side by side during rollout. Split/trimmed at read time.
  ANDROID_CERT_SHA256: z.string().optional(),

  // P2-14 (min-app-version / forced-update gate). The oldest native app
  // build the backend still supports, per platform. Surfaced on the
  // public `/api/config` so the native shell's `ForceUpdateGate`
  // (apps/web/app/components/ForceUpdateGate.tsx) can hard-block a build
  // older than this with an "update required" screen. SERVER-SIDE source
  // of truth (operator-controlled, no app-store resubmission to raise
  // the floor) — the client only stamps `X-Client-Version`, it never
  // decides its own minimum. Unset → no gate (the pre-launch default).
  // Dotted numeric, e.g. "0.4.0"; iOS and Android are independent so a
  // floor can be raised on one platform (e.g. an App Store hotfix
  // shipped ahead of Play) without gating the other. Web is never gated
  // — it is always served fresh, so it has no minimum.
  MIN_SUPPORTED_APP_VERSION_IOS: z.string().optional(),
  MIN_SUPPORTED_APP_VERSION_ANDROID: z.string().optional(),

  // R3-7: emergency opt-out for the production native-auth boot
  // guard below. Only `"1"` counts. Setting it deliberately permits
  // a production deploy to use the legacy CTX-proxy auth path, so it
  // is for rollback / staging only; normal production must run
  // LOOP_AUTH_NATIVE_ENABLED=true.
  DISABLE_NATIVE_AUTH_ENFORCEMENT: z.enum(['1']).optional(),

  // NS-10 (CF-25 / X-PRIV-03 follow-up): emergency opt-out for the
  // production LOOP_REDEEM_ENCRYPTION_KEY boot guard below (env.ts).
  // Same `"1"`-only shape as its siblings so a deploy typo fails at
  // parse time. Setting it ships production storing gift-card redeem
  // codes/PINs (spendable bearer secrets) as PLAINTEXT at rest — the
  // very exposure the guard exists to prevent. For a deliberate,
  // audited rollback / staging deploy ONLY; never for a real
  // production launch with live redemption data. Unlike a forgotten
  // key (which now fails boot), turning encryption off must be an
  // explicit, conspicuous act.
  DISABLE_REDEEM_ENCRYPTION_ENFORCEMENT: z.enum(['1']).optional(),

  // Rate-limiter trust boundary (audit A-023). When `true` the rate limiter
  // reads the client IP from the first value in X-Forwarded-For (required
  // when running behind Fly.io / a load balancer). When `false` it falls
  // back to the TCP socket's remote address so an arbitrary client cannot
  // spoof its own IP to bypass per-IP limits. Default `false` — prod
  // deployments set it to `true` explicitly via `fly.toml`.
  TRUST_PROXY: envBoolean.default(false),

  // Rate-limit escape hatch for e2e test harnesses. The mocked-
  // e2e suite drives the purchase flow with Playwright retries,
  // which collides with the 5/min request-otp limit. Set to `1`
  // ONLY in test configs (playwright.mocked.config.ts, playwright
  // .config.ts); production must never set this — it disables
  // every per-IP limit on every route.
  DISABLE_RATE_LIMITING: envBoolean.default(false),

  // AUDIT-2-E: second, independent control required (in addition to
  // `NODE_ENV==='test'`) before `test-endpoints.ts` mounts the
  // `/__test__/*` surface — notably `/__test__/mint-loop-token`, which
  // mints a full session token pair (admin-eligible if the email is on
  // `ADMIN_EMAILS`) with zero credential check. `NODE_ENV==='test'`
  // alone is a single string compare; a misconfigured staging/preview
  // deploy that copies `NODE_ENV=test` would otherwise expose
  // unauthenticated admin-session minting. Every request under
  // `/__test__/*` must present this exact value via the
  // `X-Test-Endpoints-Secret` header; unset → the router never mounts
  // at all (identical to production's "route doesn't exist" posture).
  // Set ONLY in test configs (playwright.mocked.config.ts,
  // playwright.flywheel.config.ts) — never in production (env.ts boot
  // guard refuses to start if it's set there). Min 16 chars so a blank
  // or trivially-guessable value can't satisfy the gate.
  LOOP_TEST_ENDPOINTS_SECRET: z.string().min(16).optional(),

  // CF2-10 (2026-06-30 cold audit) → S4-4 (2026-07-09 dynamic fix):
  // `rateLimitMap` is an in-memory, per-machine Map — every configured
  // per-route budget (`rateLimit(name, max, windowMs)`) is actually
  // `max × N` where N is however many Fly machines are currently
  // running, since a client's requests land on whichever machine picks
  // them up. Fly's `auto_start_machines=true` autoscaling means N isn't
  // fixed, so a *static* estimate goes wrong the moment the fleet
  // scales — exactly under the load spike you'd want limits tight.
  //
  // The real fix (`middleware/fleet-size.ts`) queries Fly's private
  // `.internal` DNS zone (one AAAA record per started machine,
  // fleet-wide) on a background interval and uses that LIVE count as
  // the divisor whenever it's fresh. This var is now only the
  // **no-signal fallback**: used when `FLY_APP_NAME` is unset (local
  // dev, CI, non-Fly hosts), the DNS refresh has never succeeded, or a
  // run of failures has exceeded the estimator's grace period. See
  // `fleet-size.ts` for why the dynamic value is preferred in both
  // directions (a shrunk fleet dividing too much is safe; a grown
  // fleet dividing too little is not) rather than e.g. `max(dynamic,
  // static)`.
  //
  // Defaults to 1 (no division) — same posture as TRUST_PROXY: local
  // dev and every unit/integration test run single-process, where the
  // per-machine multiplier problem doesn't exist, so the documented
  // literal thresholds (5/min, 10/min, etc.) must hold unchanged.
  // Production still sets this explicitly (via fly.toml / `flyctl
  // secrets`) as the fallback floor for whenever DNS is unavailable.
  RATE_LIMIT_MACHINE_COUNT_ESTIMATE: z.coerce.number().int().positive().default(1),

  // S4-4: Fly injects this into every Machine's runtime automatically
  // (not admin-configured — declared here anyway, same as PORT/
  // NODE_ENV, so it flows through the validated `env` object and the
  // dead-flags detector can see it's read). Names the app's private
  // `.internal` DNS zone (`<FLY_APP_NAME>.internal`), which
  // `fleet-size.ts` queries to count live machines. Absent outside Fly
  // (local dev, CI) — the estimator then falls back to
  // `RATE_LIMIT_MACHINE_COUNT_ESTIMATE` above, unchanged behaviour.
  FLY_APP_NAME: z.string().optional(),

  // A2-1606: shared-secret bearer token for `/metrics`. When set, the
  // route requires `Authorization: Bearer <token>` for every request.
  // When unset the route is open in development/test and 404s in
  // production so probes can't scrape circuit state anonymously.
  METRICS_BEARER_TOKEN: z.string().min(16).optional(),

  // Discord webhooks (optional — for notifications). SEC-10: each must
  // be a real HTTPS Discord webhook URL, not merely a well-formed URL —
  // see `discordWebhookUrl` above.
  DISCORD_WEBHOOK_ORDERS: discordWebhookUrl.optional(),
  DISCORD_WEBHOOK_MONITORING: discordWebhookUrl.optional(),

  // Error tracking (optional — get DSN from sentry.io)
  SENTRY_DSN: z.string().url().optional(),

  // A2-1309: release tag for Sentry. Pair with `VITE_SENTRY_RELEASE`
  // on the web side. CI/CD should set this to the git SHA (or a
  // version + SHA composite) so Sentry can pivot from an event to
  // the exact deploy artifact that produced it. Absent → Sentry
  // omits the `release` attribute on every event; pre-launch we keep
  // this unset locally so dev runs don't poison the "release" pivot
  // in the Sentry UI.
  SENTRY_RELEASE: z.string().min(1).optional(),
  // A2-1310: deploy-time logical environment tag. Backend was using
  // `NODE_ENV` for the Sentry `environment` field and web was using
  // `import.meta.env.MODE` — these diverge on a staging deploy that
  // sets `NODE_ENV=production` but `MODE=staging`, bucketing backend
  // and web events into different Sentry environments. `LOOP_ENV`
  // (backend) paired with `VITE_LOOP_ENV` (web) is the explicit
  // override: both sides fall back to their respective defaults when
  // unset, so existing deploys keep working.
  LOOP_ENV: z.string().min(1).optional(),

  // Document store driver. `memory` (default) loads the whole database
  // into memory from the JSON file at DB_JSON_PATH; `mongo` connects to
  // MONGODB_URI. See src/db/client.ts.
  DB_DRIVER: z.enum(['memory', 'mongo']).default('memory'),
  // Where the memory driver persists the database ('' → ephemeral, no
  // persistence — the unit-test posture).
  DB_JSON_PATH: z.string().default('data/db.json'),
  MONGODB_URI: z
    .string()
    .url()
    .refine((u) => u.startsWith('mongodb://') || u.startsWith('mongodb+srv://'), {
      message: 'must be a mongodb:// or mongodb+srv:// URL',
    })
    .optional(),
  MONGODB_DB: z.string().min(1).default('loop'),

  // Defaults for the cashback split when a merchant has no admin-set
  // `merchant_cashback_configs` row (ADR 011). Applied in
  // `computeCashbackSplit` as a fallback so newly-synced merchants
  // aren't accidentally zero-cashback before ops gets to them.
  // Expressed as a percent-of-face-value string (e.g. "8.00" = 8%);
  // the sum must be ≤ 100. The `_OF_CTX` suffix traces back to the
  // ADR wording ("of CTX's discount to Loop") — today we apply them
  // directly to face value because the per-merchant CTX-discount
  // rate isn't in the catalog's hot data. Default 0/0 preserves the
  // prior behaviour (zero cashback + zero margin) until ops
  // explicitly opts in.
  DEFAULT_USER_CASHBACK_PCT_OF_CTX: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, 'must be a 0-100 percent with ≤ 2 decimals')
    .default('0.00'),
  DEFAULT_LOOP_MARGIN_PCT_OF_CTX: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, 'must be a 0-100 percent with ≤ 2 decimals')
    .default('0.00'),
};
