// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('A2-1150: session restore on transient refresh failure', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('~/native/secure-storage');
    vi.doUnmock('~/services/api-client');
    vi.doUnmock('~/native/purchase-storage');
  });

  it('transient refresh (tryRefresh returns null) does NOT clear refresh token from storage', async () => {
    const clearRefreshTokenSpy = vi.fn(() => Promise.resolve());
    vi.doMock('~/native/secure-storage', () => ({
      getRefreshToken: vi.fn(async () => 'rt-stored'),
      getEmail: vi.fn(async () => 'u@example.com'),
      storeRefreshToken: vi.fn(() => Promise.resolve()),
      storeEmail: vi.fn(() => Promise.resolve()),
      clearRefreshToken: clearRefreshTokenSpy,
    }));
    vi.doMock('~/services/api-client', () => ({
      // Simulate transient failure — doRefresh caught a 5xx / 429 /
      // network error, deliberately kept the token on disk (A-020),
      // and returned null.
      tryRefresh: vi.fn(async () => null),
    }));
    vi.doMock('~/native/purchase-storage', () => ({
      loadPendingOrder: vi.fn(async () => null),
    }));
    vi.doMock('~/services/config', () => ({ API_BASE: 'http://test-api' }));

    // Importing the module fires the module-load getBootRestore()
    // under jsdom (window is defined). Boot restore awaits the
    // storage reads + tryRefresh, then pre-fix would have called
    // clearSession → clearRefreshToken.
    await import('../use-session-restore');
    // Drain the microtask chain.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(clearRefreshTokenSpy).not.toHaveBeenCalled();
  });
});
