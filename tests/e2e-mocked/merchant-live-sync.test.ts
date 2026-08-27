import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Merchant catalog live maintenance over the CTX websocket.
 *
 * The backend loads the full catalog at boot and then keeps it current
 * from the mock's `/ws` merchant topic (apps/backend/src/merchants/
 * ws-maintainer.ts). `POST /_test/update-merchant` on the mock mutates a
 * merchant and broadcasts the same `system.merchant.*` event the real
 * spend-api fires — the backend's store should reflect the change
 * without any resync or restart.
 *
 * Runs API-level against the backend (no browser navigation): the UI's
 * TanStack Query staleTime deliberately delays client visibility, so
 * asserting through the web app would only re-test query caching.
 */

const MOCK_CTX_URL = 'http://localhost:9091';
const BACKEND_URL = 'http://localhost:8081';

interface ApiMerchant {
  id: string;
  name: string;
  logoUrl?: string;
  updatedAt?: string;
}

async function backendMerchants(request: APIRequestContext): Promise<ApiMerchant[]> {
  const res = await request.get(`${BACKEND_URL}/api/merchants/all`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { merchants: ApiMerchant[] };
  return body.merchants;
}

test.describe('merchant live sync (CTX ws merchant topic)', () => {
  test('an upstream merchant edit reaches the backend catalog without a resync', async ({
    request,
  }) => {
    const before = await backendMerchants(request);
    const target = before.find((m) => m.id === 'mock-target');
    expect(target).toBeDefined();

    const newLogo = `https://img.test/target-${Date.now()}.png`;
    const update = await request.post(`${MOCK_CTX_URL}/_test/update-merchant`, {
      data: { id: 'mock-target', name: 'Target Live', logoUrl: newLogo },
    });
    expect(update.ok()).toBe(true);

    // The event applies asynchronously — poll the backend briefly.
    await expect
      .poll(
        async () => {
          const merchants = await backendMerchants(request);
          return merchants.find((m) => m.id === 'mock-target')?.name;
        },
        { timeout: 10_000 },
      )
      .toBe('Target Live');

    const after = await backendMerchants(request);
    const updated = after.find((m) => m.id === 'mock-target')!;
    expect(updated.logoUrl).toBe(newLogo);
    // `updated` from CTX lands as `updatedAt` — the image cache-busting version.
    expect(updated.updatedAt).toBe(
      (
        (await (await request.get(`${MOCK_CTX_URL}/merchants`)).json()) as {
          result: Array<{ id: string; updated: string }>;
        }
      ).result.find((m) => m.id === 'mock-target')?.updated,
    );
    // In-place replacement: catalog order is unchanged.
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));

    // Restore the seed state for other tests in the suite.
    await request.post(`${MOCK_CTX_URL}/_test/update-merchant`, {
      data: { id: 'mock-target', name: 'Target' },
    });
  });

  test('an upstream merchant deletion drops it from the backend catalog', async ({ request }) => {
    // Create a throwaway merchant, wait for it to appear, then delete it.
    const created = await request.post(`${MOCK_CTX_URL}/_test/update-merchant`, {
      data: { id: 'mock-ephemeral', name: 'Ephemeral', enabled: true, currency: 'USD' },
    });
    expect(created.ok()).toBe(true);

    await expect
      .poll(async () => (await backendMerchants(request)).some((m) => m.id === 'mock-ephemeral'), {
        timeout: 10_000,
      })
      .toBe(true);

    const deleted = await request.post(`${MOCK_CTX_URL}/_test/update-merchant`, {
      data: { id: 'mock-ephemeral', _delete: true },
    });
    expect(deleted.ok()).toBe(true);

    await expect
      .poll(async () => (await backendMerchants(request)).some((m) => m.id === 'mock-ephemeral'), {
        timeout: 10_000,
      })
      .toBe(false);
  });
});
