import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiException } from '@loop/shared';
import type * as MerchantsService from '~/services/merchants';
import { loader } from '../gift-card.$name-ssr';
import type { Route } from '../+types/gift-card.$name-ssr';

// P2-10/P2-11: the SSR loader must resolve the slug against the public by-slug
// endpoint and throw a real HTTP 404 for an unknown merchant, so crawlers stop
// indexing the soft-404 (HTTP 200 "not found") the component rendered client-
// side. Mock the same service the component's `useMerchantBySlug` query uses.
const { mocks } = vi.hoisted(() => ({ mocks: { fetchMerchantBySlug: vi.fn() } }));

vi.mock('~/services/merchants', async (importActual) => {
  const actual = (await importActual()) as typeof MerchantsService;
  return {
    ...actual,
    fetchMerchantBySlug: (slug: string) => mocks.fetchMerchantBySlug(slug),
  };
});

function runLoader(
  params: Record<string, string>,
  url = 'http://localhost/gift-card/amazon',
): Promise<null> {
  return loader({ params, request: new Request(url) } as unknown as Route.LoaderArgs);
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

beforeEach(() => {
  mocks.fetchMerchantBySlug.mockReset();
});

describe('gift-card.$name-ssr loader', () => {
  it('throws a real 404 Response for an unknown merchant slug (not a soft-404)', async () => {
    mocks.fetchMerchantBySlug.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'not found' }),
    );
    const thrown = await caught(runLoader({ name: 'no-such-merchant' }));
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it('throws a 404 for a blank slug without hitting the backend', async () => {
    const thrown = await caught(runLoader({ name: '   ' }));
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
    expect(mocks.fetchMerchantBySlug).not.toHaveBeenCalled();
  });

  it('resolves (returns null, no throw) for a known merchant', async () => {
    mocks.fetchMerchantBySlug.mockResolvedValue({
      merchant: { id: 'm-1', name: 'Amazon', enabled: true },
    });
    await expect(runLoader({ name: 'amazon' })).resolves.toBeNull();
    expect(mocks.fetchMerchantBySlug).toHaveBeenCalledWith('amazon');
  });

  it('fails open (no throw) on a non-404 backend error', async () => {
    mocks.fetchMerchantBySlug.mockRejectedValue(
      new ApiException(500, { code: 'INTERNAL', message: 'boom' }),
    );
    await expect(runLoader({ name: 'amazon' })).resolves.toBeNull();
  });

  it("redirects to the merchant's country locale when the page locale differs", async () => {
    mocks.fetchMerchantBySlug.mockResolvedValue({
      merchant: { id: 'm-gb', name: 'Shop', country: 'GB', enabled: true },
    });
    const thrown = await caught(
      runLoader(
        { country: 'pt', lang: 'en', name: 'shop-gb' },
        'http://localhost/pt/en/gift-card/shop-gb?ref=1',
      ),
    );
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get('Location')).toBe('/gb/en/gift-card/shop-gb?ref=1');
  });

  it("redirects an unprefixed URL into the merchant's country locale", async () => {
    mocks.fetchMerchantBySlug.mockResolvedValue({
      merchant: { id: 'm-gb', name: 'Shop', country: 'GB', enabled: true },
    });
    const thrown = await caught(
      runLoader({ name: 'shop-gb' }, 'http://localhost/gift-card/shop-gb'),
    );
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get('Location')).toBe('/gb/en/gift-card/shop-gb');
  });

  it('resolves without redirecting when the page already sits in the merchant country', async () => {
    mocks.fetchMerchantBySlug.mockResolvedValue({
      merchant: { id: 'm-gb', name: 'Shop', country: 'GB', enabled: true },
    });
    await expect(
      runLoader(
        { country: 'gb', lang: 'en', name: 'shop-gb' },
        'http://localhost/gb/en/gift-card/shop-gb',
      ),
    ).resolves.toBeNull();
  });

  it('resolves without redirecting for a merchant in an unrouted country', async () => {
    mocks.fetchMerchantBySlug.mockResolvedValue({
      merchant: { id: 'm-iq', name: 'Shop', country: 'IQ', enabled: true },
    });
    await expect(
      runLoader(
        { country: 'pt', lang: 'en', name: 'shop-iq' },
        'http://localhost/pt/en/gift-card/shop-iq',
      ),
    ).resolves.toBeNull();
  });
});
