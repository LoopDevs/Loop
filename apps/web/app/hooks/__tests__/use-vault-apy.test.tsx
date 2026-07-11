// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { VaultApyResponse } from '~/services/vault-apy';

const { vaultApyMock, authMock, configMock } = vi.hoisted(() => ({
  vaultApyMock: { getVaultApy: vi.fn() },
  authMock: { isAuthenticated: true },
  configMock: { phase1Only: false },
}));

vi.mock('~/services/vault-apy', () => ({
  getVaultApy: () => vaultApyMock.getVaultApy(),
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({ config: { phase1Only: configMock.phase1Only }, isLoading: false }),
}));

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

import { useVaultApy, VAULT_APY_QUERY_KEY } from '../use-vault-apy';

afterEach(cleanup);

beforeEach(() => {
  vaultApyMock.getVaultApy.mockReset();
  authMock.isAuthenticated = true;
  configMock.phase1Only = false;
});

function makeWrapper(): React.FC<{ children: React.ReactNode }> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function response(overrides: Partial<VaultApyResponse> = {}): VaultApyResponse {
  return {
    assets: [
      { assetCode: 'GBPLOOP', past30dApy: 0.0312, past90dRange: { minApy: 0.028, maxApy: 0.035 } },
    ],
    disclaimerKey: 'wallet.apyDisclaimer',
    ...overrides,
  };
}

describe('useVaultApy', () => {
  it('does not fire the request when unauthenticated', () => {
    authMock.isAuthenticated = false;
    const { result } = renderHook(() => useVaultApy(), { wrapper: makeWrapper() });
    expect(vaultApyMock.getVaultApy).not.toHaveBeenCalled();
    expect(result.current.vaultApy).toBeUndefined();
  });

  it('does not fire the request while LOOP_PHASE_1_ONLY is on', () => {
    configMock.phase1Only = true;
    const { result } = renderHook(() => useVaultApy(), { wrapper: makeWrapper() });
    expect(vaultApyMock.getVaultApy).not.toHaveBeenCalled();
    expect(result.current.vaultApy).toBeUndefined();
  });

  it('fetches and exposes the vault APY when authenticated and phase1Only is off', async () => {
    vaultApyMock.getVaultApy.mockResolvedValue(response());
    const { result } = renderHook(() => useVaultApy(), { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(result.current.vaultApy).toBeDefined();
    });
    expect(vaultApyMock.getVaultApy).toHaveBeenCalledTimes(1);
    expect(result.current.vaultApy?.assets[0]?.assetCode).toBe('GBPLOOP');
  });

  it('surfaces isError on fetch failure', async () => {
    vaultApyMock.getVaultApy.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useVaultApy(), { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.vaultApy).toBeUndefined();
  });

  it('exposes the me-surface query key for invalidation', () => {
    expect(VAULT_APY_QUERY_KEY).toEqual(['me', 'vault-apy']);
  });
});
