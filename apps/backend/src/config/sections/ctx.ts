// config sections: `ctx:` (upstream supplier + payment processor) and `catalog:` (ingestion/filtering) — ADR 052, A-018, A2-1922, ADR 033
import { z } from 'zod';
import { DEFAULT_CLIENT_IDS } from '@loop/shared';

export const ctxSchema = z.object({
  // file://, data:, or ftp:// URLs pass `z.string().url()` but cause SSRF or runtime fetch failures
  baseUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
      message: 'must use http or https protocol',
    }),

  // ADR 052: CTX is the payment processor; missing credentials prevent boot to avoid stuck `unpaid` orders
  credentials: z.object({
    key: z.string().min(1),
    secret: z.string().min(1),
  }),

  // A-018: defaults from `@loop/shared` prevent silent drift between web bundle and backend allowlist
  clientIds: z
    .object({
      web: z.string().default(DEFAULT_CLIENT_IDS.web),
      ios: z.string().default(DEFAULT_CLIENT_IDS.ios),
      android: z.string().default(DEFAULT_CLIENT_IDS.android),
    })
    .prefault({}),

  // ADR 052: chain-qualified currencies; CTX validates per company crypto permissions
  paymentCurrencies: z.array(z.string().min(1)).nonempty().default(['XLM']),

  // Attribution contract: creates CTX customer under Loop operator company for `X-User-Id` act-as
  userProvisioning: z
    .object({
      enabled: z.boolean().default(true),
    })
    .prefault({}),
});

export const catalogSchema = z
  .object({
    // Merchant sweep is hardcoded hourly in `merchants/sync-interval.ts` as fallback reconciler
    locationRefreshIntervalHours: z.number().int().positive().default(24),

    // A2-1922: ID-based deny-list applied at `mapUpstreamMerchant` to prevent denied IDs entering store/API
    merchantDenylist: z.array(z.string().min(1)).default([]),

    geoip: z
      .object({
        // ADR 033: MaxMind GeoLite2-Country .mmdb path for `GET /api/public/geo` first-guess
        databasePath: z.string().min(1).optional(),
      })
      .prefault({}),
  })
  .prefault({});
