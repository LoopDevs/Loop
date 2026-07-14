import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Merchant } from '@loop/shared';
import { brandSlug } from '@loop/shared';
import type * as MerchantsService from '~/services/merchants';
import { loader } from '../brand.$slug-ssr';
import type { Route } from '../+types/brand.$slug-ssr';

// P2-10/P2-11: the SSR loader must reproduce the component's country-scoped
// brand grouping server-side and throw a real HTTP 404 for an unknown brand
// slug, so crawlers stop indexing the soft-404 (HTTP 200 "Brand not found") the
// component rendered client-side. `groupMerchants` / `brandSlug` are the real
// shared helpers (as in the component); only the catalogue fetch is mocked.
const { mocks } = vi.hoisted(() => ({ mocks: { fetchAllMerchants: vi.fn() } }));

vi.mock('~/services/merchants', async (importActual) => {
  const actual = (await importActual()) as typeof MerchantsService;
  return {
    ...actual,
    fetchAllMerchants: () => mocks.fetchAllMerchants(),
  };
});

const m = (id: string, name: string): Merchant => ({ id, name, enabled: true });

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
  mocks.fetchAllMerchants.mockReset();
  mocks.fetchAllMerchants.mockResolvedValue({
    merchants: [m('a', 'dots.eco - Plant a Tree'), m('b', 'dots.eco - Buy Land'), m('c', 'Greggs')],
    total: 3,
  });
});

describe('brand.$slug-ssr loader', () => {
  it('throws a real 404 Response for an unknown brand slug (not a soft-404)', async () => {
    const thrown = await caught(runLoader({ slug: 'no-such-brand' }));
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it('resolves (returns null, no throw) for a known brand group', async () => {
    await expect(runLoader({ slug: brandSlug('dots.eco') })).resolves.toBeNull();
  });

  it('resolves a mixed/upper-case slug case-insensitively (CAT-03 parity)', async () => {
    await expect(runLoader({ slug: 'DOTS.ECO' })).resolves.toBeNull();
  });

  it('fails open (no throw) when the catalogue fetch errors', async () => {
    mocks.fetchAllMerchants.mockRejectedValue(new Error('upstream down'));
    await expect(runLoader({ slug: 'no-such-brand' })).resolves.toBeNull();
  });
});
