import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiException } from '@loop/shared';

vi.mock('~/services/api-client', () => ({
  apiRequest: vi.fn(),
  authenticatedRequest: vi.fn(),
}));

import { authenticatedRequest } from '~/services/api-client';
import { revokeUserSessions } from '../admin-user-sessions';

const mockAuthenticatedRequest = vi.mocked(authenticatedRequest);

/**
 * Q6-3: `revokeUserSessions` (A5-2) is the one admin write that
 * deliberately opts OUT of the ADR-017 envelope entirely — no
 * Idempotency-Key, no reason, no step-up (see the file's header
 * comment: "moves no value and is reversible"). Pin that contract
 * explicitly so a future "helpfully" wrapping it in the envelope
 * doesn't silently start sending headers the backend never asked for
 * (harmless today, but a false signal that this write is
 * idempotency-keyed / step-up-gated when it isn't).
 */
describe('revokeUserSessions', () => {
  beforeEach(() => {
    mockAuthenticatedRequest.mockReset();
  });

  it('POSTs to the revoke-sessions endpoint with only { method: POST } — no body', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ userId: 'user-1', message: 'ok' });
    await revokeUserSessions('user-1');

    expect(mockAuthenticatedRequest).toHaveBeenCalledWith(
      '/api/admin/users/user-1/revoke-sessions',
      { method: 'POST' },
    );
  });

  it('does not attach an Idempotency-Key header', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ userId: 'user-1', message: 'ok' });
    await revokeUserSessions('user-1');

    const options = mockAuthenticatedRequest.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options).not.toHaveProperty('headers');
  });

  it('does not set withStepUp', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ userId: 'user-1', message: 'ok' });
    await revokeUserSessions('user-1');

    const options = mockAuthenticatedRequest.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options['withStepUp']).toBeUndefined();
  });

  it('returns the flat { userId, message } result verbatim', async () => {
    mockAuthenticatedRequest.mockResolvedValue({
      userId: 'user-1',
      message: 'All sessions revoked',
    });
    const res = await revokeUserSessions('user-1');
    expect(res).toEqual({ userId: 'user-1', message: 'All sessions revoked' });
  });

  it('propagates errors to the caller unchanged', async () => {
    mockAuthenticatedRequest.mockRejectedValue(
      new ApiException(404, { code: 'USER_NOT_FOUND', message: 'no such user' }),
    );
    await expect(revokeUserSessions('missing')).rejects.toMatchObject({
      status: 404,
      code: 'USER_NOT_FOUND',
    });
  });
});
