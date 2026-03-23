import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../env.js', () => ({
  env: {
    GIFT_CARD_API_BASE_URL: 'http://test',
    JWT_SECRET: 'test-secret-that-is-long-enough-32ch',
    JWT_REFRESH_SECRET: 'test-refresh-secret-long-enough-32',
    PORT: 8080,
    LOG_LEVEL: 'silent',
    REFRESH_INTERVAL_HOURS: 6,
    LOCATION_REFRESH_INTERVAL_HOURS: 24,
    EMAIL_FROM: 'test@test.com',
  },
}));

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) },
}));

// Mock circuit breaker to pass through to global fetch (avoids cross-test state leaks)
vi.mock('../../circuit-breaker.js', () => ({
  upstreamCircuit: {
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
    getState: () => 'closed' as const,
    reset: () => {},
  },
}));

import { merchantSlug } from '@loop/shared';
import { refreshMerchants, getMerchants } from '../sync.js';

// --- Mock fetch globally ---
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// --- Helpers to build upstream API responses ---

interface FakeUpstreamMerchant {
  id: string;
  name: string;
  logoUrl?: string;
  cardImageUrl?: string;
  enabled: boolean;
  savingsPercentage?: number;
  denominationsType?: 'fixed' | 'min-max';
  denominations?: string[];
  currency?: string;
  info?: {
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

describe('merchantSlug', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(merchantSlug('Home Depot')).toBe('home-depot');
  });

  it('strips non-alphanumeric characters', () => {
    expect(merchantSlug("Dunkin' Donuts")).toBe('dunkin-donuts');
  });

  it('handles multiple consecutive spaces', () => {
    expect(merchantSlug('Some   Store')).toBe('some-store');
  });

  it('returns empty string for empty input', () => {
    expect(merchantSlug('')).toBe('');
  });

  it('handles names with numbers', () => {
    expect(merchantSlug('7-Eleven')).toBe('7-eleven');
  });

  it('handles already-lowercase names', () => {
    expect(merchantSlug('target')).toBe('target');
  });
});

describe('refreshMerchants', () => {
  beforeEach(() => {
    mockFetch.mockReset();
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
});
