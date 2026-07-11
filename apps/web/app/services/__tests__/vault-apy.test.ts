import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api-client', () => ({
  authenticatedRequest: vi.fn(),
}));

import { getVaultApy } from '../vault-apy';
import { authenticatedRequest } from '../api-client';

const mockAuth = vi.mocked(authenticatedRequest);

beforeEach(() => {
  mockAuth.mockReset();
});

/**
 * ADR 031 V6 — thin wrapper around `authenticatedRequest`, so the
 * test pins the exact path (the silent-drift class other `services/*`
 * tests guard against, e.g. `wallet.test.ts`'s `getMyWallet`).
 */
describe('getVaultApy', () => {
  it('GETs /api/me/vault-apy and returns the payload', async () => {
    const payload = {
      assets: [
        {
          assetCode: 'GBPLOOP',
          past30dApy: 0.0312,
          past90dRange: { minApy: 0.028, maxApy: 0.035 },
        },
      ],
      disclaimerKey: 'wallet.apyDisclaimer',
    };
    mockAuth.mockResolvedValue(payload);
    const result = await getVaultApy();
    expect(mockAuth).toHaveBeenCalledWith('/api/me/vault-apy');
    expect(result).toEqual(payload);
  });
});
