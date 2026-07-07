// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Merchant } from '@loop/shared';
import type { ListFavoritesResponse } from '~/services/favorites';

const { svc } = vi.hoisted(() => ({
  svc: { listFavorites: vi.fn(), addFavorite: vi.fn(), removeFavorite: vi.fn() },
}));

vi.mock('~/services/favorites', () => ({
  listFavorites: () => svc.listFavorites(),
  addFavorite: (id: string) => svc.addFavorite(id),
  removeFavorite: (id: string) => svc.removeFavorite(id),
}));

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

import { useFavorites, useToggleFavorite } from '../use-favorites';

afterEach(cleanup);

beforeEach(() => {
  svc.listFavorites.mockReset();
  svc.addFavorite.mockReset().mockResolvedValue(undefined);
  svc.removeFavorite.mockReset().mockResolvedValue(undefined);
});

const merchant = (id: string): Merchant => ({ id, name: `Merchant ${id}`, enabled: true });

function makeWrapper(): React.FC<{ children: React.ReactNode }> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useFavorites', () => {
  it('does not fire the request when unauthenticated', () => {
    const { result } = renderHook(() => useFavorites(false), { wrapper: makeWrapper() });
    expect(svc.listFavorites).not.toHaveBeenCalled();
    expect(result.current.favorites).toEqual([]);
    expect(result.current.favoritedIds.size).toBe(0);
    expect(result.current.total).toBe(0);
  });

  it('hides evicted (null-merchant) entries from favorites but keeps them in favoritedIds', async () => {
    const data: ListFavoritesResponse = {
      favorites: [
        { merchantId: 'a', createdAt: '2026-01-01T00:00:00Z', merchant: merchant('a') },
        { merchantId: 'b', createdAt: '2026-01-02T00:00:00Z', merchant: null }, // evicted
      ],
      total: 2,
    };
    svc.listFavorites.mockResolvedValue(data);
    const { result } = renderHook(() => useFavorites(true), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // evicted 'b' is hidden from the render list…
    expect(result.current.favorites.map((f) => f.merchantId)).toEqual(['a']);
    // …but still counts as favourited (so its heart stays filled)
    expect([...result.current.favoritedIds].sort()).toEqual(['a', 'b']);
    expect(result.current.total).toBe(2);
  });

  it('surfaces isError on fetch failure and yields an empty list', async () => {
    svc.listFavorites.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useFavorites(true), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.favorites).toEqual([]);
    expect(result.current.favoritedIds.size).toBe(0);
  });
});

describe('useToggleFavorite', () => {
  it('adds when not currently favourited and removes when it is', async () => {
    const { result } = renderHook(() => useToggleFavorite(), { wrapper: makeWrapper() });

    act(() => result.current.mutate({ merchantId: 'x', currentlyFavorited: false }));
    await waitFor(() => expect(svc.addFavorite).toHaveBeenCalledWith('x'));
    expect(svc.removeFavorite).not.toHaveBeenCalled();

    act(() => result.current.mutate({ merchantId: 'x', currentlyFavorited: true }));
    await waitFor(() => expect(svc.removeFavorite).toHaveBeenCalledWith('x'));
  });
});
