import { z } from 'zod';

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
  // Client IDs for upstream auth — one per platform
  CTX_CLIENT_ID_WEB: z.string().default('loopweb'),
  CTX_CLIENT_ID_IOS: z.string().default('loopios'),
  CTX_CLIENT_ID_ANDROID: z.string().default('loopandroid'),
  // Optional API credentials — needed for endpoints that require auth (e.g. /locations)
  GIFT_CARD_API_KEY: z.string().optional(),
  GIFT_CARD_API_SECRET: z.string().optional(),

  // Refresh intervals (hours)
  REFRESH_INTERVAL_HOURS: z.coerce.number().int().positive().default(6),
  LOCATION_REFRESH_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),

  // Dev mode: include disabled merchants so UI can be tested before CTX enables them
  INCLUDE_DISABLED_MERCHANTS: z.coerce.boolean().default(false),

  // Image proxy: comma-separated list of allowed hostnames.
  // If set, only URLs from these hosts are fetched. Recommended in production.
  // Example: "cdn.giftcards.com,images.merchant.com"
  IMAGE_PROXY_ALLOWED_HOSTS: z.string().optional(),

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

  return parsed.data;
}

/** Validated, typed environment configuration. */
export const env = parseEnv(process.env);
