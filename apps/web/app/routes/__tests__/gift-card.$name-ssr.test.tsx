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

function runLoader(params: Record<string, string>): Promise<null> {
  return loader({ params } as unknown as Route.LoaderArgs);
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
});
