import { z } from 'zod';
import { DEFAULT_CLIENT_IDS } from '@loop/shared';

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
 * Environment schema. Exported for testing; the validated `env` object
 * is what production code should consume.
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

  // Discord webhooks (optional — for notifications)
  DISCORD_WEBHOOK_ORDERS: z.string().url().optional(),
  DISCORD_WEBHOOK_MONITORING: z.string().url().optional(),

  // Error tracking (optional — get DSN from sentry.io)
  SENTRY_DSN: z.string().url().optional(),
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
