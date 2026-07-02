import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';
import { Keypair } from '@stellar/stellar-sdk';
import { DEFAULT_CLIENT_IDS, STELLAR_PUBKEY_REGEX } from '@loop/shared';

const STELLAR_ADDRESS_MESSAGE = 'must be a valid Stellar public key (G...)';

/**
 * Circle's canonical USDC issuer account on Stellar mainnet. Used by
 * the boot-time tripwire below — a launch-runbook typo once shipped a
 * wrong issuer address, which makes the payment watcher silently
 * ignore every legitimate USDC deposit.
 */
export const CANONICAL_MAINNET_USDC_ISSUER =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/** Stellar mainnet (pubnet) network passphrase. */
const MAINNET_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

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
 * Shannon entropy in bits per character. A uniformly random alphanumeric
 * secret (e.g. `openssl rand -base64 32`) lands well above 4 bits/char;
 * a degenerate value (all one character, a short repeating pattern, or a
 * low-cardinality string like `"aaaaaaaa...bbbbbbbb..."`) lands well below.
 */
function shannonEntropyBitsPerChar(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** CF2-17 (2026-06-30 cold audit): minimum entropy every signing key must clear. */
const SIGNING_KEY_MIN_ENTROPY_BITS_PER_CHAR = 3.0;

/**
 * CF2-17: length alone doesn't rule out a low-entropy secret — a 32-char
 * string of one repeated character (or a short repeating cycle) passes a
 * bare `.min(32)` check but is trivially guessable. Centralizes the
 * length + entropy pair so every HS256 signing key (`LOOP_JWT_SIGNING_KEY`,
 * its `_PREVIOUS`, `LOOP_ADMIN_STEP_UP_SIGNING_KEY`, its `_PREVIOUS`) is
 * validated identically instead of four hand-copied `.min(32)` calls.
 */
function signingKeySchema(varName: string): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .min(32, { message: `${varName} must be at least 32 characters` })
    .refine((key) => shannonEntropyBitsPerChar(key) >= SIGNING_KEY_MIN_ENTROPY_BITS_PER_CHAR, {
      message:
        `${varName} is too low-entropy to be a real signing key ` +
        `(looks like a repeated/patterned value, not a random secret) — ` +
        `generate one with \`openssl rand -base64 32\` or similar`,
    })
    .optional();
}

/**
 * Validates an RSA private key in PEM (PKCS8) form at boot (ADR 030
 * Phase A). Two-step:
 *
 * 1. `transform` — normalise escaped `\n` sequences to real newlines.
 *    PEM-in-env-var is a classic deployment footgun: some secret
 *    stores flatten the multiline value to a single line with literal
 *    backslash-n, which `createPrivateKey` rejects. Normalising here
 *    means consumers (auth/signer.ts) always see a parseable PEM.
 * 2. `superRefine` — actually parse the key with node:crypto and
 *    require `asymmetricKeyType === 'rsa'`. A malformed PEM (or an
 *    EC/Ed25519 key pasted by mistake) fails `parseEnv()` and the
 *    boot, rather than surfacing as a 500 on the first token mint.
 */
