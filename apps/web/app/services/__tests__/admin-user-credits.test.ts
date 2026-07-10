import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiException } from '@loop/shared';

vi.mock('~/services/api-client', () => ({
  apiRequest: vi.fn(),
  authenticatedRequest: vi.fn(),
}));

import { authenticatedRequest } from '~/services/api-client';
import { applyCreditAdjustment, applyAdminEmission } from '../admin-user-credits';

const mockAuthenticatedRequest = vi.mocked(authenticatedRequest);

/**
 * Q6-3: pins the ADR-017 + ADR-028 write contract at the point where
 * it's cheapest to observe — the request the service function builds
 * — rather than only indirectly through a rendered form.
 */
describe('applyCreditAdjustment', () => {
  beforeEach(() => {
    mockAuthenticatedRequest.mockReset();
  });

  const baseArgs = {
    userId: 'user-1',
    amountMinor: '1234',
    currency: 'USD' as const,
    reason: 'goodwill credit',
  };

  it('POSTs to the credit-adjustments endpoint with the reason in the body', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ result: {}, audit: {} });
    await applyCreditAdjustment(baseArgs);

    expect(mockAuthenticatedRequest).toHaveBeenCalledWith(
      '/api/admin/users/user-1/credit-adjustments',
      expect.objectContaining({
        method: 'POST',
        body: { amountMinor: '1234', currency: 'USD', reason: 'goodwill credit' },
      }),
    );
  });

  it('is gated by step-up (withStepUp: true) — a captured bearer token alone is not enough', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ result: {}, audit: {} });
    await applyCreditAdjustment(baseArgs);

    const options = mockAuthenticatedRequest.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options['withStepUp']).toBe(true);
  });

  it('generates a fresh Idempotency-Key when the caller supplies none', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ result: {}, audit: {} });
    await applyCreditAdjustment(baseArgs);
    await applyCreditAdjustment(baseArgs);

    const firstHeaders = mockAuthenticatedRequest.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    const secondHeaders = mockAuthenticatedRequest.mock.calls[1]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(firstHeaders['Idempotency-Key']).toBeTruthy();
    expect(secondHeaders['Idempotency-Key']).toBeTruthy();
    // Two independent (non-retry) calls must NOT collide on the same key
    // — that would make an intentional second adjustment collapse into
    // a no-op replay of the first.
    expect(firstHeaders['Idempotency-Key']).not.toBe(secondHeaders['Idempotency-Key']);
  });

  it('CF-09: reuses the caller-supplied Idempotency-Key verbatim (the step-up-retry contract)', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ result: {}, audit: {} });
    await applyCreditAdjustment({ ...baseArgs, idempotencyKey: 'fixed-key-123' });

    const headers = mockAuthenticatedRequest.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('fixed-key-123');
  });

  it('propagates a non-step-up error (e.g. daily cap 409) to the caller unchanged', async () => {
    mockAuthenticatedRequest.mockRejectedValue(
      new ApiException(409, { code: 'DAILY_ADJUSTMENT_CAP_EXCEEDED', message: 'cap hit' }),
    );
    await expect(applyCreditAdjustment(baseArgs)).rejects.toMatchObject({
      status: 409,
      code: 'DAILY_ADJUSTMENT_CAP_EXCEEDED',
    });
  });
});

describe('applyAdminEmission', () => {
  beforeEach(() => {
    mockAuthenticatedRequest.mockReset();
  });

  const baseArgs = {
    userId: 'user-1',
    amountMinor: '500',
    currency: 'GBP' as const,
    destinationAddress: 'GDESTADDR',
    reason: 'backfill on-chain half',
  };

  it('POSTs to the emissions endpoint with reason + destination in the body', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ result: {}, audit: {} });
    await applyAdminEmission(baseArgs);

    expect(mockAuthenticatedRequest).toHaveBeenCalledWith(
      '/api/admin/users/user-1/emissions',
      expect.objectContaining({
        method: 'POST',
        body: {
          amountMinor: '500',
          currency: 'GBP',
          destinationAddress: 'GDESTADDR',
          reason: 'backfill on-chain half',
        },
      }),
    );
  });

  it('is gated by step-up (withStepUp: true)', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ result: {}, audit: {} });
    await applyAdminEmission(baseArgs);

    const options = mockAuthenticatedRequest.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options['withStepUp']).toBe(true);
  });

  it('CF-09: reuses the caller-supplied Idempotency-Key verbatim', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ result: {}, audit: {} });
    await applyAdminEmission({ ...baseArgs, idempotencyKey: 'emission-key-9' });

    const headers = mockAuthenticatedRequest.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('emission-key-9');
  });
});
