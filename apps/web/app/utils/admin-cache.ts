import type { QueryClient } from '@tanstack/react-query';

/**
 * A2-1155: sweep every `admin-*` query out of the TanStack Query cache.
 *
 * Admin query keys are flat hyphenated strings (`['admin-treasury']`,
 * `['admin-merchant-stats']`, `['admin-user-credits', userId]`, …).
 * The flat namespace keeps per-key invalidation simple — post-mutation
 * calls like `admin.payouts.$id.tsx` only need to touch the 2-3 keys
 * the mutation actually stales — but it means `invalidateQueries({
 * queryKey: ['admin'] })` doesn't work as a prefix sweep the way it
 * would for a hierarchical `['admin', …]` taxonomy.
 *
 * Rather than migrate ~40 call sites to hierarchical keys (which would
 * also require rewriting every existing targeted-invalidate) this
 * helper uses the TanStack `predicate` option to match every queryKey
 * whose first element starts with `admin-`. One call, one sweep.
 *
 * Use this when a single admin action invalidates a broad, unpredictable
 * surface (role change, multi-currency config rewrite, operator pool
 * reshuffle). For narrow mutations keep using `invalidateQueries({
 * queryKey: ['admin-specific'] })` — targeted invalidation stays the
 * default; sweeping is the escape hatch.
 *
 * Keys outside the `admin-*` namespace (e.g. `['merchants']`, `['me', …]`)
 * are left alone. Callers that need a full wipe — logout, for instance —
 * should use `queryClient.clear()`.
 */
export function invalidateAllAdminQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const first = query.queryKey[0];
      return typeof first === 'string' && first.startsWith('admin-');
    },
  });
}