const rsaPrivateKeyPem = z
  .string()
  .transform((v) => v.replace(/\\n/g, '\n'))
  .superRefine((pem, ctx) => {
    try {
      const key = createPrivateKey(pem);
      if (key.asymmetricKeyType !== 'rsa') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be an RSA private key, got ${key.asymmetricKeyType ?? 'unknown'}`,
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'must be a PEM-encoded (PKCS8) RSA private key — generate with ' +
          '`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`',
      });
    }
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

  // CF2-10 (2026-06-30 cold audit) stopgap: `rateLimitMap` is an
  // in-memory, per-machine Map — every configured per-route budget
  // (`rateLimit(name, max, windowMs)`) is actually `max × N` where N
  // is however many Fly machines are currently running, since a
  // client's requests land on whichever machine picks them up. Fly's
  // `auto_start_machines=true` autoscaling means N isn't fixed; a
  // `flyctl machines list` check during the audit found 2 machines
  // already provisioned. Until the real fix (a shared Postgres/Redis-
  // backed counter, tracked separately) lands, divide every
  // configured budget by this estimate so the EFFECTIVE fleet-wide
  // budget matches what's documented.
  //
  // Defaults to 1 (no division) — same posture as TRUST_PROXY: local
  // dev and every unit/integration test run single-process, where the
  // per-machine multiplier problem doesn't exist, so the documented
  // literal thresholds (5/min, 10/min, etc.) must hold unchanged.
  // Production sets this explicitly (via fly.toml / `flyctl secrets`)
  // to the fleet's real machine count — update it when that count
  // changes; it's a blunt estimate, not a live `flyctl machines list`
  // read.
  RATE_LIMIT_MACHINE_COUNT_ESTIMATE: z.coerce.number().int().positive().default(1),

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
  LOOP_JWT_SIGNING_KEY: signingKeySchema('LOOP_JWT_SIGNING_KEY'),
  LOOP_JWT_SIGNING_KEY_PREVIOUS: signingKeySchema('LOOP_JWT_SIGNING_KEY_PREVIOUS'),

  // RS256 signing keys (ADR 030 Phase A). PEM-encoded PKCS8 RSA
  // private key; when set, newly-minted Loop JWTs sign RS256 with a
  // `kid` header (RFC 7638 thumbprint) and the matching public keys
  // publish at `GET /.well-known/jwks.json` so an external wallet
  // provider (Privy custom auth — or any JWKS consumer) can verify
  // Loop's tokens without sharing a secret. Unset → HS256 signing
  // via LOOP_JWT_SIGNING_KEY continues unchanged (rollout safety).
  //
  // Generate: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`
  // Rotation: set LOOP_JWT_RSA_PRIVATE_KEY to the new PEM and
  // LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS to the old one for the
  // refresh-token TTL window (30 days); both public keys serve in the
  // JWKS, the signer always uses the current. Malformed / non-RSA
  // PEMs fail boot (see `rsaPrivateKeyPem` above). Escaped "\n"
  // sequences are normalised to newlines at parse time.
  LOOP_JWT_RSA_PRIVATE_KEY: rsaPrivateKeyPem.optional(),
  LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS: rsaPrivateKeyPem.optional(),

  // Admin step-up signing key (ADR 028, A4-063). Separate from
  // LOOP_JWT_SIGNING_KEY so a JWT-key compromise doesn't widen to
  // step-up — an attacker who exfiltrates LOOP_JWT_SIGNING_KEY can
  // still mint access tokens but cannot mint step-up tokens, so the
  // ADR-028 gate (X-Admin-Step-Up on credit-adjust / emissions /
  // payout-retry) holds even under partial key compromise.
  //
  // Optional in `env.ts` so the surface ships without breaking
  // deployments that haven't generated the key yet; the boot
  // validator below downgrades the gate to "always 401" when the
  // key is unset, so the surface fails closed rather than silently
  // skipping the check.
  //
  // Rotation: same staged-rotation pattern as LOOP_JWT_SIGNING_KEY.
  // Set `_PREVIOUS` to the old key during the 5-minute step-up TTL
  // window; the verifier accepts either, the signer always uses
  // the current.
  LOOP_ADMIN_STEP_UP_SIGNING_KEY: signingKeySchema('LOOP_ADMIN_STEP_UP_SIGNING_KEY'),
  LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS: signingKeySchema(
    'LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS',
  ),

  // Gift-card redeem-secret envelope key (CF-25 / X-PRIV-03). When set,
  // `orders.redeem_code` / `redeem_pin` are AES-256-GCM-encrypted at
  // rest (orders/redeem-crypto.ts) so a logical DB read (leaked
  // DATABASE_URL, rogue loop_readonly SELECT, backup exfiltration)
  // sees ciphertext, not spendable bearer codes. `redeem_url` stays
  // plaintext (it's the redemption landing page, not the secret).
  //
  // 32 bytes, supplied as base64 / base64url or hex. Validated at boot
  // (below) so a wrong-length key fails loudly instead of silently
  // writing un-decryptable ciphertext. Absent → encryption is disabled
  // and codes are stored plaintext (legacy behaviour); index.ts logs a
  // single boot warn while unset. Decrypt is backward-safe: old
  // plaintext rows and key-unset writes pass through untouched, so
  // setting the key activates encryption for new writes without a
  // backfill or boot break. NOT a JWT/HMAC secret — keep it separate.
  LOOP_REDEEM_ENCRYPTION_KEY: z.string().optional(),

  // Loop-native auth feature flag (ADR 013). When true, /request-otp
  // (and, as they ship, /verify-otp + /refresh) take the Loop-native
  // path: Loop sends the OTP email and mints its own JWTs. Default
  // false → the legacy CTX-proxy auth path stays in place.
  LOOP_AUTH_NATIVE_ENABLED: envBoolean.default(false),

  // Phase 1 launch gate. When true, the public + onboarding surfaces
  // hide every Phase 2 cashback / wallet / LOOP-asset element so the
  // app reads as a pure XLM-via-CTX gift-card store. The Phase 2
  // backend code paths (workers, payout submit, asset-drift watcher,
  // interest accrual) are independently gated on
  // LOOP_WORKERS_ENABLED / LOOP_AUTH_NATIVE_ENABLED /
  // INTEREST_APY_BASIS_POINTS — those should also be off in a Phase 1
  // deployment. This flag is the *UI-side* equivalent: hides
  // /cashback, /settings/wallet, /settings/cashback, the navbar
  // links, the cashback rate badges on merchant cards, the
  // currency picker + wallet-intro onboarding screens, and any
  // "you've earned X" surfaces.
  //
  // Set to false (default) once the operator is ready to launch
  // cashback as v1.1 — flipping the flag is server-side only;
  // no app-store resubmission needed.
  LOOP_PHASE_1_ONLY: envBoolean.default(false),

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

  // USDC issuer account for the watcher's asset-match guard. Circle
  // on mainnet: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN.
  // Defaults to undefined → watcher accepts any USDC issuer (MVP
  // leniency; tighten once operators have verified the deployment).
  // `parseEnv` warns at boot when this is set on mainnet to anything
  // other than the canonical Circle issuer (launch-runbook typo
  // tripwire — see CANONICAL_MAINNET_USDC_ISSUER above).
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

  // Per-asset ISSUER secret keys (ADR 031 / ADR 036 Phase D). A
  // payment FROM the issuer account is a native mint on Stellar —
  // the nightly interest worker enqueues `kind='interest_mint'`
  // payout rows and the payout worker signs those (and only those)
  // with the matching issuer keypair instead of the operator key.
  // `parseEnv` below boot-fails when a secret is set without its
  // `LOOP_STELLAR_<ASSET>_ISSUER` address, or when the keypair
  // derived from the secret doesn't match that address — a mismatch
  // would sign mint payments from a *different* account (a transfer,
  // not a mint), silently corrupting issuance accounting.
  // Never logged (pino redaction). Rotation: an issuer key rotation
  // is a treasury event (the asset identity is the issuer account),
  // not an env-var swap — see docs/runbooks/stellar-operator-rotation.md.
  LOOP_STELLAR_USDLOOP_ISSUER_SECRET: z
    .string()
    .regex(/^S[A-Z2-7]{55}$/, { message: 'must be a valid Stellar secret key (S...)' })
    .optional(),
  LOOP_STELLAR_GBPLOOP_ISSUER_SECRET: z
    .string()
    .regex(/^S[A-Z2-7]{55}$/, { message: 'must be a valid Stellar secret key (S...)' })
    .optional(),
  LOOP_STELLAR_EURLOOP_ISSUER_SECRET: z
    .string()
    .regex(/^S[A-Z2-7]{55}$/, { message: 'must be a valid Stellar secret key (S...)' })
    .optional(),

  // ADR 031 / ADR 036 Phase D: nightly on-chain interest mints.
  // When true (and at least one issuer SECRET above is configured,
  // and INTEREST_APY_BASIS_POINTS > 0, and LOOP_WORKERS_ENABLED),
  // the interest-mint worker replaces the legacy off-chain-only
  // accrual scheduler: each UTC day it snapshots activated-wallet
  // LOOP balances from Horizon, credits the `user_credits` mirror
  // (`credit_transactions type='interest'`) and enqueues an
  // on-chain mint (`pending_payouts kind='interest_mint'`) in one
  // transaction per user. The legacy `accrue-interest.ts` path is
  // hard-gated off while this flag is true — two interest writers
  // must never coexist (the halves would diverge nightly).
  LOOP_INTEREST_ONCHAIN_ENABLED: envBoolean.default(false),

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

  // Interest forward-mint pool account (ADR 009 / 015).
  //
  // Per the on-chain-is-source-of-truth model: paying users daily
  // interest creates new off-chain `user_credits` liability that
  // MUST be matched by an on-chain LOOP-asset mint to keep the
  // asset-drift watcher reconciliation honest. To avoid one mint
  // tx per day per currency (operationally heavy), the operator
  // pre-mints a forward batch — typically a month's expected
  // interest — to this pool account. Daily accrual then sub-
  // allocates from the pool off-chain; on-chain issuance was
  // already incurred at mint-time.
  //
  // The drift watcher subtracts the pool balance from on-chain
  // circulation before comparing to off-chain liability, so a
  // freshly-minted pool doesn't trip the over-issued alert (ADR 015).
  //
  // Defaults to the operator account when unset — the operator
  // already holds custody of LOOP-asset and submits payouts from
  // there, so reusing it as the pool is the simplest topology.
  // A deliberate operator can split them by setting this to a
  // different cold-custody account.
  LOOP_INTEREST_POOL_ACCOUNT: z
    .string()
    .regex(STELLAR_PUBKEY_REGEX, { message: STELLAR_ADDRESS_MESSAGE })
    .optional(),

  // Interest pool depletion threshold (days of cover).
  //
  // The pool watcher pages the Discord monitoring channel when the
  // on-chain pool balance can cover fewer than this many days of
  // forecast daily interest at the current APY. 7 days gives the
  // operator a week to mint the next batch before users would be
  // under-allocated. Tighter ops can lower it (3-5 days); operators
  // with monthly mint cadence + multi-day reaction time should
  // raise it.
  LOOP_INTEREST_POOL_MIN_DAYS_COVER: z.coerce.number().int().min(1).max(365).default(7),

  // Transactional email provider (ADR 013). When unset / `console`
  // the dev-only stub fires; production refuses to start with the
  // console value (see auth/email.ts). Add a real provider before
  // flipping `LOOP_AUTH_NATIVE_ENABLED=true` in production.
  // Currently supported: `resend`. Each provider has its own
  // API-key + from-address envs.
  EMAIL_PROVIDER: z.enum(['console', 'resend']).optional(),

  // Resend API key (https://resend.com). Required when
  // EMAIL_PROVIDER=resend. Format is `re_...` — never log this.
  RESEND_API_KEY: z.string().optional(),

  // Sender address used by the email provider. Must be a domain
  // the operator has verified DKIM/SPF for at the provider's
  // dashboard. Defaults to `noreply@loopfinance.io` if unset.
  EMAIL_FROM_ADDRESS: z.string().email().optional(),

  // Display name for the From header. Defaults to `Loop`.
  EMAIL_FROM_NAME: z.string().optional(),

  // Optional Reply-To address for transactional email. When set, OTP
  // emails carry a `reply_to` header so user replies route to a
  // monitored inbox (production sets hello@loopfinance.io via
  // fly.toml) instead of bouncing off the no-reply sender. Unset →
  // the reply_to key is omitted from the provider payload entirely.
  //
  // Declared in the schema so a typo'd address fails parseEnv at boot
  // (it previously bypassed env.ts via a bare process.env read in
  // auth/email.ts — a malformed value silently sent mail with no
  // Reply-To). The call site still reads process.env live, matching
  // the documented test-reload pattern (A2-1513 / A2-1812 resolution
  // notes) used by the sibling EMAIL_* vars: zod validates at boot,
  // runtime reads stay live so tests can mutate process.env and reset
  // the cached provider.
  EMAIL_REPLY_TO_ADDRESS: z.string().email().optional(),

  // Network passphrase for payout signing. PUBLIC mainnet is the
  // default; operators override with TESTNET string for staging.
  // Anything non-empty is accepted so a self-hosted network can
  // set its own passphrase.
  LOOP_STELLAR_NETWORK_PASSPHRASE: z
    .string()
    .default('Public Global Stellar Network ; September 2015'),

  // A2-1513: Horizon base URL for all payment-watcher / balance /
  // circulation reads AND the payout-worker submit. Previously every
  // consumer did `process.env['LOOP_STELLAR_HORIZON_URL']` directly,
  // bypassing the env.ts zod layer — a typo in the URL (missing
  // https://, trailing slash, etc.) only surfaced on the first
  // Horizon call rather than at boot. Moved into the zod schema so
  // a malformed URL fails `parseEnv()` at startup.
  LOOP_STELLAR_HORIZON_URL: z.string().url().default('https://horizon.stellar.org'),

  // A2-1812: price-feed + operator-pool bypass fix. These three
  // were previously read via `process.env[...]` in `payments/price-feed.ts`
  // and `ctx/operator-pool.ts` with no zod schema — a malformed URL
  // or malformed JSON only surfaced at first use (mid-request). Moved
  // into the schema so boot catches them. Callers still read from
  // `process.env` directly at their call sites — that's the
  // documented test-reload pattern (A2-1513 resolution notes) where
  // a test mutates `process.env[...]` and expects the next read to
  // pick the mutation up. Zod validates at boot; runtime reads stay
  // live.
  //
  // `CTX_OPERATOR_POOL` is a JSON-encoded array of
  // `{ id, bearer }` objects (ADR 013). Left as `string` here — the
  // full JSON-shape validation lives in `operator-pool.ts::loadOperators`
  // where a good error message is easier to produce.
  LOOP_XLM_PRICE_FEED_URL: z.string().url().optional(),
  LOOP_FX_FEED_URL: z.string().url().optional(),
  CTX_OPERATOR_POOL: z.string().min(1).optional(),

  // Payout-worker tick interval (seconds). 30s matches ADR 016's
  // recommended pacing — the worker is slower than the watcher
  // (10s) or procurement (5s) because each payout is a Stellar
  // submit + ledger-close (~5s) and parallelism on the operator
  // account is unsafe (sequence numbers serialise).
  LOOP_PAYOUT_WORKER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),

  // Max auto-retry attempts before a row promotes from transient
  // failure to terminal `failed`. ADR 016 default 5.
  LOOP_PAYOUT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  // A2-602 watchdog: rows stuck in `submitted` for longer than this
  // (seconds) are re-picked by the worker. The idempotency pre-check
  // converges them to `confirmed` if the prior submit actually landed;
  // otherwise a fresh submit is issued with a new sequence number.
  // Default 300s (5m) — a well-behaved Horizon close is ~5s, so five
  // minutes is well outside the normal submit→seal window while still
  // short enough that a crash-loop doesn't silently eat payouts.
  LOOP_PAYOUT_WATCHDOG_STALE_SECONDS: z.coerce.number().int().positive().default(300),

  // A2-1921 fee-bump strategy. Under Stellar network congestion the
  // SDK default `BASE_FEE` (100 stroops) gets out-bid by user-side
  // traffic and the tx returns `tx_insufficient_fee`. The worker now
  // scales the fee per-attempt so a congested period drains naturally:
  //   attempt 1 → BASE
  //   attempt 2 → BASE * MULTIPLIER
  //   attempt 3 → BASE * MULTIPLIER^2
  //   …capped at CAP
  // Defaults: 100 → 200 → 400 → 800 → 1600 stroops at MULTIPLIER=2,
  // CAP=100_000 (any single payout is well under $0.001 of fee even
  // at the cap, so this is cheap insurance against a stuck row).
  LOOP_PAYOUT_FEE_BASE_STROOPS: z.coerce.number().int().positive().default(100),
  LOOP_PAYOUT_FEE_CAP_STROOPS: z.coerce.number().int().positive().default(100_000),
  LOOP_PAYOUT_FEE_MULTIPLIER: z.coerce.number().positive().default(2),

  // Feature flag for the Loop-native order workers (ADR 010). When
  // true at boot, the backend starts the payment watcher and
  // procurement worker intervals. Default false — workers are opt-in
  // per deployment so a fresh clone doesn't start hitting Horizon /
  // CTX pre-configuration.
  LOOP_WORKERS_ENABLED: envBoolean.default(false),

  // A2-1907: runtime kill switches. Setting any of these to `true` on
  // a running deployment makes the matching surface return 503
  // SUBSYSTEM_DISABLED without redeploying. Toggle via:
  //   `fly secrets set LOOP_KILL_<NAME>=true -a loopfinance-api`
  // The Fly secret-set triggers a rolling restart picking up the new
  // value. Default false on every switch — fail-open posture, no
  // surprise blackout if an env var is mis-set.
  LOOP_KILL_ORDERS: envBoolean.default(false),
  // Per-path order switches (comprehensive-audit 2026-06-11, P10):
  // when set they override LOOP_KILL_ORDERS for their path; when
  // UNSET they fall back to it — fully backward compatible. No
  // `.default(false)` on purpose: the unset/false distinction is the
  // fallback semantic (kill-switches.ts reads process.env directly;
  // these entries exist for validation + .env.example parity).
  LOOP_KILL_ORDERS_LEGACY: envBoolean.optional(),
  LOOP_KILL_ORDERS_LOOP: envBoolean.optional(),
  LOOP_KILL_AUTH: envBoolean.default(false),
  // Pre-ADR-036 name: LOOP_KILL_WITHDRAWALS (renamed with the
  // withdrawal→emission re-scope; gates admin emissions + the
  // payout-compensation endpoint).
  LOOP_KILL_EMISSIONS: envBoolean.default(false),

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

  // ADR 030 Phase B: provider-agnostic embedded-wallet substrate.
  // '' (default) → the wallet layer is OFF: `getWalletProvider()`
  // returns null and no vendor code path is reachable. 'privy' →
  // the Privy REST adapter is active and PRIVY_APP_ID +
  // PRIVY_APP_SECRET become required (cross-field check in
  // `parseEnv` below). Nothing user-facing consumes this in Phase B
  // — it is the substrate Phase C wires into flows.
  LOOP_WALLET_PROVIDER: z.enum(['', 'privy']).default(''),

  // Privy app credentials (ADR 030). Used as HTTP Basic auth
  // (`PRIVY_APP_ID:PRIVY_APP_SECRET`) plus the `privy-app-id` header
  // on every Privy REST call. The secret is never logged (pino
  // redaction paths cover PRIVY_APP_SECRET). Both required iff
  // LOOP_WALLET_PROVIDER=privy; ignored otherwise.
  PRIVY_APP_ID: z.string().min(1).optional(),
  PRIVY_APP_SECRET: z.string().min(1).optional(),

  // A2-905 / ADR 009: interest accrual on user credit balances.
  // Off by default (0 bps) — ADR 009 explicitly feature-flags this
  // "until counsel confirms the framing of interest on promotional
  // credits in each target market." Switching on requires setting
  // INTEREST_APY_BASIS_POINTS > 0 AND LOOP_WORKERS_ENABLED=true.
  // APY in integer basis points (400 = 4.00%); periodsPerYear is
  // the denominator the primitive divides the annual rate by (365
  // for daily, 12 for monthly, 52 for weekly). Tick interval is the
  // scheduler cadence — kept independent from periodsPerYear so a
  // deploy that wants nightly accrual on the first UTC day after
  // boot (periodsPerYear=365) can still tick hourly and rely on the
  // per-cursor idempotency to no-op the duplicates.
  INTEREST_APY_BASIS_POINTS: z.coerce.number().int().min(0).max(10_000).default(0),
  INTEREST_PERIODS_PER_YEAR: z.coerce.number().int().positive().default(365),
  INTEREST_TICK_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),

  // CF-26 / X-PRIV-07/08: auth-row retention purge. Periodic sweep
  // (gated with the other workers on LOOP_WORKERS_ENABLED) that deletes
  // expired/consumed OTP rows and dead (expired or long-revoked)
  // refresh-token rows past the retention grace. Both tables hold PII
  // (email / token hash) with no lawful basis to retain dead rows. The
  // interval is hourly by default — retention hygiene is not latency-
  // sensitive. The retention window defaults to 30 days, comfortably
  // past the refresh horizon so a live session is never reaped, and
  // long enough that the token-theft reuse signal (A2-1608) and the
  // just-expired-OTP 401 edge stay intact.
  LOOP_AUTH_ROW_PURGE_INTERVAL_HOURS: z.coerce.number().int().positive().default(1),

  // Hardening C1 (2026-07 plan): cadence of the ledger-invariant
  // watcher — the scheduled check that user_credits.balance_minor
  // still equals SUM(credit_transactions) per (user, currency), paging
  // Discord while any drift persists. Full-table aggregate, so daily
  // by default; the check single-flights across machines via an
  // advisory lock. Runs under LOOP_WORKERS_ENABLED.
  LOOP_LEDGER_INVARIANT_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),
  LOOP_AUTH_ROW_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
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

  // Hardening B7 (2026-07 plan): HS256 retirement tripwire. After the
  // RS256 cutover (ADR 030 Phase A) the HS256 key must stay set only
  // for the 30-day refresh window so outstanding HS256 tokens keep
  // verifying — then it MUST be removed: every extra day it stays set
  // is a standing forgery-if-leaked surface running alongside the RSA
  // key for no benefit. Nothing else ever prompts the removal, so
  // this warn fires on every boot while both are set (deploys are the
  // natural cadence for the reminder). Runbook:
  // docs/runbooks/jwt-key-rotation.md.
  if (
    parsed.data.LOOP_JWT_RSA_PRIVATE_KEY !== undefined &&
    parsed.data.LOOP_JWT_SIGNING_KEY !== undefined
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      '[env] Both LOOP_JWT_RSA_PRIVATE_KEY and LOOP_JWT_SIGNING_KEY are set. If the RS256 cutover ' +
        'is more than 30 days old (the refresh-token TTL), remove LOOP_JWT_SIGNING_KEY — outstanding ' +
        'HS256 tokens have all expired and the key is now a pure forgery-if-leaked surface ' +
        '(docs/runbooks/jwt-key-rotation.md, hardening B7).',
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

  // Launch-runbook tripwire: a typo'd LOOP_STELLAR_USDC_ISSUER once
  // shipped to production — the watcher's issuer-match guard then
  // silently ignores every legitimate USDC deposit, which presents as
  // "payments never arrive" rather than an error. On mainnet, warn
  // (don't throw — a deliberate operator may genuinely point at a
  // non-Circle asset, e.g. a private network fork) whenever the value
  // differs from Circle's canonical issuer.
  if (
    parsed.data.LOOP_STELLAR_USDC_ISSUER !== undefined &&
    parsed.data.LOOP_STELLAR_NETWORK_PASSPHRASE === MAINNET_NETWORK_PASSPHRASE &&
    parsed.data.LOOP_STELLAR_USDC_ISSUER !== CANONICAL_MAINNET_USDC_ISSUER
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      `[env] LOOP_STELLAR_USDC_ISSUER=${parsed.data.LOOP_STELLAR_USDC_ISSUER} differs from ` +
        `Circle's canonical mainnet USDC issuer (${CANONICAL_MAINNET_USDC_ISSUER}) while the ` +
        `Stellar network passphrase is mainnet. If this is a typo, the payment watcher will ` +
        `silently ignore every legitimate USDC deposit. Double-check the value before serving traffic.`,
    );
  }

  // Audit A-025: the image proxy's strongest SSRF mitigation is the
  // hostname allowlist. Without it we only have best-effort IP validation,
  // which the proxy's own source documents as TOCTOU-vulnerable to DNS
  // rebinding. Refuse to start in production unless the allowlist is set.
  // Emergency opt-out is DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1.
  //
  // A2-654: the override used to be read directly from `source[...]`
  // (i.e. process.env), bypassing the zod schema. A typo on deploy
  // left the override silently inactive. It's now a schema field
  // whose only accepted value is `"1"`; any other non-empty value
  // fails at parse time with a clear message.
  if (
    parsed.data.NODE_ENV === 'production' &&
    (parsed.data.IMAGE_PROXY_ALLOWED_HOSTS === undefined ||
      parsed.data.IMAGE_PROXY_ALLOWED_HOSTS.trim() === '') &&
    parsed.data.DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT !== '1'
  ) {
    throw new Error(
      'Invalid environment variables — IMAGE_PROXY_ALLOWED_HOSTS must be set in production (audit A-025). ' +
        'Set it to a comma-separated list of upstream image hostnames (e.g. "cdn.ctx.com,ctx-spend.s3.us-west-2.amazonaws.com"), ' +
        'or set DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1 to override for an emergency push.',
    );
  }

  // A2-1605: DISABLE_RATE_LIMITING bypasses every per-IP rate
  // limiter in the middleware stack. That's a test-harness flag —
  // shipped to production it opens every auth/payment/admin route
  // to volumetric abuse, and the breakers downstream are not a
  // substitute (they trip on upstream failure, not request volume).
  //
  // Refuse to boot in production if the flag is set. No override —
  // if an operator truly needs a prod rate-limit bypass they can
  // edit this check out and redeploy, which is a harder foot-gun
  // than a silently-honoured env var.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.DISABLE_RATE_LIMITING) {
    throw new Error(
      'Invalid environment variables — DISABLE_RATE_LIMITING must not be set in production (audit A2-1605). ' +
        'The flag is a test-harness escape hatch; production runs without it. ' +
        'Unset the variable and redeploy.',
    );
  }

  // ADR 030 Phase B cross-field requirement: selecting the Privy
  // wallet provider without its credentials would otherwise only
  // surface on the first wallet call (as a terminal provider error).
  // Fail at boot instead, naming exactly what's missing.
  if (parsed.data.LOOP_WALLET_PROVIDER === 'privy') {
    const missing: string[] = [];
    if (parsed.data.PRIVY_APP_ID === undefined) missing.push('PRIVY_APP_ID');
    if (parsed.data.PRIVY_APP_SECRET === undefined) missing.push('PRIVY_APP_SECRET');
    if (missing.length > 0) {
      throw new Error(
        `Invalid environment variables — LOOP_WALLET_PROVIDER=privy requires ${missing.join(
          ' and ',
        )} to be set (ADR 030). Unset LOOP_WALLET_PROVIDER to disable the wallet layer instead.`,
      );
    }
  }

  // ADR 031 / ADR 036 Phase D: issuer-secret ↔ issuer-address pinning.
  // A `LOOP_STELLAR_<ASSET>_ISSUER_SECRET` whose derived public key
  // doesn't match the configured `LOOP_STELLAR_<ASSET>_ISSUER` would
  // make the payout worker sign `interest_mint` payments from a
  // different account — a transfer rather than a mint, corrupting
  // issuance accounting silently. Boot-fail on mismatch (and on a
  // secret with no address to validate against) rather than
  // discovering it on the first nightly mint.
  const issuerPairs: Array<[string, string | undefined, string | undefined]> = [
    [
      'USDLOOP',
      parsed.data.LOOP_STELLAR_USDLOOP_ISSUER,
      parsed.data.LOOP_STELLAR_USDLOOP_ISSUER_SECRET,
    ],
    [
      'GBPLOOP',
      parsed.data.LOOP_STELLAR_GBPLOOP_ISSUER,
      parsed.data.LOOP_STELLAR_GBPLOOP_ISSUER_SECRET,
    ],
    [
      'EURLOOP',
      parsed.data.LOOP_STELLAR_EURLOOP_ISSUER,
      parsed.data.LOOP_STELLAR_EURLOOP_ISSUER_SECRET,
    ],
  ];
  for (const [asset, issuerAddress, issuerSecret] of issuerPairs) {
    if (issuerSecret === undefined) continue;
    if (issuerAddress === undefined) {
      throw new Error(
        `Invalid environment variables — LOOP_STELLAR_${asset}_ISSUER_SECRET is set but ` +
          `LOOP_STELLAR_${asset}_ISSUER is not (ADR 031). The secret must be validated against the ` +
          `configured issuer address; set both or neither.`,
      );
    }
    let derived: string;
    try {
      derived = Keypair.fromSecret(issuerSecret).publicKey();
    } catch {
      throw new Error(
        `Invalid environment variables — LOOP_STELLAR_${asset}_ISSUER_SECRET is not a valid ` +
          `Stellar secret key (Keypair derivation failed).`,
      );
    }
    if (derived !== issuerAddress) {
      throw new Error(
        `Invalid environment variables — LOOP_STELLAR_${asset}_ISSUER_SECRET derives account ` +
          `${derived}, which does not match LOOP_STELLAR_${asset}_ISSUER (${issuerAddress}). ` +
          `Signing interest mints with a non-issuer key would transfer instead of mint (ADR 031); ` +
          `fix the key material before booting.`,
      );
    }
  }

  // Hardening B3 (2026-07 plan): cross-field boot guards for the two
  // auth misconfigurations that previously only surfaced at request
  // time.
  //
  // 1. Native auth enabled with NO signing capability. verify-otp /
  //    refresh would 500 on every call (`getActiveSigner` throws) —
  //    an outage discovered by the first user, not the deploy. Both
  //    key families count: HS256 (`LOOP_JWT_SIGNING_KEY`) or RS256
  //    (`LOOP_JWT_RSA_PRIVATE_KEY`).
  if (
    parsed.data.LOOP_AUTH_NATIVE_ENABLED &&
    parsed.data.LOOP_JWT_SIGNING_KEY === undefined &&
    parsed.data.LOOP_JWT_RSA_PRIVATE_KEY === undefined
  ) {
    throw new Error(
      'Invalid environment variables — LOOP_AUTH_NATIVE_ENABLED=true requires a JWT signing key ' +
        '(LOOP_JWT_SIGNING_KEY or LOOP_JWT_RSA_PRIVATE_KEY, ADR 013 / ADR 030). Without one, every ' +
        'verify-otp/refresh call 500s. Set a key or disable native auth.',
    );
  }

  // 2. Production without the admin step-up key. Every destructive
  //    admin endpoint (credit-adjust / refunds / emissions /
  //    payout-retry / staff-role writes) would return 503
  //    STEP_UP_UNAVAILABLE — a silently-degraded admin surface that
  //    looks healthy until the first incident needs an intervention.
  //    Fail at boot; staging deploys that genuinely want the surface
  //    disabled opt out explicitly.
  if (
    parsed.data.NODE_ENV === 'production' &&
    parsed.data.LOOP_ADMIN_STEP_UP_SIGNING_KEY === undefined &&
    parsed.data.DISABLE_ADMIN_STEP_UP_ENFORCEMENT !== '1'
  ) {
    throw new Error(
      'Invalid environment variables — LOOP_ADMIN_STEP_UP_SIGNING_KEY must be set in production ' +
        '(ADR 028; hardening B3). Without it every destructive admin write 503s. Generate a 32+ char ' +
        'random secret, or set DISABLE_ADMIN_STEP_UP_ENFORCEMENT=1 to deliberately ship the surface disabled.',
    );
  }

  // A2-203: the fallback cashback split must respect the
  // `userCashback + margin + wholesale = 100` invariant. Reject a
  // misconfigured env at boot rather than silently over-granting
  // cashback at order-creation time.
  const userCashback = Number.parseFloat(parsed.data.DEFAULT_USER_CASHBACK_PCT_OF_CTX);
  const loopMargin = Number.parseFloat(parsed.data.DEFAULT_LOOP_MARGIN_PCT_OF_CTX);
  if (userCashback + loopMargin > 100) {
    throw new Error(
      `Invalid environment variables — DEFAULT_USER_CASHBACK_PCT_OF_CTX (${userCashback}%) ` +
        `+ DEFAULT_LOOP_MARGIN_PCT_OF_CTX (${loopMargin}%) exceeds 100% of face value. ` +
        `Wholesale (what Loop pays CTX) would go negative.`,
    );
  }

  // CF-25 / X-PRIV-03: validate the redeem envelope key decodes to
  // exactly 32 bytes when present. A wrong-length key would silently
  // write ciphertext nobody can later decrypt (the read path throws on
  // every order), so fail at boot instead. Optional → no constraint.
  if (
    parsed.data.LOOP_REDEEM_ENCRYPTION_KEY !== undefined &&
    parsed.data.LOOP_REDEEM_ENCRYPTION_KEY !== ''
  ) {
    const raw = parsed.data.LOOP_REDEEM_ENCRYPTION_KEY;
    const bytes = /^[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');
    if (bytes.length !== 32) {
      throw new Error(
        `Invalid environment variables — LOOP_REDEEM_ENCRYPTION_KEY must decode to 32 bytes ` +
          `(got ${bytes.length}); supply 32 random bytes as base64 or hex ` +
          `(e.g. \`openssl rand -base64 32\`).`,
      );
    }
  }

  return parsed.data;
}

/** Validated, typed environment configuration. */
export const env = parseEnv(process.env);
