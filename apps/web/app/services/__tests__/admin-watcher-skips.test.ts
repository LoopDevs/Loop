import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiException } from '@loop/shared';

vi.mock('~/services/api-client', () => ({
  apiRequest: vi.fn(),
  authenticatedRequest: vi.fn(),
}));

import { authenticatedRequest } from '~/services/api-client';
import { refundDeposit } from '../admin-watcher-skips';

const mockAuthenticatedRequest = vi.mocked(authenticatedRequest);

/** ADR-017 {result, audit} envelope helper — matches the backend. */
function envelope<T>(result: T, replayed = false): { result: T; audit: Record<string, unknown> } {
  return {
    result,
    audit: {
      actorUserId: 'staff-1',
      actorEmail: 'admin@loop.test',
      idempotencyKey: 'k'.repeat(32),
      appliedAt: '2026-06-12T10:00:00.000Z',
      replayed,
    },
  };
}

const REFUNDED = {
  paymentId: 'pay-1',
  status: 'refunded' as const,
  txHash: 'abcdef0123456789',
};

/**
 * MNY-13: `refundDeposit` (A6) submits a real outbound Stellar payment
 * to the deposit's sender, so it now carries the full ADR-017 +
 * ADR-028 envelope — same contract as `refundOrder` / `retryPayout`:
 * a required `Idempotency-Key` header, a required `reason` body, and
 * the `{ result, audit }` envelope back.
 */
describe('refundDeposit', () => {
  beforeEach(() => {
    mockAuthenticatedRequest.mockReset();
  });

  it('POSTs to the deposit-refund endpoint with the reason in the body', async () => {
    mockAuthenticatedRequest.mockResolvedValue(envelope(REFUNDED));
    await refundDeposit({ paymentId: 'pay-1', reason: 'late deposit — OPS-9' });

    expect(mockAuthenticatedRequest).toHaveBeenCalledWith(
      '/api/admin/deposits/pay-1/refund',
      expect.objectContaining({
        method: 'POST',
        body: { reason: 'late deposit — OPS-9' },
      }),
    );
  });

  it('sends a required Idempotency-Key header', async () => {
    mockAuthenticatedRequest.mockResolvedValue(envelope(REFUNDED));
    await refundDeposit({ paymentId: 'pay-1', reason: 'late deposit — OPS-9' });

    const headers = mockAuthenticatedRequest.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeTruthy();
  });

  it('is gated by step-up (withStepUp: true)', async () => {
    mockAuthenticatedRequest.mockResolvedValue(envelope(REFUNDED));
    await refundDeposit({ paymentId: 'pay-1', reason: 'late deposit — OPS-9' });

    const options = mockAuthenticatedRequest.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options['withStepUp']).toBe(true);
  });

  it('generates a fresh Idempotency-Key per call when none is supplied', async () => {
    mockAuthenticatedRequest.mockResolvedValue(envelope(REFUNDED));
    await refundDeposit({ paymentId: 'pay-1', reason: 'r1' });
    await refundDeposit({ paymentId: 'pay-1', reason: 'r1' });

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
    mockAuthenticatedRequest.mockResolvedValue(envelope(REFUNDED));
    await refundDeposit({
      paymentId: 'pay-1',
      reason: 'late deposit — OPS-9',
      idempotencyKey: 'refund-fixed',
    });

    const headers = mockAuthenticatedRequest.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('refund-fixed');
  });

  it('returns the {result, audit} envelope unchanged', async () => {
    mockAuthenticatedRequest.mockResolvedValue(envelope(REFUNDED, true));
    const res = await refundDeposit({ paymentId: 'pay-1', reason: 'late deposit — OPS-9' });

    expect(res.result).toEqual(REFUNDED);
    expect(res.audit.replayed).toBe(true);
  });

  it('propagates the 409 DEPOSIT_NOT_REFUNDABLE guard rejection unchanged', async () => {
    mockAuthenticatedRequest.mockRejectedValue(
      new ApiException(409, { code: 'DEPOSIT_NOT_REFUNDABLE', message: 'not abandoned' }),
    );
    await expect(refundDeposit({ paymentId: 'pay-1', reason: 'r' })).rejects.toMatchObject({
      status: 409,
      code: 'DEPOSIT_NOT_REFUNDABLE',
    });
  });
});
