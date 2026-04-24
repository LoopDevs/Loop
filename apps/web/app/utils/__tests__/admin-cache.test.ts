import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { invalidateAllAdminQueries } from '../admin-cache';

/**
 * A2-1155: sweep must hit every `admin-*` queryKey and skip everything else.
 * Seeds a representative cross-section of the real admin taxonomy, runs
 * the sweep, asserts invalidation state per-query. Isolation property —
 * non-admin keys (`['merchants']`, `['me', …]`, plain scalars) stay fresh.
 */
describe('invalidateAllAdminQueries', () => {
  const seed = (): QueryClient => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Admin keys — representative slice of the real taxonomy.
    queryClient.setQueryData(['admin-treasury'], { balance: 0 });
    queryClient.setQueryData(['admin-merchant-stats'], { merchants: 0 });
    queryClient.setQueryData(['admin-user-credits', 'u_1'], { balance: 0 });
    queryClient.setQueryData(['admin-user-orders', 'u_1', 25], { orders: [] });
    queryClient.setQueryData(['admin-cashback-realization-daily', 30], { points: [] });
    // Non-admin keys that must survive.
    queryClient.setQueryData(['merchants'], { list: [] });
    queryClient.setQueryData(['me'], { email: 'u@test.com' });
    queryClient.setQueryData(['me', 'credits'], { balance: 0 });
    queryClient.setQueryData(['loop-orders'], { list: [] });
    return queryClient;
  };

  it('invalidates every admin-* queryKey and leaves the rest fresh', async () => {
    const queryClient = seed();

    // All seeded queries start fresh by default — TanStack marks them fresh
    // once setQueryData populates them.
    await invalidateAllAdminQueries(queryClient);

    const adminKeys: readonly unknown[][] = [
      ['admin-treasury'],
      ['admin-merchant-stats'],
      ['admin-user-credits', 'u_1'],
      ['admin-user-orders', 'u_1', 25],
      ['admin-cashback-realization-daily', 30],
    ];
    for (const key of adminKeys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }

    const nonAdminKeys: readonly unknown[][] = [
      ['merchants'],
      ['me'],
      ['me', 'credits'],
      ['loop-orders'],
    ];
    for (const key of nonAdminKeys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    }
  });

  it('ignores queryKeys whose first element is not a string', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Hypothetical number-prefixed key. Predicate must not throw when
    // `.startsWith()` is called on a non-string.
    queryClient.setQueryData([42, 'admin-treasury'], { v: 1 });

    await expect(invalidateAllAdminQueries(queryClient)).resolves.toBeUndefined();
    expect(queryClient.getQueryState([42, 'admin-treasury'])?.isInvalidated).toBe(false);
  });

  it('no-ops when no admin queries exist in cache', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['merchants'], { list: [] });

    await expect(invalidateAllAdminQueries(queryClient)).resolves.toBeUndefined();
    expect(queryClient.getQueryState(['merchants'])?.isInvalidated).toBe(false);
  });
});
