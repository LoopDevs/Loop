import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiException } from '@loop/shared';
import type * as PublicStats from '~/services/public-stats';
import { loader } from '../cashback.$slug-ssr';
import type { Route } from '../+types/cashback.$slug-ssr';

// P2-10/P2-11: the SSR loader must resolve the slug against the public merchant
// endpoint and throw a real HTTP 404 for an unknown merchant, so crawlers stop
// indexing the soft-404 (HTTP 200 "merchant not available") the component
// rendered client-side. Mock the same service the component's `getPublicMerchant`
// query uses (mirrors cashback.$slug.test.tsx's mock).
const { mocks } = vi.hoisted(() => ({ mocks: { getPublicMerchant: vi.fn() } }));

vi.mock('~/services/public-stats', async (importActual) => {
  const actual = (await importActual()) as typeof PublicStats;
  return {
    ...actual,
    getPublicMerchant: (idOrSlug: string, opts?: { country?: string }) =>
      mocks.getPublicMerchant(idOrSlug, opts),
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
  mocks.getPublicMerchant.mockReset();
});

describe('cashback.$slug-ssr loader', () => {
  it('throws a real 404 Response for an unknown merchant (not a soft-404)', async () => {
    mocks.getPublicMerchant.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'not found' }),
    );
    const thrown = await caught(runLoader({ slug: 'no-such-merchant' }));
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it('resolves (returns null, no throw) for a known merchant', async () => {
    mocks.getPublicMerchant.mockResolvedValue({
      id: 'm-1',
      name: 'Argos',
      slug: 'argos',
      logoUrl: null,
      userCashbackPct: '5.50',
      asOf: new Date().toISOString(),
    });
    await expect(runLoader({ slug: 'argos' })).resolves.toBeNull();
  });

  it('scopes the existence check to the URL country segment', async () => {
    mocks.getPublicMerchant.mockResolvedValue({ id: 'm-1', name: 'Argos', slug: 'argos' });
    await runLoader({ country: 'gb', lang: 'en', slug: 'argos' });
    expect(mocks.getPublicMerchant).toHaveBeenCalledWith('argos', { country: 'gb' });
  });

  it('fails open (no throw) on a non-404 backend error so a transient blip never 404s a real merchant', async () => {
    mocks.getPublicMerchant.mockRejectedValue(
      new ApiException(503, { code: 'UNAVAILABLE', message: 'upstream down' }),
    );
    await expect(runLoader({ slug: 'argos' })).resolves.toBeNull();
  });
});
