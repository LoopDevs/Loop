import { z } from 'zod';
import { DEFAULT_CLIENT_IDS, STELLAR_PUBKEY_REGEX } from '@loop/shared';

const STELLAR_ADDRESS_MESSAGE = 'must be a valid Stellar public key (G...)';

/**
 * Parses a process.env boolean the way operators actually write them.
 *
 * `z.coerce.boolean()` is a footgun here: it uses JavaScript's truthy
 * semantics, so `"false"`, `"0"`, and `"no"` all coerce to `true`
 * (any non-empty string is truthy). An operator setting
 * `TRUST_PROXY=false` would silently enable X-Forwarded-For trust —
 * the opposite of what they wrote.
 *
 * Accept a small set of conventional strings, case-insensitive:
 * - true / 1 / yes / on → true
 * - false / 0 / no / off / "" → false
 * Anything else rejects with a clear validation error rather than
 * picking a direction silently.
 */
const envBoolean = z.union([z.boolean(), z.string()]).transform((v, ctx) => {
  if (typeof v === 'boolean') return v;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === '') return false;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `expected boolean (true/false/1/0/yes/no/on/off), got ${JSON.stringify(v)}`,
  });
  return z.NEVER;
});

/**
 * Environment schema. Exported so tests can exercise it directly if they
 * ever need to (today they go through `parseEnv` instead); production
 * code should consume the validated `env` object at the bottom of this
 * file, not the raw schema.
 */
