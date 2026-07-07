import { describe, it, expect, vi, beforeEach } from 'vitest';

// A2-1922: env mock is mutable so tests can flip the denylist
// per-scenario without resetting modules.
const { envState } = vi.hoisted(() => ({
  envState: {
    GIFT_CARD_API_BASE_URL: 'http://test',
    JWT_SECRET: 'test-secret-that-is-long-enough-32ch',
    JWT_REFRESH_SECRET: 'test-refresh-secret-long-enough-32',
    PORT: 8080,
    LOG_LEVEL: 'silent',
    REFRESH_INTERVAL_HOURS: 6,
    LOCATION_REFRESH_INTERVAL_HOURS: 24,
    EMAIL_FROM: 'test@test.com',
    LOOP_MERCHANT_DENYLIST: undefined as string | undefined,
  },
}));

vi.mock('../../env.js', () => ({ env: envState }));

// Stable warn spy so country-aware slug-collision tests can assert on it.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: warnSpy }) },
}));

const { snapshotState } = vi.hoisted(() => ({
  snapshotState: {
    saved: [] as Array<{ name: string; items: unknown[]; loadedAt: Date }>,
    next: null as null | { items: unknown[]; loadedAt: number },
  },
}));

vi.mock('../../ctx/catalog-snapshots.js', () => ({
  saveCatalogSnapshot: vi.fn(async (args: { name: string; items: unknown[]; loadedAt: Date }) => {
    snapshotState.saved.push(args);
  }),
  loadCatalogSnapshot: vi.fn(async (name: string) => {
    if (name !== 'merchants') return null;
    return snapshotState.next;
  }),
}));

// Mock circuit breaker to pass through to global fetch (avoids cross-test state leaks)
vi.mock('../../circuit-breaker.js', () => ({
  getAllCircuitStates: () => ({}),
  getUpstreamCircuit: () => ({
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
    getState: () => 'closed' as const,
    reset: () => {},
  }),
}));

import {
  __resetMerchantStoreForTests,
  refreshMerchants,
  getMerchants,
  warmStartMerchantsFromSnapshot,
} from '../sync.js';

// --- Mock fetch globally ---
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// --- Helpers to build upstream API responses ---

interface FakeUpstreamMerchant {
  id: string;
  name: string;
  slug?: string;
  country?: string;
  logoUrl?: string;
  cardImageUrl?: string;
  enabled: boolean;
  savingsPercentage?: number;
  denominationsType?: 'fixed' | 'min-max';
  denominations?: string[];
  currency?: string;
  info?: {
    intro?: string;
    description?: string;
    instructions?: string;
    terms?: string;
  };
}

