import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';

// A2-1922: env mock is mutable so tests can flip the denylist
// per-scenario without resetting modules.
const { configState } = vi.hoisted(() => ({
  configState: {
    ctx: {
      baseUrl: 'http://test',
      credentials: { key: 'test-key', secret: 'test-secret' },
    },
    merchantDenylist: [] as string[],
  },
}));

vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        ctx: { ...actual.config.ctx, ...configState.ctx },
        catalog: { ...actual.config.catalog, merchantDenylist: configState.merchantDenylist },
      };
    },
  };
});

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

import {
  __resetMerchantStoreForTests,
  applyMerchantRemoval,
  applyMerchantUpsert,
  cancelPendingSnapshotPersist,
  refreshMerchants,
  getMerchants,
  warmStartMerchantsFromSnapshot,
} from '../sync.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

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

    expect(mockFetch).toHaveBeenCalledTimes(2);

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

    mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));
    await refreshMerchants();

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
    let resolveFirst!: (value: Response) => void;
    const firstFetchPromise = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    mockFetch.mockReturnValueOnce(firstFetchPromise);

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

    const firstRefresh = refreshMerchants();

    const secondRefresh = refreshMerchants();

    await secondRefresh;

    expect(mockFetch).toHaveBeenCalledTimes(1);

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
    expect(Array.isArray(store.merchants)).toBe(true);
  });

  it('skips individual malformed merchants without poisoning the page', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pagination: { page: 1, pages: 1, perPage: 100, total: 3 },
          result: [
            { id: 'good-1', name: 'Good One', enabled: true },
            { id: '', name: 'Missing ID', enabled: true },
            { name: 'No ID Field', enabled: true },
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

    await refreshMerchants();
    expect(getMerchants().merchants.find((m) => m.id === 'm-disabled')).toBeUndefined();
  });

  it('maps operator-scoped rows: effective status + per-link discount override', async () => {
    configState.ctx.credentials = { key: 'op-key', secret: 'op-secret' };
    try {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            pagination: { page: 1, pages: 1, perPage: 100000, total: 2 },
            result: [
              {
                id: 'm-linked',
                name: 'Linked',
                enabled: true,
                status: 'enabled',
                savingsPercentage: 400,
                link: { userDiscountBasisPoints: 750, userDiscountOverride: true },
              },
              { id: 'm-link-off', name: 'Link Off', enabled: true, status: 'disabled' },
            ],
          }),
          { status: 200 },
        ),
      );

      await refreshMerchants();

      const [, init] = mockFetch.mock.calls[0]!;
      expect((init as RequestInit).headers).toMatchObject({
        'X-Api-Key': 'op-key',
        'X-Api-Secret': 'op-secret',
      });

      const store = getMerchants();
      expect(store.merchantsById.get('m-linked')?.savingsPercentage).toBe(7.5);
      expect(store.merchantsById.has('m-link-off')).toBe(false);
    } finally {
      configState.ctx.credentials = { key: 'test-key', secret: 'test-secret' };
    }
  });

  describe('catalog.merchantDenylist (A2-1922)', () => {
    it('drops denylisted merchants from the catalog before they enter the store', async () => {
      configState.merchantDenylist = ['merchant-2', 'merchant-3'];
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
      configState.merchantDenylist = [];
    });

    it('treats an absent / empty list as a no-op (everything passes through)', async () => {
      configState.merchantDenylist = [];
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
      configState.merchantDenylist = [];
    });

    it('trims whitespace and ignores empty entries', async () => {
      configState.merchantDenylist = ['  bad-1 ', '', ' bad-2 ', ''];
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
      configState.merchantDenylist = [];
    });
  });

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
      expect(merchantsBySlug.get('adidas')).toBeUndefined();
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
      expect(merchantsBySlug.get('nike-ca')?.id).toBe('nike-ca-id');
      expect(merchantsBySlug.get('nike-canada-ca')).toBeUndefined();
      expect(merchantsById.get('nike-ca-id')?.slug).toBe('nike-ca');
    });

    it('transitional: un-renamed "Brand Country" + country still yields a unique slug', async () => {
      mockFetch.mockResolvedValueOnce(
        upstreamResponse(
          [
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

describe('ws-event store maintenance (applyMerchantUpsert / applyMerchantRemoval)', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    warnSpy.mockClear();
    snapshotState.saved = [];
    snapshotState.next = null;
    __resetMerchantStoreForTests();
    cancelPendingSnapshotPersist();
    mockFetch.mockResolvedValueOnce(
      upstreamResponse(
        [
          { id: 'm-1', name: 'Alpha', enabled: true },
          { id: 'm-2', name: 'Beta', enabled: true },
          { id: 'm-3', name: 'Gamma', enabled: true },
        ],
        1,
        1,
      ),
    );
    await refreshMerchants();
  });

  it('replaces an existing merchant IN PLACE — catalog order is stable', () => {
    applyMerchantUpsert({ id: 'm-2', name: 'Beta Updated', enabled: true });

    const store = getMerchants();
    expect(store.merchants.map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(store.merchantsById.get('m-2')?.name).toBe('Beta Updated');
    expect(store.merchantsBySlug.get('beta-updated')?.id).toBe('m-2');
    expect(store.merchantsBySlug.has('beta')).toBe(false);
  });

  it('appends a brand-new merchant', () => {
    applyMerchantUpsert({ id: 'm-4', name: 'Delta', enabled: true });
    const store = getMerchants();
    expect(store.merchants.map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-3', 'm-4']);
  });

  it('removes a merchant and its index entries; unknown ids are a no-op', () => {
    applyMerchantRemoval('m-3');
    const store = getMerchants();
    expect(store.merchants.map((m) => m.id)).toEqual(['m-1', 'm-2']);
    expect(store.merchantsById.has('m-3')).toBe(false);
    expect(store.merchantsBySlug.has('gamma')).toBe(false);

    applyMerchantRemoval('nope');
    expect(getMerchants().merchants).toHaveLength(2);
  });

  it('does not bump loadedAt (freshness signal stays "last full sweep")', () => {
    const before = getMerchants().loadedAt;
    applyMerchantUpsert({ id: 'm-2', name: 'Beta Updated', enabled: true });
    expect(getMerchants().loadedAt).toBe(before);
  });

  it('debounces the snapshot persist across a burst of events', async () => {
    vi.useFakeTimers();
    try {
      applyMerchantUpsert({ id: 'm-1', name: 'Alpha 2', enabled: true });
      applyMerchantUpsert({ id: 'm-2', name: 'Beta 2', enabled: true });
      applyMerchantRemoval('m-3');
      expect(snapshotState.saved).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(31_000);
      expect(snapshotState.saved).toHaveLength(2);
      expect(
        (snapshotState.saved[1]!.items as Array<{ id: string }>).map((m) => m.id).sort(),
      ).toEqual(['m-1', 'm-2']);
    } finally {
      vi.useRealTimers();
      cancelPendingSnapshotPersist();
    }
  });
});
