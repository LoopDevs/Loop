// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { useSessionRestore as UseSessionRestore } from '../use-session-restore';
import type { useAuthStore as UseAuthStore } from '~/stores/auth.store';

/**
 * `use-session-restore` memoises its boot-restore promise at module
 * scope (it fires at module load to overlap React hydration), so each
 * scenario needs a fresh module graph: `vi.resetModules()` +
 * `vi.doMock` + dynamic import per test. The hook and the auth store
 * are imported from the same registry so they share state.
 */

interface Setup {
  useSessionRestore: typeof UseSessionRestore;
  useAuthStore: typeof UseAuthStore;
  tryRefresh: ReturnType<typeof vi.fn>;
  clearRefreshToken: ReturnType<typeof vi.fn>;
}

async function setup(opts: {
  refreshToken: string | null;
  email: string | null;
  refreshedAccessToken: string | null;
}): Promise<Setup> {
  const tryRefresh = vi.fn(async () => opts.refreshedAccessToken);
  const clearRefreshToken = vi.fn(() => Promise.resolve());
  vi.doMock('~/native/secure-storage', () => ({
    getRefreshToken: vi.fn(async () => opts.refreshToken),
    getEmail: vi.fn(async () => opts.email),
    storeRefreshToken: vi.fn(() => Promise.resolve()),
    storeEmail: vi.fn(() => Promise.resolve()),
    clearRefreshToken,
  }));
  vi.doMock('~/services/api-client', () => ({ tryRefresh }));
  vi.doMock('~/native/purchase-storage', () => ({
    loadPendingOrder: vi.fn(async () => null),
  }));
  vi.doMock('~/services/config', () => ({ API_BASE: 'http://test-api' }));

  const { useSessionRestore } = await import('../use-session-restore');
  const { useAuthStore } = await import('~/stores/auth.store');
  return { useSessionRestore, useAuthStore, tryRefresh, clearRefreshToken };
}

describe('useSessionRestore', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('~/native/secure-storage');
    vi.doUnmock('~/services/api-client');
    vi.doUnmock('~/native/purchase-storage');
    vi.doUnmock('~/services/config');
  });

  it('finishes restoring with an empty session when no refresh token is stored', async () => {
    const { useSessionRestore, useAuthStore, tryRefresh } = await setup({
      refreshToken: null,
      email: null,
      refreshedAccessToken: 'at-should-not-be-used',
    });

    const { result } = renderHook(() => useSessionRestore());
    expect(result.current.isRestoring).toBe(true);
    await waitFor(() => expect(result.current.isRestoring).toBe(false));

    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().email).toBeNull();
    // No stored token → the hook must not attempt a network refresh.
    expect(tryRefresh).not.toHaveBeenCalled();
  });

  it('restores access token and email when a stored token refreshes successfully', async () => {
    const { useSessionRestore, useAuthStore, tryRefresh } = await setup({
      refreshToken: 'rt-stored-123',
      email: 'test@example.com',
      refreshedAccessToken: 'at-refreshed',
    });

    const { result } = renderHook(() => useSessionRestore());
    await waitFor(() => expect(result.current.isRestoring).toBe(false));

    expect(tryRefresh).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessToken).toBe('at-refreshed');
    expect(useAuthStore.getState().email).toBe('test@example.com');
  });

  it('does not restore an email when none is stored', async () => {
    const { useSessionRestore, useAuthStore } = await setup({
      refreshToken: 'rt-stored-123',
      email: null,
      refreshedAccessToken: 'at-refreshed',
    });

    const { result } = renderHook(() => useSessionRestore());
    await waitFor(() => expect(result.current.isRestoring).toBe(false));

    expect(useAuthStore.getState().accessToken).toBe('at-refreshed');
    expect(useAuthStore.getState().email).toBeNull();
  });

  it('leaves the session empty (and the token on disk) on transient refresh failure', async () => {
    const { useSessionRestore, useAuthStore, clearRefreshToken } = await setup({
      refreshToken: 'rt-stored-123',
      email: 'test@example.com',
      refreshedAccessToken: null, // tryRefresh → null: transient failure
    });

    const { result } = renderHook(() => useSessionRestore());
    await waitFor(() => expect(result.current.isRestoring).toBe(false));

    expect(useAuthStore.getState().accessToken).toBeNull();
    // A2-1150: transient failures must not wipe the stored token.
    expect(clearRefreshToken).not.toHaveBeenCalled();
  });

  it('skips restore and keeps the existing session when already authenticated', async () => {
    const { useSessionRestore, useAuthStore } = await setup({
      refreshToken: null,
      email: null,
      refreshedAccessToken: null,
    });
    useAuthStore.getState().setSession('existing@user.com', 'existing-at', 'existing-rt');

    const { result } = renderHook(() => useSessionRestore());
    await waitFor(() => expect(result.current.isRestoring).toBe(false));

    expect(useAuthStore.getState().accessToken).toBe('existing-at');
    expect(useAuthStore.getState().email).toBe('existing@user.com');
  });
});