function upstreamResponse(
  merchants: FakeUpstreamMerchant[],
  page: number,
  pages: number,
): Response {
  const body = {
    pagination: { page, pages, perPage: 100, total: merchants.length * pages },
    result: merchants,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('refreshMerchants', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    warnSpy.mockClear();
    snapshotState.saved = [];
    snapshotState.next = null;
    __resetMerchantStoreForTests();
  });

  it('fetches all pages and populates the merchant store', async () => {
    // Page 1 of 2
    mockFetch.mockResolvedValueOnce(
      upstreamResponse(
        [
          {
            id: 'merchant-1',
            name: 'Home Depot',
            logoUrl: 'https://img.test/hd.png',
            enabled: true,
            savingsPercentage: 1000,
          },
        ],
        1,
        2,
      ),
    );

    // Page 2 of 2
    mockFetch.mockResolvedValueOnce(
      upstreamResponse(
        [
          {
            id: 'merchant-2',
            name: 'Target',
            enabled: true,
            savingsPercentage: 500,
          },
        ],
        2,
        2,
      ),
    );

    await refreshMerchants();

    const store = getMerchants();
    expect(store.merchants).toHaveLength(2);
    const first = store.merchants[0]!;
    const second = store.merchants[1]!;
    expect(first.id).toBe('merchant-1');
    expect(first.name).toBe('Home Depot');
    expect(first.savingsPercentage).toBe(10.0);
    expect(second.id).toBe('merchant-2');
    expect(second.name).toBe('Target');
    expect(second.savingsPercentage).toBe(5.0);

    // Verify both pages were fetched
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify lookup maps are populated
    expect(store.merchantsById.get('merchant-1')?.name).toBe('Home Depot');
    expect(store.merchantsBySlug.get('home-depot')?.id).toBe('merchant-1');
    expect(store.merchantsBySlug.get('target')?.id).toBe('merchant-2');
    expect(snapshotState.saved).toHaveLength(1);
    expect(snapshotState.saved[0]).toMatchObject({
      name: 'merchants',
      items: expect.arrayContaining([expect.objectContaining({ id: 'merchant-1' })]),
    });
  });

  it('warm-starts from the last-good Postgres snapshot before upstream is reachable', async () => {
    snapshotState.next = {
      loadedAt: 1_780_188_400_000,
      items: [
        {
          id: 'snapshot-merchant',
          name: 'Snapshot Store',
          enabled: true,
          country: 'GB',
        },
      ],
    };

    await expect(warmStartMerchantsFromSnapshot()).resolves.toBe(true);
    mockFetch.mockResolvedValueOnce(new Response('CTX down', { status: 503 }));
    await refreshMerchants();

    const store = getMerchants();
    expect(store.loadedAt).toBe(1_780_188_400_000);
    expect(store.merchants).toHaveLength(1);
    expect(store.merchantsBySlug.get('snapshot-store-gb')?.id).toBe('snapshot-merchant');
  });

  it('maps upstream info fields (intro/description/instructions/terms) onto the merchant', async () => {
    // `intro` was parsed by the schema but dropped by the mapper before A4 —
    // guard the whole info-field-mapping class so no field silently vanishes.
    mockFetch.mockResolvedValueOnce(
      upstreamResponse(
        [
          {
            id: 'm-info',
            name: 'Aerie',
            enabled: true,
            info: {
              intro: 'Soft, comfy essentials',
              description: 'Aerie sells intimates and apparel.',
              instructions: 'Redeem online at ae.com or in store.',
              terms: 'No expiry. Not redeemable for cash.',
            },
          },
        ],
        1,
        1,
      ),
    );

    await refreshMerchants();

    const m = getMerchants().merchantsById.get('m-info')!;
    expect(m.intro).toBe('Soft, comfy essentials');
    expect(m.description).toBe('Aerie sells intimates and apparel.');
    expect(m.instructions).toBe('Redeem online at ae.com or in store.');
    expect(m.terms).toBe('No expiry. Not redeemable for cash.');
  });

  it('retains previous data when upstream returns an error', async () => {
    // First: seed the store with a successful refresh
    mockFetch.mockResolvedValueOnce(
      upstreamResponse(
        [
          {
            id: 'merchant-existing',
            name: 'Existing Store',
            enabled: true,
          },
        ],
        1,
        1,
      ),
    );
    await refreshMerchants();
    expect(getMerchants().merchants).toHaveLength(1);

    // Second: upstream returns 500
    mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));
    await refreshMerchants();

    // Store should still have the previous data
    const store = getMerchants();
    expect(store.merchants).toHaveLength(1);
    expect(store.merchants[0]!.id).toBe('merchant-existing');
  });

  it('skips disabled merchants', async () => {
    mockFetch.mockResolvedValueOnce(
      upstreamResponse(
        [
          {
            id: 'enabled-merchant',
            name: 'Active Store',
            enabled: true,
          },
          {
            id: 'disabled-merchant',
            name: 'Disabled Store',
            enabled: false,
          },
        ],
        1,
        1,
      ),
    );

    await refreshMerchants();

    const store = getMerchants();
    expect(store.merchants).toHaveLength(1);
    expect(store.merchants[0]!.id).toBe('enabled-merchant');
    expect(store.merchantsById.has('disabled-merchant')).toBe(false);
  });

  it('correctly parses fixed denominations', async () => {
    mockFetch.mockResolvedValueOnce(
      upstreamResponse(
        [
          {
            id: 'fixed-denom',
            name: 'Fixed Card',
            enabled: true,
            denominationsType: 'fixed',
            denominations: ['10', '25', '50', '100'],
            currency: 'USD',
          },
        ],
        1,
        1,
      ),
    );

    await refreshMerchants();

    const merchant = getMerchants().merchantsById.get('fixed-denom');
    expect(merchant).toBeDefined();
    expect(merchant!.denominations).toEqual({
      type: 'fixed',
      denominations: ['10', '25', '50', '100'],
      currency: 'USD',
    });
  });

  it('correctly parses min-max denominations', async () => {
    mockFetch.mockResolvedValueOnce(
      upstreamResponse(
        [
          {
            id: 'minmax-denom',
            name: 'Range Card',
            enabled: true,
            denominationsType: 'min-max',
            denominations: ['5', '500'],
            currency: 'EUR',
          },
        ],
        1,
        1,
      ),
    );

    await refreshMerchants();

    const merchant = getMerchants().merchantsById.get('minmax-denom');
    expect(merchant).toBeDefined();
    expect(merchant!.denominations).toEqual({
      type: 'min-max',
      denominations: ['5', '500'],
      currency: 'EUR',
      min: 5,
      max: 500,
    });
  });

  it('prevents concurrent refreshes via isMerchantRefreshing guard', async () => {
    // Create a fetch that we can manually control to keep the first refresh "in flight"
    let resolveFirst!: (value: Response) => void;
    const firstFetchPromise = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    mockFetch.mockReturnValueOnce(firstFetchPromise);

    // Also prepare a response for the second call in case the guard fails
    mockFetch.mockResolvedValueOnce(
      upstreamResponse(
        [
          {
            id: 'second-call',
            name: 'Should Not Appear',
            enabled: true,
          },
        ],
        1,
        1,
      ),
    );

    // Start the first refresh (will be stuck waiting on the fetch)
    const firstRefresh = refreshMerchants();

    // Immediately start a second refresh — should be skipped by the guard
    const secondRefresh = refreshMerchants();

    // Second refresh should return immediately (no-op)
    await secondRefresh;

    // Fetch should only have been called once (the first refresh's fetch)
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Now resolve the first fetch so it completes
    resolveFirst(
      upstreamResponse(
        [
          {
            id: 'first-call',
            name: 'First Merchant',
            enabled: true,
          },
        ],
        1,
        1,
      ),
    );

    await firstRefresh;

    // Store should only contain the first call's merchant
    const store = getMerchants();
    expect(store.merchants).toHaveLength(1);
    expect(store.merchants[0]!.id).toBe('first-call');
  });

  it('rejects upstream response with missing pagination field', async () => {
    // No `pagination` key at all — Zod parse fails, we throw, catch logs,
    // previous store is retained (empty in this test's isolation).
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }));

    await refreshMerchants();

    const store = getMerchants();
    // Failure retains previous data — since tests share module state, this
    // check is weak but the key thing is no throw propagated and no
    // malformed data was admitted to the store.
    expect(Array.isArray(store.merchants)).toBe(true);
  });

  it('skips individual malformed merchants without poisoning the page', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pagination: { page: 1, pages: 1, perPage: 100, total: 3 },
          result: [
            { id: 'good-1', name: 'Good One', enabled: true },
            { id: '', name: 'Missing ID', enabled: true }, // rejected
            { name: 'No ID Field', enabled: true }, // rejected
            { id: 'good-2', name: 'Good Two', enabled: true },
          ],
        }),
        { status: 200 },
      ),
    );

    await refreshMerchants();

    const store = getMerchants();
    const ids = store.merchants.map((m) => m.id);
    expect(ids).toContain('good-1');
    expect(ids).toContain('good-2');
    expect(ids).not.toContain('');
  });

  it('passes through the upstream enabled flag (not hardcoded true)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pagination: { page: 1, pages: 1, perPage: 100, total: 1 },
          result: [{ id: 'm-disabled', name: 'Disabled', enabled: false }],
        }),
        { status: 200 },
      ),
    );

    // With INCLUDE_DISABLED_MERCHANTS falsy (default), disabled merchants
    // are filtered out entirely.
    await refreshMerchants();
    expect(getMerchants().merchants.find((m) => m.id === 'm-disabled')).toBeUndefined();
  });

  // A2-1922: denylist filter
  describe('LOOP_MERCHANT_DENYLIST (A2-1922)', () => {
    it('drops denylisted merchants from the catalog before they enter the store', async () => {
      envState.LOOP_MERCHANT_DENYLIST = 'merchant-2,merchant-3';
      mockFetch.mockResolvedValueOnce(
        upstreamResponse(
          [
            { id: 'merchant-1', name: 'Keep', enabled: true },
            { id: 'merchant-2', name: 'Filter Me', enabled: true },
            { id: 'merchant-3', name: 'Filter Me Too', enabled: true },
            { id: 'merchant-4', name: 'Keep Too', enabled: true },
          ],
          1,
          1,
        ),
      );

      await refreshMerchants();
      const ids = getMerchants().merchants.map((m) => m.id);
      expect(ids).toContain('merchant-1');
      expect(ids).toContain('merchant-4');
      expect(ids).not.toContain('merchant-2');
      expect(ids).not.toContain('merchant-3');
      envState.LOOP_MERCHANT_DENYLIST = undefined;
    });

    it('treats absent / empty env as no-op (everything passes through)', async () => {
      envState.LOOP_MERCHANT_DENYLIST = '';
      mockFetch.mockResolvedValueOnce(
        upstreamResponse(
          [
            { id: 'm-a', name: 'A', enabled: true },
            { id: 'm-b', name: 'B', enabled: true },
          ],
          1,
          1,
        ),
      );

      await refreshMerchants();
      const ids = getMerchants().merchants.map((m) => m.id);
      expect(ids).toContain('m-a');
      expect(ids).toContain('m-b');
      envState.LOOP_MERCHANT_DENYLIST = undefined;
    });

    it('trims whitespace and ignores empty entries', async () => {
      envState.LOOP_MERCHANT_DENYLIST = '  bad-1 , , bad-2 ,';
      mockFetch.mockResolvedValueOnce(
        upstreamResponse(
          [
            { id: 'good-1', name: 'Good', enabled: true },
            { id: 'bad-1', name: 'Bad 1', enabled: true },
            { id: 'bad-2', name: 'Bad 2', enabled: true },
          ],
          1,
          1,
        ),
      );

      await refreshMerchants();
      const ids = getMerchants().merchants.map((m) => m.id);
      expect(ids).toEqual(['good-1']);
      envState.LOOP_MERCHANT_DENYLIST = undefined;
    });
  });

  // Country-aware slug index (feat/country-aware-merchant-slug). The
  // by-slug map keys off merchantSlug(merchant) — CTX slug, else
  // brand+country — so regional variants of one brand no longer collide.
  describe('country-aware merchantsBySlug', () => {
    it('gives same-brand-different-country merchants distinct slugs (no collision)', async () => {
      mockFetch.mockResolvedValueOnce(
        upstreamResponse(
          [
            { id: 'adidas-ca-id', name: 'adidas', country: 'CA', enabled: true },
            { id: 'adidas-us-id', name: 'adidas', country: 'US', enabled: true },
            { id: 'adidas-gb-id', name: 'adidas', country: 'GB', enabled: true },
          ],
          1,
          1,
        ),
      );

      await refreshMerchants();
      const { merchantsBySlug } = getMerchants();
      expect(merchantsBySlug.get('adidas-ca')?.id).toBe('adidas-ca-id');
      expect(merchantsBySlug.get('adidas-us')?.id).toBe('adidas-us-id');
      expect(merchantsBySlug.get('adidas-gb')?.id).toBe('adidas-gb-id');
      // No bare-brand collision — all three reachable, none clobbered.
      expect(merchantsBySlug.get('adidas')).toBeUndefined();
      // ...and the collision warn does NOT fire for distinct (brand, country).
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('prefers the CTX-provided slug over a derived one', async () => {
      mockFetch.mockResolvedValueOnce(
        upstreamResponse(
          [
            {
              id: 'nike-ca-id',
              name: 'Nike Canada',
              country: 'CA',
              slug: 'nike-ca',
              enabled: true,
            },
          ],
          1,
          1,
        ),
      );

      await refreshMerchants();
      const { merchantsBySlug, merchantsById } = getMerchants();
      // CTX slug wins — not the derived `nike-canada-ca`.
      expect(merchantsBySlug.get('nike-ca')?.id).toBe('nike-ca-id');
      expect(merchantsBySlug.get('nike-canada-ca')).toBeUndefined();
      // The CTX slug is carried onto the Merchant record.
      expect(merchantsById.get('nike-ca-id')?.slug).toBe('nike-ca');
    });

    it('transitional: un-renamed "Brand Country" + country still yields a unique slug', async () => {
      mockFetch.mockResolvedValueOnce(
        upstreamResponse(
          [
            // Old name form (country token still in the name), no CTX slug.
            { id: 'puma-ca-id', name: 'Puma Canada', country: 'CA', enabled: true },
            { id: 'puma-us-id', name: 'Puma', country: 'US', enabled: true },
          ],
          1,
          1,
        ),
      );

      await refreshMerchants();
      const { merchantsBySlug } = getMerchants();
      expect(merchantsBySlug.get('puma-canada-ca')?.id).toBe('puma-ca-id');
      expect(merchantsBySlug.get('puma-us')?.id).toBe('puma-us-id');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns only on a TRUE duplicate (same brand AND country)', async () => {
      mockFetch.mockResolvedValueOnce(
        upstreamResponse(
          [
            { id: 'lastminute-1', name: 'lastminute', country: 'GB', enabled: true },
            { id: 'lastminute-2', name: 'lastminute', country: 'GB', enabled: true },
          ],
          1,
          1,
        ),
      );

      await refreshMerchants();
      const { merchantsBySlug } = getMerchants();
      // Last-write-wins on a true collision; the warn fires for the operator.
      expect(merchantsBySlug.get('lastminute-gb')?.id).toBe('lastminute-2');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatchObject({
        slug: 'lastminute-gb',
        keptId: 'lastminute-2',
        droppedId: 'lastminute-1',
      });
    });
  });
});
