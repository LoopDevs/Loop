/**
 * `POST /api/admin/deposits/:paymentId/refund` (hardening A6).
 *
 * Operator-triggered refund of an abandoned late deposit back to its
 * on-chain sender. Admin-tier + step-up (`'deposit-refund'` scope) —
 * the outbound Stellar payment from the operator account is exactly
 * the stolen-bearer threat ADR 028 exists for. The heavy lifting
 * (validation, CAS claim, CF-18 crash-safe submit, idempotent replay)
 * lives in `payments/deposit-refund.ts`; this maps its tagged result
 * to an HTTP status.
 */
import type { Context } from 'hono';
import { refundDeposit } from '../payments/deposit-refund.js';
import type { User } from '../db/users.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'deposit-refund' });

export interface DepositRefundResponse {
  paymentId: string;
  status: 'refunded' | 'already_refunded';
  txHash: string;
}

export async function adminDepositRefundHandler(c: Context): Promise<Response> {
  const paymentId = c.req.param('paymentId');
  if (paymentId === undefined || paymentId.length === 0 || paymentId.length > 128) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'paymentId is required' }, 400);
  }
  const actor = c.get('user') as User | undefined;

  let result;
  try {
    result = await refundDeposit(paymentId);
  } catch (err) {
    log.error({ err, paymentId, adminUserId: actor?.id }, 'A6: deposit refund crashed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Refund failed' }, 500);
  }

  switch (result.kind) {
    case 'refunded':
    case 'already_refunded': {
      log.warn(
        { paymentId, adminUserId: actor?.id, txHash: result.txHash, replay: result.kind },
        'A6: admin refunded a late deposit to its sender',
      );
      const body: DepositRefundResponse = {
        paymentId,
        status: result.kind,
        txHash: result.txHash,
      };
      return c.json(body);
    }
    case 'not_found':
      return c.json({ code: 'NOT_FOUND', message: 'No skipped deposit with that id' }, 404);
    case 'in_progress':
      return c.json(
        { code: 'PAYMENT_IN_FLIGHT', message: 'A refund for this deposit is already in progress' },
        409,
      );
    case 'not_refundable':
      return c.json(
        { code: 'DEPOSIT_NOT_REFUNDABLE', message: `Not refundable: ${result.detail}` },
        409,
      );
    case 'submit_failed':
      return c.json(
        { code: 'REFUND_SUBMIT_FAILED', message: `Refund submit failed: ${result.detail}` },
        502,
      );
  }
}
