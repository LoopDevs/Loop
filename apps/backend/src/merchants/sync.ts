import type { Merchant, MerchantDenominations } from '@loop/shared';
import { merchantSlug } from '@loop/shared';
import { z } from 'zod';
import { logger } from '../logger.js';
import { env } from '../env.js';
import { getUpstreamCircuit } from '../circuit-breaker.js';
import { upstreamUrl } from '../upstream.js';

/**
 * Zod schema for upstream CTX merchants. Required fields (id, name, enabled)
 * are validated strictly; everything else is optional because CTX sometimes
 * omits them. `.passthrough()` preserves unknown fields without rejection.
 */
// Size caps stop a compromised or buggy upstream from bloating every merchant
// list response (which we cache and serve to every client). Generous relative
// to real merchant data but tight enough to catch "CTX returns a 1MB string".
const MAX_NAME_LENGTH = 256;
const MAX_ID_LENGTH = 128;
const MAX_URL_LENGTH = 2048;
const MAX_CURRENCY_LENGTH = 10;
const MAX_INFO_LENGTH = 50_000;

// A2-1706: exported so the contract-test suite can parse recorded
// CTX fixtures through them at PR-time and detect schema drift.
export const UpstreamMerchantSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_LENGTH),
    name: z.string().min(1).max(MAX_NAME_LENGTH),
    slug: z.string().max(MAX_NAME_LENGTH).optional(),
    logoUrl: z.string().max(MAX_URL_LENGTH).optional(),
    cardImageUrl: z.string().max(MAX_URL_LENGTH).optional(),
    mapPinUrl: z.string().max(MAX_URL_LENGTH).optional(),
    enabled: z.boolean(),
    country: z.string().max(MAX_CURRENCY_LENGTH).optional(),
    currency: z.string().max(MAX_CURRENCY_LENGTH).optional(),
    savingsPercentage: z.number().optional(),
    userDiscount: z.number().optional(),
    denominationsType: z.enum(['fixed', 'min-max']).optional(),
    denominations: z.array(z.string().max(32)).optional(),
    denominationValues: z.array(z.string().max(32)).optional(),
    locationCount: z.number().optional(),
    cachedLocationCount: z.number().optional(),
    redeemType: z.string().max(64).optional(),
    redeemLocation: z.string().max(64).optional(),
    info: z
      .object({
        description: z.string().max(MAX_INFO_LENGTH).optional(),
        instructions: z.string().max(MAX_INFO_LENGTH).optional(),
        intro: z.string().max(MAX_INFO_LENGTH).optional(),
        terms: z.string().max(MAX_INFO_LENGTH).optional(),
      })
      .optional(),
  })
  .passthrough();

type UpstreamMerchant = z.infer<typeof UpstreamMerchantSchema>;

// Wrap individual merchants in .safeParse so one malformed entry does not
// poison the whole page — we skip it and keep going.
export const UpstreamListResponseSchema = z
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

/**
 * A2-1922: parse `LOOP_MERCHANT_DENYLIST` once per refresh tick. The
 * list is comma-separated CTX merchant IDs. Whitespace is trimmed;
 * empty entries are dropped. Returns an empty Set when the env var
 * is absent or empty. Read every refresh so an ops flip via
 * `fly secrets set LOOP_MERCHANT_DENYLIST=...` takes effect on the
 * next 6h tick (or sooner via the admin force-refresh button)
 * without a restart.
 */
function readMerchantDenylist(): ReadonlySet<string> {
  const raw = env.LOOP_MERCHANT_DENYLIST;
  if (raw === undefined || raw.trim() === '') return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

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
 * Outcome of a forced admin-triggered merchant refresh.
 *
 * - `triggered: true`  — this call acquired the lock and the store
 *   advanced (or the upstream failed, in which case `triggered` is
 *   still true but the thrown error is the signal).
 * - `triggered: false` — another refresh was already in flight, so
 *   this call coalesced into it. The admin sees the post-sync
 *   `loadedAt` regardless. (Two admins clicking the button at the
 *   same moment produce one upstream sweep.)
 */
export interface RefreshOutcome {
  triggered: boolean;
}

/**
 * Fetches all merchant pages from the upstream API and atomically replaces
 * the in-memory store. Fire-and-forget — catches and logs any error,
 * then returns without signalling the caller. The background timer uses
 * this form; admin handlers call `forceRefreshMerchants()` to get the
 * outcome + a rethrown error on failure.
 */
export async function refreshMerchants(): Promise<void> {
  await refreshMerchantsInternal();
}

/**
 * Admin-triggered variant. Returns `{ triggered }` so the caller can
 * tell a real sweep from a coalesced short-circuit, and rethrows any
 * upstream error so the handler can map it to a 502 response. Keeps
 * the background timer's swallow-and-log semantics intact on
 * `refreshMerchants()`.
 */
export async function forceRefreshMerchants(): Promise<RefreshOutcome> {
  return refreshMerchantsInternal({ rethrow: true });
}

async function refreshMerchantsInternal(opts: { rethrow?: boolean } = {}): Promise<RefreshOutcome> {
  if (isMerchantRefreshing) return { triggered: false };
  isMerchantRefreshing = true;
  const log = logger.child({ module: 'merchants-sync' });
  log.info('Refreshing merchant data from upstream API');

  const merchants: Merchant[] = [];
  let page = 1;
  let totalPages = 1;
  // A2-1922: snapshot the denylist once at refresh start so a mid-
  // refresh env flip can't half-apply across pages.
  const denylist = readMerchantDenylist();

  try {
    while (page <= totalPages && page <= MAX_PAGES) {
      const url = new URL(upstreamUrl('/merchants'));
      url.searchParams.set('page', String(page));
      url.searchParams.set('perPage', '100');

      const response = await getUpstreamCircuit('merchants').fetch(url.toString(), {
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
        // A2-1922: drop denylisted merchants before they enter the
        // in-memory store. Logged at info-level so an operator can
        // verify the filter is firing (and that `INCLUDE_DISABLED_MERCHANTS`
        // dev-mode override hasn't accidentally re-enabled them).
        if (denylist.has(merchantParsed.data.id)) {
          log.info(
            { merchantId: merchantParsed.data.id, merchantName: merchantParsed.data.name },
            'Merchant filtered by LOOP_MERCHANT_DENYLIST',
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
    // Build merchantsBySlug explicitly so a slug collision (e.g. `T-Mobile`
    // and `T Mobile` both slugify to `t-mobile`) is visible in logs rather
    // than silently clobbering the first entry. Frontend links only see
    // the last-inserted merchant for a given slug, so the operator needs a
    // signal to rename one of the conflicting merchants upstream.
    const merchantsBySlug = new Map<string, Merchant>();
    for (const m of merchants) {
      const slug = merchantSlug(m.name);
      const existing = merchantsBySlug.get(slug);
      if (existing !== undefined) {
        log.warn(
          {
            slug,
            keptId: m.id,
            keptName: m.name,
            droppedId: existing.id,
            droppedName: existing.name,
          },
          'Merchant slug collision — later merchant wins, earlier entry unreachable by slug',
        );
      }
      merchantsBySlug.set(slug, m);
    }
    store = { merchants, merchantsById, merchantsBySlug, loadedAt: Date.now() };
    log.info({ count: merchants.length }, 'Merchant data refreshed');
  } catch (err) {
    log.error({ err }, 'Failed to refresh merchant data — retaining previous data');
    if (opts.rethrow === true) throw err;
  } finally {
    isMerchantRefreshing = false;
  }
  return { triggered: true };
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
