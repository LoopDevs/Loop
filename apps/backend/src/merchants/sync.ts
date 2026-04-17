import type { Merchant, MerchantDenominations } from '@loop/shared';
import { merchantSlug } from '@loop/shared';
import { z } from 'zod';
import { logger } from '../logger.js';
import { env } from '../env.js';
import { upstreamCircuit } from '../circuit-breaker.js';
import { upstreamUrl } from '../upstream.js';

/**
 * Zod schema for upstream CTX merchants. Required fields (id, name, enabled)
 * are validated strictly; everything else is optional because CTX sometimes
 * omits them. `.passthrough()` preserves unknown fields without rejection.
 */
const UpstreamMerchantSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().optional(),
    logoUrl: z.string().optional(),
    cardImageUrl: z.string().optional(),
    mapPinUrl: z.string().optional(),
    enabled: z.boolean(),
    country: z.string().optional(),
    currency: z.string().optional(),
    savingsPercentage: z.number().optional(),
    userDiscount: z.number().optional(),
    denominationsType: z.enum(['fixed', 'min-max']).optional(),
    denominations: z.array(z.string()).optional(),
    denominationValues: z.array(z.string()).optional(),
    locationCount: z.number().optional(),
    cachedLocationCount: z.number().optional(),
    redeemType: z.string().optional(),
    redeemLocation: z.string().optional(),
    info: z
      .object({
        description: z.string().optional(),
        instructions: z.string().optional(),
        intro: z.string().optional(),
        terms: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

type UpstreamMerchant = z.infer<typeof UpstreamMerchantSchema>;

// Wrap individual merchants in .safeParse so one malformed entry does not
// poison the whole page — we skip it and keep going.
const UpstreamListResponseSchema = z
  .object({
    pagination: z.object({
      page: z.number().int().nonnegative(),
      pages: z.number().int().nonnegative(),
      perPage: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
    result: z.array(z.unknown()),
  })
  .passthrough();

// Defensive ceiling: if upstream ever reports an absurd `pages` value (bug or
// misconfiguration), we cap iteration instead of looping for hours.
const MAX_PAGES = 100;

interface MerchantStore {
  merchants: Merchant[];
  merchantsById: Map<string, Merchant>;
  merchantsBySlug: Map<string, Merchant>;
  loadedAt: number;
}

// loadedAt starts at 0 so /health reports merchants as stale until the first
// successful refresh lands. Previously it was set to Date.now() at module
// load, which let /health report 'healthy' for ~12h even with empty data.
let store: MerchantStore = {
  merchants: [],
  merchantsById: new Map(),
  merchantsBySlug: new Map(),
  loadedAt: 0,
};

/** Returns the current merchant snapshot. */
export function getMerchants(): MerchantStore {
  return store;
}

let isMerchantRefreshing = false;

/**
 * Fetches all merchant pages from the upstream API and atomically replaces
 * the in-memory store.
 */
export async function refreshMerchants(): Promise<void> {
  if (isMerchantRefreshing) return;
  isMerchantRefreshing = true;
  const log = logger.child({ module: 'merchants-sync' });
  log.info('Refreshing merchant data from upstream API');

  const merchants: Merchant[] = [];
  let page = 1;
  let totalPages = 1;

  try {
    while (page <= totalPages && page <= MAX_PAGES) {
      const url = new URL(upstreamUrl('/merchants'));
      url.searchParams.set('page', String(page));
      url.searchParams.set('perPage', '100');

      const response = await upstreamCircuit.fetch(url.toString(), {
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`Upstream merchants API returned ${response.status}`);
      }

      const raw = await response.json();
      const parsed = UpstreamListResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `Upstream merchants response has unexpected shape: ${parsed.error.message}`,
        );
      }
      totalPages = parsed.data.pagination.pages;

      for (const item of parsed.data.result) {
        const merchantParsed = UpstreamMerchantSchema.safeParse(item);
        if (!merchantParsed.success) {
          log.warn(
            { issues: merchantParsed.error.issues },
            'Skipping malformed merchant from upstream',
          );
          continue;
        }
        const merchant = mapUpstreamMerchant(merchantParsed.data);
        if (merchant !== null) {
          merchants.push(merchant);
        }
      }

      page++;
    }
    if (page > MAX_PAGES && page <= totalPages) {
      log.warn({ page, totalPages }, 'Hit MAX_PAGES cap while paginating merchants — truncating');
    }

    const merchantsById = new Map(merchants.map((m) => [m.id, m]));
    const merchantsBySlug = new Map(merchants.map((m) => [merchantSlug(m.name), m]));
    store = { merchants, merchantsById, merchantsBySlug, loadedAt: Date.now() };
    log.info({ count: merchants.length }, 'Merchant data refreshed');
  } catch (err) {
    log.error({ err }, 'Failed to refresh merchant data — retaining previous data');
  } finally {
    isMerchantRefreshing = false;
  }
}

let refreshInterval: NodeJS.Timeout | null = null;

/** Starts the background refresh timer. Call once at startup. */
export function startMerchantRefresh(): void {
  const log = logger.child({ module: 'merchants-sync' });
  void refreshMerchants();

  const intervalMs = env.REFRESH_INTERVAL_HOURS * 60 * 60 * 1000;
  const staleMs = intervalMs * 2;
  refreshInterval = setInterval(() => {
    if (Date.now() - store.loadedAt > staleMs && store.merchants.length > 0) {
      log.warn(
        { ageMs: Date.now() - store.loadedAt, threshold: staleMs },
        'Merchant data is stale — refresh may be failing',
      );
    }
    void refreshMerchants();
  }, intervalMs);
}

/** Stops the background refresh timer. Intended for graceful shutdown. */
export function stopMerchantRefresh(): void {
  if (refreshInterval !== null) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

/**
 * Maps an upstream CTX merchant to our Merchant type.
 * The upstream returns all fields flat (no nested `data` JSON blob).
 */
function mapUpstreamMerchant(item: UpstreamMerchant): Merchant | null {
  if (!item.name) return null;
  // NOTE: CTX currently returns all 117 merchants with enabled: true.
  // This filter only matters if CTX starts returning disabled merchants.
  if (!item.enabled && !env.INCLUDE_DISABLED_MERCHANTS) return null;

  // Parse denominations from the flat upstream fields
  let denominations: MerchantDenominations | undefined;
  const currency = item.currency ?? 'USD';

  if (item.denominationsType === 'fixed' && item.denominations?.length) {
    denominations = {
      type: 'fixed',
      denominations: item.denominations,
      currency,
    };
  } else if (item.denominationsType === 'min-max' && item.denominations?.length) {
    // Upstream sends min-max as denominations array: ["5", "200"] = [$5, $200]
    const values = item.denominations
      .map(Number)
      .filter((n) => !isNaN(n))
      .sort((a, b) => a - b);
    denominations = {
      type: 'min-max',
      denominations: item.denominations,
      currency,
      ...(values[0] !== undefined ? { min: values[0] } : {}),
      ...(values[values.length - 1] !== undefined ? { max: values[values.length - 1] } : {}),
    };
  }

  // savingsPercentage from upstream is in hundredths (e.g. 400 = 4.00%).
  // Convert to percentage for display (4.0).
  const savingsPercentage =
    item.savingsPercentage !== undefined ? item.savingsPercentage / 100 : undefined;

  const description = item.info?.description;
  const instructions = item.info?.instructions;
  const terms = item.info?.terms;
  const locationCount = item.locationCount ?? item.cachedLocationCount;

  return {
    id: item.id,
    name: item.name,
    ...(item.logoUrl ? { logoUrl: item.logoUrl } : {}),
    ...(item.cardImageUrl ? { cardImageUrl: item.cardImageUrl } : {}),
    ...(savingsPercentage !== undefined ? { savingsPercentage } : {}),
    ...(denominations !== undefined ? { denominations } : {}),
    ...(description ? { description } : {}),
    ...(instructions ? { instructions } : {}),
    ...(terms ? { terms } : {}),
    // Reflect the actual upstream flag — hardcoding true was a bug that
    // only didn't bite because CTX currently returns all merchants enabled.
    // With INCLUDE_DISABLED_MERCHANTS=true (dev), this lets the UI see the
    // real state instead of a falsified `enabled: true` on every record.
    enabled: item.enabled,
    ...(locationCount !== undefined ? { locationCount } : {}),
  };
}
