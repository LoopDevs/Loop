import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiException } from '@loop/shared';

// Same mocking pattern as the rest of the service tests
// (docs/testing.md — "Web service tests mock `api-client`").
vi.mock('~/services/api-client', () => ({
  apiRequest: vi.fn(),
  authenticatedRequest: vi.fn(),
}));

import { authenticatedRequest } from '~/services/api-client';
import { mintAdminStepUp } from '../admin-step-up';

const mockAuthenticatedRequest = vi.mocked(authenticatedRequest);

describe('mintAdminStepUp', () => {
  beforeEach(() => {
    mockAuthenticatedRequest.mockReset();
  });

  it('POSTs the OTP to /api/admin/step-up', async () => {
    mockAuthenticatedRequest.mockResolvedValue({
      stepUpToken: 'jwt-step-up',
      expiresAt: '2026-07-08T12:05:00.000Z',
    });

    await mintAdminStepUp('123456');

    expect(mockAuthenticatedRequest).toHaveBeenCalledWith('/api/admin/step-up', {
      method: 'POST',
      body: { otp: '123456' },
    });
  });

  it('returns the { stepUpToken, expiresAt } response verbatim', async () => {
    mockAuthenticatedRequest.mockResolvedValue({
      stepUpToken: 'jwt-abc',
      expiresAt: '2026-07-08T12:05:00.000Z',
    });

    const res = await mintAdminStepUp('654321');
    expect(res).toEqual({ stepUpToken: 'jwt-abc', expiresAt: '2026-07-08T12:05:00.000Z' });
  });

  it('does NOT set withStepUp — minting the token is not itself step-up-gated', async () => {
    mockAuthenticatedRequest.mockResolvedValue({
      stepUpToken: 'jwt-abc',
      expiresAt: '2026-07-08T12:05:00.000Z',
    });

    await mintAdminStepUp('123456');

    const options = mockAuthenticatedRequest.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options['withStepUp']).toBeUndefined();
  });

  it('propagates a 401 ApiException (wrong OTP) to the caller', async () => {
    mockAuthenticatedRequest.mockRejectedValue(
      new ApiException(401, { code: 'INVALID_OTP', message: 'Incorrect code' }),
    );
    await expect(mintAdminStepUp('000000')).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_OTP',
    });
  });

  it('propagates a 503 ApiException (signing key not configured) to the caller', async () => {
    mockAuthenticatedRequest.mockRejectedValue(
      new ApiException(503, { code: 'STEP_UP_UNAVAILABLE', message: 'not configured' }),
    );
    await expect(mintAdminStepUp('123456')).rejects.toMatchObject({
      status: 503,
      code: 'STEP_UP_UNAVAILABLE',
    });
  });
});
