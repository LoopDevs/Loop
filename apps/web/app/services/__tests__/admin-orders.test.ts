import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiException } from '@loop/shared';

vi.mock('~/services/api-client', () => ({
  apiRequest: vi.fn(),
  authenticatedRequest: vi.fn(),
}));

import { authenticatedRequest } from '~/services/api-client';
import { redriveOrder } from '../admin-orders';

const mockAuthenticatedRequest = vi.mocked(authenticatedRequest);

/**
 * Q6-3: `redriveOrder` (A5-1) can submit a real outbound Stellar
 * payment to CTX, so it carries the full ADR-017 + ADR-028 envelope —
 * same contract as `applyCreditAdjustment` / `retryPayout`.
 */
describe('redriveOrder', () => {
  beforeEach(() => {
    mockAuthenticatedRequest.mockReset();
  });

  it('POSTs to the redrive endpoint with the reason in the body', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ result: {}, audit: {} });
    await redriveOrder({ orderId: 'ord-1', reason: 'stuck 20min' });

    expect(mockAuthenticatedRequest).toHaveBeenCalledWith(
      '/api/admin/orders/ord-1/redrive',
      expect.objectContaining({
        method: 'POST',
        body: { reason: 'stuck 20min' },
      }),
    );
  });

  it('is gated by step-up (withStepUp: true)', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ result: {}, audit: {} });
    await redriveOrder({ orderId: 'ord-1', reason: 'stuck 20min' });

    const options = mockAuthenticatedRequest.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options['withStepUp']).toBe(true);
  });

  it('generates a fresh Idempotency-Key per call when none is supplied', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ result: {}, audit: {} });
    await redriveOrder({ orderId: 'ord-1', reason: 'stuck 20min' });
    await redriveOrder({ orderId: 'ord-1', reason: 'stuck 20min' });

    const firstHeaders = mockAuthenticatedRequest.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    const secondHeaders = mockAuthenticatedRequest.mock.calls[1]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(firstHeaders['Idempotency-Key']).not.toBe(secondHeaders['Idempotency-Key']);
  });

  it('CF-09: reuses the caller-supplied Idempotency-Key verbatim (the step-up-retry contract)', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ result: {}, audit: {} });
    await redriveOrder({
      orderId: 'ord-1',
      reason: 'stuck 20min',
      idempotencyKey: 'redrive-fixed',
    });

    const headers = mockAuthenticatedRequest.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('redrive-fixed');
  });

  it('propagates the 409 ORDER_REDRIVE_IN_PROGRESS guard rejection unchanged (no spurious retry)', async () => {
    mockAuthenticatedRequest.mockRejectedValue(
      new ApiException(409, { code: 'ORDER_REDRIVE_IN_PROGRESS', message: 'already procuring' }),
    );
    await expect(redriveOrder({ orderId: 'ord-1', reason: 'r' })).rejects.toMatchObject({
      status: 409,
      code: 'ORDER_REDRIVE_IN_PROGRESS',
    });
  });
});
