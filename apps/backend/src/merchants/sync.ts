import type { Merchant, MerchantDenominations } from '@loop/shared';
import { merchantSlug } from '@loop/shared';
import { logger } from '../logger.js';
import { env } from '../env.js';

interface UpstreamMerchant {
  id: string;
  name: string;
  logoUrl?: string;
  cardImageUrl?: string;
  mapPinUrl?: string;
  enabled: boolean;
  data?: string; // JSON blob
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

interface UpstreamMerchantData {
  savingsPercentage?: number;
  denominationMin?: number;
  denominationMax?: number;
  denominations?: string[];
  denominationsType?: 'fixed' | 'min-max';
  currency?: string;
  cachedLocationCount?: number;
  enabled?: boolean;
  description?: string;
  instructions?: string;
  terms?: string;
  info?: {
    description?: string;
    instructions?: string;
    terms?: string;
  };
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
      const base = env.GIFT_CARD_API_BASE_URL.replace(/\/$/, '');
      const url = new URL(`${base}/merchants`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('perPage', '100');

      const response = await fetch(url.toString(), {
        headers: {
          'X-Api-Key': env.GIFT_CARD_API_KEY,
          'X-Api-Secret': env.GIFT_CARD_API_SECRET,
        },
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
  void refreshMerchants();

  const intervalMs = env.REFRESH_INTERVAL_HOURS * 60 * 60 * 1000;
  setInterval(() => {
    void refreshMerchants();
  }, intervalMs);
}

function mapUpstreamMerchant(item: UpstreamMerchant): Merchant | null {
  if (!item.name) return null;

  let parsedData: UpstreamMerchantData = {};
  if (item.data) {
    try {
      parsedData = JSON.parse(item.data) as UpstreamMerchantData;
    } catch {
      // Ignore malformed data blobs
    }
  }

  const enabled = parsedData.enabled !== false && item.enabled;
  if (!enabled) return null;

  let denominations: MerchantDenominations | undefined;
  if (parsedData.denominationsType === 'fixed' && parsedData.denominations?.length) {
    denominations = {
      type: 'fixed',
      denominations: parsedData.denominations,
      currency: parsedData.currency ?? 'USD',
    };
  } else if (parsedData.denominationsType === 'min-max') {
    denominations = {
      type: 'min-max',
      denominations: [],
      currency: parsedData.currency ?? 'USD',
      ...(parsedData.denominationMin !== undefined ? { min: parsedData.denominationMin } : {}),
      ...(parsedData.denominationMax !== undefined ? { max: parsedData.denominationMax } : {}),
    };
  }

  const description = parsedData.info?.description ?? parsedData.description;
  const instructions = parsedData.info?.instructions ?? parsedData.instructions;
  const terms = parsedData.info?.terms ?? parsedData.terms;

  return {
    id: item.id,
    name: item.name,
    ...(item.logoUrl ? { logoUrl: item.logoUrl } : {}),
    ...(item.cardImageUrl ? { cardImageUrl: item.cardImageUrl } : {}),
    ...(parsedData.savingsPercentage !== undefined
      ? { savingsPercentage: parsedData.savingsPercentage / 100 }
      : {}),
    ...(denominations !== undefined ? { denominations } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(terms !== undefined ? { terms } : {}),
    enabled: true,
    ...(parsedData.cachedLocationCount !== undefined
      ? { locationCount: parsedData.cachedLocationCount }
      : {}),
  };
}
