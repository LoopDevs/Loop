import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.string().default('8080'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  // Gift card upstream API
  GIFT_CARD_API_BASE_URL: z.string().url(),
  GIFT_CARD_API_KEY: z.string().min(1),
  GIFT_CARD_API_SECRET: z.string().min(1),

  // JWT
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),

  // Refresh intervals (hours)
  REFRESH_INTERVAL_HOURS: z.coerce.number().int().positive().default(6),
  LOCATION_REFRESH_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),

  // Email (for OTP sending)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('noreply@loop.app'),

  // Image proxy: comma-separated list of allowed hostnames.
  // If set, only URLs from these hosts are fetched. Recommended in production.
  // Example: "cdn.giftcards.com,images.merchant.com"
  IMAGE_PROXY_ALLOWED_HOSTS: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error(`Invalid environment variables: ${missing}`);
}

/** Validated, typed environment configuration. */
export const env = parsed.data;
