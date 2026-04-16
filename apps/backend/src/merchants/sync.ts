import type { Merchant, MerchantDenominations } from '@loop/shared';
import { merchantSlug } from '@loop/shared';
import { logger } from '../logger.js';
import { env } from '../env.js';
import { upstreamCircuit } from '../circuit-breaker.js';
import { upstreamUrl } from '../upstream.js';

/** Shape returned by the upstream CTX merchants endpoint. */
interface UpstreamMerchant {
  id: string;
  name: string;
  slug?: string;
  logoUrl?: string;
  cardImageUrl?: string;
  mapPinUrl?: string;
  enabled: boolean;
  country?: string;
  currency?: string;
  savingsPercentage?: number;
  userDiscount?: number;
  denominationsType?: 'fixed' | 'min-max';
  denominations?: string[];
  denominationValues?: string[];
  locationCount?: number;
  cachedLocationCount?: number;
  redeemType?: string;
  redeemLocation?: string;
  info?: {
    description?: string;
    instructions?: string;
    intro?: string;
    terms?: string;
  };
}

interface UpstreamListResponse {
  pagination: {
    page: number;
    pages: number;
    perPage: number;
    total: number;
  };
  result: UpstreamMerchant[];
}

interface MerchantStore {
  merchants: Merchant[];
  merchantsById: Map<string, Merchant>;
  merchantsBySlug: Map<string, Merchant>;
  loadedAt: number;
}

let store: MerchantStore = {
  merchants: [],
  merchantsById: new Map(),
  merchantsBySlug: new Map(),
  loadedAt: Date.now(),
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
    while (page <= totalPages) {
      const url = new URL(upstreamUrl('/merchants'));
      url.searchParams.set('page', String(page));
      url.searchParams.set('perPage', '100');

      const response = await upstreamCircuit.fetch(url.toString(), {
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`Upstream merchants API returned ${response.status}`);
      }

      const data = (await response.json()) as UpstreamListResponse;
      totalPages = data.pagination.pages;

      for (const item of data.result) {
        const merchant = mapUpstreamMerchant(item);
        if (merchant !== null) {
          merchants.push(merchant);
        }
      }

      page++;
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

/** Starts the background refresh timer. Call once at startup. */
export function startMerchantRefresh(): void {
  const log = logger.child({ module: 'merchants-sync' });
  void refreshMerchants();

  const intervalMs = env.REFRESH_INTERVAL_HOURS * 60 * 60 * 1000;
  const staleMs = intervalMs * 2;
  setInterval(() => {
    if (Date.now() - store.loadedAt > staleMs && store.merchants.length > 0) {
      log.warn(
        { ageMs: Date.now() - store.loadedAt, threshold: staleMs },
        'Merchant data is stale — refresh may be failing',
      );
    }
    void refreshMerchants();
  }, intervalMs);
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
    enabled: true,
    ...(locationCount !== undefined ? { locationCount } : {}),
  };
}
