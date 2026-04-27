import type { Merchant } from '@loop/shared';
import { merchantSlug } from '@loop/shared';
import type { z } from 'zod';
import { logger } from '../logger.js';
import { env } from '../env.js';
import { getUpstreamCircuit } from '../circuit-breaker.js';
import { upstreamUrl } from '../upstream.js';
import { notifyCtxSchemaDrift } from '../discord.js';
import {
  UpstreamMerchantSchema,
  UpstreamListResponseSchema,
  mapUpstreamMerchant,
} from './sync-upstream.js';

// Re-exported for the CTX contract-test suite, which imports them
// from `merchants/sync.js`. Definitions live in `./sync-upstream.ts`.
export { UpstreamMerchantSchema, UpstreamListResponseSchema };

/**
 * A2-1915: condense a Zod issue array into a compact one-line
 * summary for the Discord embed.
 */
function summariseZodIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `[${i.path.join('.') || '·'}] ${i.code}: ${i.message}`)
    .join(' | ');
}

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
        notifyCtxSchemaDrift({
          surface: 'GET /merchants',
          issuesSummary: summariseZodIssues(parsed.error.issues),
        });
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

// `mapUpstreamMerchant` (the upstream → internal `Merchant` mapper)
// lives in `./sync-upstream.ts` alongside the Zod schemas.