export const EnvSchema = z.object({
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

  // Image proxy: comma-separated list of allowed hostnames.
  // If set, only URLs from these hosts are fetched. Recommended in production.
  // Example: "cdn.giftcards.com,images.merchant.com"
  IMAGE_PROXY_ALLOWED_HOSTS: z.string().optional(),

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

  // Comma-separated list of CTX user IDs granted admin privileges
  // (ADR 011). Evaluated at user-upsert time to set `users.is_admin`.
  // Matching by CTX sub (not email) keeps the upsert path synchronous
  // against the JWT — we don't need to round-trip to CTX's `/me`
  // endpoint on every admin request. Emails as an allowlist is a
  // future refinement once the user-profile sync job lands.
  ADMIN_CTX_USER_IDS: z.string().default(''),

  // Loop-signed JWT secret (ADR 013). Used to sign and verify access
  // + refresh tokens minted by Loop's own auth path. Required in
  // production; absent in development / test the backend skips
  // Loop-native auth (CTX proxy remains in place).
  //
  // HS256 is a symmetric secret — minimum 32 bytes of entropy.
  // Rotation: set LOOP_JWT_SIGNING_KEY to the new value and
  // LOOP_JWT_SIGNING_KEY_PREVIOUS to the old one for the access-token
  // TTL window; the verifier accepts either, the signer always uses
  // the current. Drop PREVIOUS after the TTL elapses.
  LOOP_JWT_SIGNING_KEY: z
    .string()
    .min(32, { message: 'LOOP_JWT_SIGNING_KEY must be at least 32 characters' })
    .optional(),
  LOOP_JWT_SIGNING_KEY_PREVIOUS: z
    .string()
    .min(32, { message: 'LOOP_JWT_SIGNING_KEY_PREVIOUS must be at least 32 characters' })
    .optional(),

  // Loop-native auth feature flag (ADR 013). When true, /request-otp
  // (and, as they ship, /verify-otp + /refresh) take the Loop-native
  // path: Loop sends the OTP email and mints its own JWTs. Default
  // false → the legacy CTX-proxy auth path stays in place.
  LOOP_AUTH_NATIVE_ENABLED: envBoolean.default(false),

  // Social login — Google (ADR 014). One client id per platform;
  // at least one must be set to activate the Google endpoint. The
  // id_token's `aud` must match one of these values. Generate in
  // Google Cloud Console → APIs & Services → Credentials.
  GOOGLE_OAUTH_CLIENT_ID_WEB: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID_IOS: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID_ANDROID: z.string().optional(),

  // Social login — Apple (ADR 014). The service id (web) / bundle id
  // (native). Apple's id_token `aud` must match this. Absent →
  // /api/auth/social/apple returns 404.
  APPLE_SIGN_IN_SERVICE_ID: z.string().optional(),

  // Loop's Stellar deposit address for Loop-native orders (ADR 010).
  // Users paying with XLM / USDC send to this address, encoding the
  // order's payment memo in the transaction's memo_text so the
  // watcher can match payment → order. Absent → /api/orders/loop
  // returns 503 for xlm / usdc methods; credit-funded orders still
  // work because they don't cross-chain.
  LOOP_STELLAR_DEPOSIT_ADDRESS: z
    .string()
    .regex(STELLAR_PUBKEY_REGEX, { message: STELLAR_ADDRESS_MESSAGE })
    .optional(),

  // USDC issuer account for the watcher's asset-match guard. Centre
  // on mainnet: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN.
  // Defaults to undefined → watcher accepts any USDC issuer (MVP
  // leniency; tighten once operators have verified the deployment).
  LOOP_STELLAR_USDC_ISSUER: z
    .string()
    .regex(STELLAR_PUBKEY_REGEX, { message: STELLAR_ADDRESS_MESSAGE })
    .optional(),

  // Issuer accounts for the three LOOP-branded Stellar assets (ADR 015).
  // Loop issues USDLOOP / GBPLOOP / EURLOOP 1:1-backed against fiat
  // reserves in regulated bank accounts, and pays cashback in the
  // asset matching the user's home currency. Absent → the payout
  // worker treats cashback as off-chain-only for that currency
  // (ledger row written, Stellar side skipped) so a partially-
  // configured deployment doesn't block fulfillment of orders from
  // users whose currency is wired up.
  LOOP_STELLAR_USDLOOP_ISSUER: z
    .string()
    .regex(STELLAR_PUBKEY_REGEX, { message: STELLAR_ADDRESS_MESSAGE })
    .optional(),
  LOOP_STELLAR_GBPLOOP_ISSUER: z
    .string()
    .regex(STELLAR_PUBKEY_REGEX, { message: STELLAR_ADDRESS_MESSAGE })
    .optional(),
  LOOP_STELLAR_EURLOOP_ISSUER: z
    .string()
    .regex(STELLAR_PUBKEY_REGEX, { message: STELLAR_ADDRESS_MESSAGE })
    .optional(),

  // Procurement USDC-reserve floor (ADR 015). When the operator account's
  // USDC balance drops below this many stroops (7 decimals; 10^7 = 1 USDC),
  // procurement falls back to paying CTX in XLM instead — trades a small
  // XLM burn for unblocking fulfillment while the ops top-up is in flight.
  // Absent → the fallback is disabled and procurement always uses USDC.
  // Below-floor events are ops-flagged in admin/treasury so the operator
  // sees them immediately (ADR 015 treasury strategy).
  LOOP_STELLAR_USDC_FLOOR_STROOPS: z.coerce.bigint().nonnegative().optional(),

  // Operator Stellar secret key for outbound payouts (ADR 016).
  // Signs LOOP-asset Payment ops from Loop's operator account to
  // users' linked wallets. Never logged (pino redaction allowlist).
  // Absent → payout worker is inert; pending_payouts rows stay
  // pending until an operator sets this and ticks the worker.
  // Rotation: move the active key to `_PREVIOUS` for the access-
  // token TTL, then drop — mirrors the JWT key rotation pattern.
  LOOP_STELLAR_OPERATOR_SECRET: z
    .string()
    .regex(/^S[A-Z2-7]{55}$/, { message: 'must be a valid Stellar secret key (S...)' })
    .optional(),
  LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS: z
    .string()
    .regex(/^S[A-Z2-7]{55}$/, { message: 'must be a valid Stellar secret key (S...)' })
    .optional(),

  // Network passphrase for payout signing. PUBLIC mainnet is the
  // default; operators override with TESTNET string for staging.
  // Anything non-empty is accepted so a self-hosted network can
  // set its own passphrase.
  LOOP_STELLAR_NETWORK_PASSPHRASE: z
    .string()
    .default('Public Global Stellar Network ; September 2015'),

  // Payout-worker tick interval (seconds). 30s matches ADR 016's
  // recommended pacing — the worker is slower than the watcher
  // (10s) or procurement (5s) because each payout is a Stellar
  // submit + ledger-close (~5s) and parallelism on the operator
  // account is unsafe (sequence numbers serialise).
  LOOP_PAYOUT_WORKER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),

  // Max auto-retry attempts before a row promotes from transient
  // failure to terminal `failed`. ADR 016 default 5.
  LOOP_PAYOUT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  // Feature flag for the Loop-native order workers (ADR 010). When
  // true at boot, the backend starts the payment watcher and
  // procurement worker intervals. Default false — workers are opt-in
  // per deployment so a fresh clone doesn't start hitting Horizon /
  // CTX pre-configuration.
  LOOP_WORKERS_ENABLED: envBoolean.default(false),

  // Worker tick intervals (seconds). Defaults tuned for a moderate
  // order volume: watcher every 10s to keep deposit latency low;
  // procurement every 5s since a paid order is user-blocking until
  // the gift card arrives.
  LOOP_PAYMENT_WATCHER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),
  LOOP_PROCUREMENT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(5),

  // Asset-drift watcher (ADR 015). 300s (5m) default — drift is an
  // accounting metric, not latency-sensitive; paging the monitoring
  // channel faster than that would just generate noise from
  // in-flight payouts.
  LOOP_ASSET_DRIFT_WATCHER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),

  // Threshold in stroops at which a non-zero drift pages ops. 1e8
  // stroops = 10 whole LOOP units = $10 of over/under-mint for the
  // USD asset. Leaves room for normal in-flight payout drift (a
  // queue of say 20 × $5 cashbacks still fits) while catching
  // real accounting divergence.
  LOOP_ASSET_DRIFT_THRESHOLD_STROOPS: z.coerce.bigint().nonnegative().default(100_000_000n),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parses a raw env source against `EnvSchema`. Returns the validated env or
 * throws with a descriptive message that includes each failing field's reason
 * (not just the path), so ops can tell the difference between "missing" and
 * "present but invalid URL". Exported so tests can exercise the schema
 * without relying on mutating `process.env`.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment variables — ${details}`);
  }

  // Warn on footguns that pass schema validation but are almost certainly
  // misconfigurations in production. A warn (not a throw) keeps emergency
  // admin overrides possible.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.INCLUDE_DISABLED_MERCHANTS) {
    // eslint-disable-next-line no-console
    console.warn(
      '[env] INCLUDE_DISABLED_MERCHANTS=true in production — disabled merchants will be visible to end users',
    );
  }

  // Audit A-018: operators can override client IDs per environment, but
  // the web bundle hardcodes `DEFAULT_CLIENT_IDS` (via @loop/shared) at
  // build time. Warn when the effective server value diverges from that
  // default so the operator knows to rebuild the web app with matching
  // values, or the client-id allowlist in `requireAuth()` will reject
  // authenticated requests after login.
  const divergentClientIds: Array<[string, string, string]> = [];
  if (parsed.data.CTX_CLIENT_ID_WEB !== DEFAULT_CLIENT_IDS.web) {
    divergentClientIds.push([
      'CTX_CLIENT_ID_WEB',
      parsed.data.CTX_CLIENT_ID_WEB,
      DEFAULT_CLIENT_IDS.web,
    ]);
  }
  if (parsed.data.CTX_CLIENT_ID_IOS !== DEFAULT_CLIENT_IDS.ios) {
    divergentClientIds.push([
      'CTX_CLIENT_ID_IOS',
      parsed.data.CTX_CLIENT_ID_IOS,
      DEFAULT_CLIENT_IDS.ios,
    ]);
  }
  if (parsed.data.CTX_CLIENT_ID_ANDROID !== DEFAULT_CLIENT_IDS.android) {
    divergentClientIds.push([
      'CTX_CLIENT_ID_ANDROID',
      parsed.data.CTX_CLIENT_ID_ANDROID,
      DEFAULT_CLIENT_IDS.android,
    ]);
  }
  for (const [name, actual, expected] of divergentClientIds) {
    // eslint-disable-next-line no-console
    console.warn(
      `[env] ${name}=${actual} differs from @loop/shared DEFAULT_CLIENT_IDS (${expected}). ` +
        `The web bundle sends X-Client-Id from the shared constant, so authenticated requests will ` +
        `fail the X-Client-Id allowlist (audit A-036) until apps/web is rebuilt with a matching value.`,
    );
  }

  // Audit A-025: the image proxy's strongest SSRF mitigation is the
  // hostname allowlist. Without it we only have best-effort IP validation,
  // which the proxy's own source documents as TOCTOU-vulnerable to DNS
  // rebinding. Refuse to start in production unless the allowlist is set.
  // Emergency opt-out is DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1.
  if (
    parsed.data.NODE_ENV === 'production' &&
    (parsed.data.IMAGE_PROXY_ALLOWED_HOSTS === undefined ||
      parsed.data.IMAGE_PROXY_ALLOWED_HOSTS.trim() === '') &&
    source['DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT'] !== '1'
  ) {
    throw new Error(
      'Invalid environment variables — IMAGE_PROXY_ALLOWED_HOSTS must be set in production (audit A-025). ' +
        'Set it to a comma-separated list of upstream image hostnames (e.g. "cdn.ctx.com,ctx-spend.s3.us-west-2.amazonaws.com"), ' +
        'or set DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1 to override for an emergency push.',
    );
  }

  return parsed.data;
}

/** Validated, typed environment configuration. */
export const env = parseEnv(process.env);
