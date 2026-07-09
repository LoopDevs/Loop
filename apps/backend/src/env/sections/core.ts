/**
 * env section (hardening D2 split): a field-map spread into the
 * composed `EnvSchema` in `../../env.ts`. Add new vars for this
 * domain HERE — keeps `env.ts` from being a merge-conflict magnet.
 */
import { z } from 'zod';
import { envBoolean } from '../schema-helpers.js';
import { DEFAULT_CLIENT_IDS } from '@loop/shared';

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
  // Optional API credentials — needed for endpoints that require auth (e.g. /locations)
  GIFT_CARD_API_KEY: z.string().optional(),
  GIFT_CARD_API_SECRET: z.string().optional(),

  // Refresh intervals (hours)
  REFRESH_INTERVAL_HOURS: z.coerce.number().int().positive().default(6),
  LOCATION_REFRESH_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),

  // Dev mode: include disabled merchants so UI can be tested before CTX enables them
  INCLUDE_DISABLED_MERCHANTS: envBoolean.default(false),

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

  // Image proxy: comma-separated list of allowed hostnames.
  // If set, only URLs from these hosts are fetched. Recommended in production.
  // Example: "cdn.giftcards.com,images.merchant.com"
  IMAGE_PROXY_ALLOWED_HOSTS: z.string().optional(),

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

  // A2-654: emergency opt-out for the production-allowlist boot guard
  // below. Typed here rather than read from bare `process.env` so a
  // typo on deploy (`DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCMENT=1`) fails
  // at parse time with a clear message instead of silently leaving the
  // override inactive. Only `"1"` counts as the off-switch; any other
  // non-empty value is rejected so operators can't set it to `"true"`
  // or `"yes"` and wonder why production still refuses to boot.
  DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT: z.enum(['1']).optional(),

  // Hardening B3: emergency opt-out for the production step-up-key
  // boot guard below. Same `"1"`-only shape as the image-proxy
  // override so a deploy typo fails at parse time. Setting it ships
  // an admin surface whose destructive writes all 503
  // STEP_UP_UNAVAILABLE — deliberate for a staging deploy that
  // hasn't provisioned the key, never for real production.
  DISABLE_ADMIN_STEP_UP_ENFORCEMENT: z.enum(['1']).optional(),

  // R3-7: emergency opt-out for the production native-auth boot
  // guard below. Only `"1"` counts. Setting it deliberately permits
  // a production deploy to use the legacy CTX-proxy auth path, so it
  // is for rollback / staging only; normal production must run
  // LOOP_AUTH_NATIVE_ENABLED=true.
  DISABLE_NATIVE_AUTH_ENFORCEMENT: z.enum(['1']).optional(),

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

  // A2-1606 / A2-1607: shared-secret bearer tokens for `/metrics` and
  // `/openapi.json`. When set, the route requires `Authorization:
  // Bearer <token>` for every request. When unset the route is open in
  // development/test and 404s in production so probes can't scrape
  // the live route-map or circuit state anonymously. 32+ chars
  // recommended (the same threshold LOOP_JWT_SIGNING_KEY enforces).
  METRICS_BEARER_TOKEN: z.string().min(16).optional(),
  OPENAPI_BEARER_TOKEN: z.string().min(16).optional(),

  // A2-1610: per-admin per-currency daily cap on credit adjustments,
  // in minor units. Stops a stolen admin session from draining the
  // treasury via many sub-per-request-cap writes inside the token
  // TTL. Default 100M minor (£1M / $1M / €1M) — a volume in-flight
  // ops would never hit in a single UTC day. Set to `0` to disable
  // the check (dev / test). The per-request ±10M cap stays in place
  // regardless.
  ADMIN_DAILY_ADJUSTMENT_CAP_MINOR: z.coerce.bigint().nonnegative().default(100_000_000n),

  // ADM-01 (2026-06-30 cold audit): withdrawals had NO daily aggregate
  // cap at all, unlike every sibling admin money-write (adjustment,
  // refund, payout-compensation) — the one path where real value
  // actually leaves the system as a Stellar payment was bounded only
  // by the per-call cap and the 20/min rate limit. ADR 036 re-scoped
  // the withdrawal writer to EMISSION and the cap var was silently
  // orphaned in that merge (found by check-dead-flags, hardening C5);
  // hardening A1 revives it as the cap on the emission writer — the
  // same "value leaves the system" surface under its new name. Same
  // semantics as ADMIN_DAILY_ADJUSTMENT_CAP_MINOR: per currency, per
  // UTC day, across all admins; `0` disables the check.
  ADMIN_DAILY_WITHDRAWAL_CAP_MINOR: z.coerce.bigint().nonnegative().default(100_000_000n),

  // Discord webhooks (optional — for notifications)
  DISCORD_WEBHOOK_ORDERS: z.string().url().optional(),
  DISCORD_WEBHOOK_MONITORING: z.string().url().optional(),
  // Admin audit fanout (ADR 017 / 018). Every successful admin write
  // posts here fire-and-forget AFTER the DB commit. Unset in dev;
  // set in production so a leaked admin token produces visible
  // Discord noise rather than silent ledger drift.
  DISCORD_WEBHOOK_ADMIN_AUDIT: z.string().url().optional(),

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

  // Database (ADR 012). Required — the credits ledger + admin panel
  // can't start without it. Standard postgres URL; in dev points at
  // the docker-compose Postgres on :5433.
  DATABASE_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith('postgres://') || u.startsWith('postgresql://'), {
      message: 'must be a postgres:// or postgresql:// URL',
    }),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // A2-724: per-session statement_timeout (milliseconds). Sent as a
  // startup parameter on every connection so a runaway query
  // (admin aggregate, errant ad-hoc) can't monopolise a pool slot
  // indefinitely. 30s is the Phase-1 baseline — every documented
  // admin endpoint completes well under this with the partial
  // indexes from A2-708/709 + A2-716. Set to 0 to disable (the
  // migrator path runs through the same pool and can take longer
  // on a fresh-clone replay; default keeps boot-time migrations
  // well-bounded since none currently exceed 5s of pure DDL).
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),

  // Comma-separated list of CTX user IDs granted admin privileges
  // (ADR 011). Evaluated at user-upsert time to set `users.is_admin`.
  // Matching by CTX sub (not email) keeps the upsert path synchronous
  // against the JWT — we don't need to round-trip to CTX's `/me`
  // endpoint on every admin request. Emails as an allowlist is a
  // future refinement once the user-profile sync job lands.
  ADMIN_CTX_USER_IDS: z.string().default(''),

  // CF-30: Comma-separated list of verified emails granted admin
  // privileges on the LOOP-NATIVE auth path (ADR 013). The
  // `ADMIN_CTX_USER_IDS` allowlist above is keyed on `ctx_user_id`,
  // which UUID-anchored Loop-native users never carry — so without
  // this var every native session resolves `is_admin = false` and the
  // entire `/api/admin/*` surface is unreachable once
  // `LOOP_AUTH_NATIVE_ENABLED=true`. Evaluated at native user
  // create/login to set `users.is_admin` (config-not-DB-write parity
  // with the CTX path). Only granted on a provider/OTP-verified email:
  // both native entry points (`findOrCreateUserByEmail` on OTP,
  // `resolveOrCreateUserForIdentity` on social) are reached only after
  // the email is verified. Matched case-insensitively (normalized
  // lowercase + trim, same canonical form as the user row's email).
  ADMIN_EMAILS: z.string().default(''),

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
