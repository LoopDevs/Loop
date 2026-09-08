/**
 * config sections: `ctx:` (the upstream supplier + payment processor)
 * and `catalog:` (how Loop ingests and filters CTX's merchant data).
 *
 * See `./server.ts` for what a section module is.
 */
import { z } from 'zod';
import { DEFAULT_CLIENT_IDS } from '@loop/shared';

export const ctxSchema = z.object({
  // Upstream gift card API. Must be http or https — a file://, data:,
  // or ftp:// URL would be accepted by `z.string().url()` but is never
  // correct here, and would either SSRF a local file or break upstream
  // fetches at runtime.
  baseUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
      message: 'must use http or https protocol',
    }),

  // Operator API credentials. Required: CTX is the payment processor
  // (ADR 052) — they authenticate every upstream surface (order create
  // + status mirror, merchant catalog + /locations scoping, both /ws
  // topic subscriptions), so a deployment without them can't do
  // anything useful and refuses to boot rather than come up with orders
  // that never leave `unpaid`.
  //
  // Grouped under `credentials:` rather than sitting as two more keys
  // beside `baseUrl` so it reads as one secret-bearing unit — the pair
  // is always set together, rotated together, and is the only part of
  // this section that must not be shared.
  credentials: z.object({
    key: z.string().min(1),
    secret: z.string().min(1),
  }),

  // Client IDs for upstream auth — one per platform. Defaults come from
  // `@loop/shared/DEFAULT_CLIENT_IDS` so `apps/web` (which sends
  // `X-Client-Id`) and the backend allowlist in `requireAuth()` can't
  // drift silently (audit A-018). Per-deployment overrides stay
  // supported; `loadConfig` warns if the effective value diverges from
  // the shared default, so operators remember to rebuild the web bundle
  // too — otherwise the client-id allowlist rejects authenticated
  // requests after login.
  clientIds: z
    .object({
      web: z.string().default(DEFAULT_CLIENT_IDS.web),
      ios: z.string().default(DEFAULT_CLIENT_IDS.ios),
      android: z.string().default(DEFAULT_CLIENT_IDS.android),
    })
    .prefault({}),

  // ADR 052: chain-qualified CTX payment currencies Loop offers at
  // checkout (e.g. `[XLM, DASH, ETH.USDT]`). The customer pays CTX
  // directly in one of these; CTX validates and has the final say per
  // company crypto permissions.
  //
  // A real YAML list. This was `LOOP_CTX_PAYMENT_CURRENCIES`, a
  // comma-separated string that every consumer had to split and trim by
  // hand — one of three such pseudo-lists the env format forced on us.
  paymentCurrencies: z.array(z.string().min(1)).nonempty().default(['XLM']),

  // Attributed-operator-traffic contract: async CTX customer
  // provisioning at signup/login (`ctx/user-provisioning.ts`). When
  // enabled, each Loop-native user gets a CTX customer created under
  // Loop's operator company — silent, fire-and-forget, never blocking
  // auth — and the returned id lands in `users.ctx_user_id` so
  // procurement can act-as the customer (`X-User-Id`). Default true:
  // attribution is the intended posture wherever the operator
  // credentials above exist. Set false to fall back to anonymous
  // operator traffic (e.g. an environment with no CTX-side Loop
  // company).
  userProvisioning: z
    .object({
      enabled: z.boolean().default(true),
    })
    .prefault({}),
});

export const catalogSchema = z
  .object({
    // Refresh interval for the location sweep. The merchant sweep has no
    // equivalent knob: it's hardcoded hourly (merchants/sync-interval.ts)
    // — it's only the fallback reconciler behind the ws maintainer, not
    // worth a setting.
    locationRefreshIntervalHours: z.number().int().positive().default(24),

    // A2-1922: CTX merchant IDs to filter out of the catalog at sync
    // time. Operator-controlled deny-list for merchants Loop refuses to
    // resell — slurs in the brand name, upstream CTX entries we want
    // temporarily hidden during a dispute, or commercial relationships
    // Loop hasn't agreed to. The filter applies at `mapUpstreamMerchant`
    // so denied IDs never enter the store, never reach the public API,
    // and never show up in the admin catalog. CTX's upstream catalog is
    // unchanged.
    //
    // ID-based rather than name-substring matching because IDs are
    // stable; CTX may rename a merchant without notice. If a
    // name-pattern filter is needed for a class of brands, that's a
    // follow-up (an admin-managed field rather than static config).
    merchantDenylist: z.array(z.string().min(1)).default([]),

    geoip: z
      .object({
        // Path to an operator-provided MaxMind GeoLite2-Country .mmdb
        // (ADR 033). Powers the `GET /api/public/geo` first-guess for
        // the region selector. Unset → that endpoint returns the US
        // default and the web client falls back to navigator.language.
        databasePath: z.string().min(1).optional(),
      })
      .prefault({}),
  })
  .prefault({});
