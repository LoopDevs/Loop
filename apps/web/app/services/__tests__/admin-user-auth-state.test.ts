import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiException } from '@loop/shared';

vi.mock('~/services/api-client', () => ({
  apiRequest: vi.fn(),
  authenticatedRequest: vi.fn(),
}));

import { authenticatedRequest } from '~/services/api-client';
import { clearAdminOtpLockout, getAdminUserAuthState } from '../admin-user-auth-state';

const mockAuthenticatedRequest = vi.mocked(authenticatedRequest);

describe('getAdminUserAuthState', () => {
  beforeEach(() => {
    mockAuthenticatedRequest.mockReset();
  });

  it('GETs the auth-state endpoint for the given userId', async () => {
    mockAuthenticatedRequest.mockResolvedValue({});
    await getAdminUserAuthState('user-1');
    expect(mockAuthenticatedRequest).toHaveBeenCalledWith('/api/admin/users/user-1/auth-state');
  });
});

/**
 * Q6-3: `clearAdminOtpLockout` carries the ADR-017-lite contract
 * (Idempotency-Key + reason, `{ result, audit }` back) but is
 * deliberately NOT step-up-gated (admin-tier only — see the file's
 * header comment and `apps/backend/src/admin/clear-otp-lockout.ts`).
 * These tests pin BOTH halves of that contract: the parts it DOES
 * carry, and the step-up gate it deliberately omits — a regression
 * that silently added `withStepUp: true` here would change the
 * ADR-028 gated-surface list without a docs update.
 */
describe('clearAdminOtpLockout', () => {
  beforeEach(() => {
    mockAuthenticatedRequest.mockReset();
  });

  it('POSTs to the clear-otp-lockout endpoint with the reason in the body', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ result: {}, audit: {} });
    await clearAdminOtpLockout({ userId: 'user-1', reason: 'fat-fingered code' });

    expect(mockAuthenticatedRequest).toHaveBeenCalledWith(
      '/api/admin/users/user-1/clear-otp-lockout',
      expect.objectContaining({
        method: 'POST',
        body: { reason: 'fat-fingered code' },
      }),
    );
  });

  it('sends an Idempotency-Key header', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ result: {}, audit: {} });
    await clearAdminOtpLockout({ userId: 'user-1', reason: 'fat-fingered code' });

    const headers = mockAuthenticatedRequest.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeTruthy();
  });

  it('does NOT set withStepUp — this write is deliberately not step-up-gated', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ result: {}, audit: {} });
    await clearAdminOtpLockout({ userId: 'user-1', reason: 'fat-fingered code' });

    const options = mockAuthenticatedRequest.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options['withStepUp']).toBeUndefined();
  });

  it('propagates a 404 USER_NOT_FOUND error to the caller unchanged', async () => {
    mockAuthenticatedRequest.mockRejectedValue(
      new ApiException(404, { code: 'USER_NOT_FOUND', message: 'no such user' }),
    );
    await expect(clearAdminOtpLockout({ userId: 'missing', reason: 'r' })).rejects.toMatchObject({
      status: 404,
      code: 'USER_NOT_FOUND',
    });
  });
});
