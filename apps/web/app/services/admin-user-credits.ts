/**
 * A2-1165 (slice 22): admin user-credits management surface
 * extracted from `services/admin.ts`. Two writes plus one read
 * cover the off-chain credits ledger from the admin side
 * (ADR 009 / 017 / 024):
 *
 * - `POST /api/admin/users/:userId/credit-adjustments` — ADR
 *   017 admin write. Caller supplies a signed minor amount
 *   (positive = credit, negative = debit), one of the home
 *   currencies, and a 2..500 char reason. The service
 *   generates the `Idempotency-Key` so a double-submit can't
 *   double-credit.
 * - `POST /api/admin/users/:userId/withdrawals` — ADR 024
 *   admin write. Debits the user's off-chain cashback balance
 *   and queues a matching on-chain LOOP-asset payout. Caller
 *   supplies a positive minor amount, one of the home
 *   currencies, the user's Stellar destination address, and a
 *   reason. The service generates the `Idempotency-Key` so a
 *   double-submit can't double-debit.
 * - `GET /api/admin/users/:userId/credit-transactions` —
 *   newest-first paginated ledger drill. Cursor via
 *   `before=<iso>`; `limit` clamped [1, 100] server-side
 *   (default 20). Optional `type` filter (`CreditTransactionType`
 *   re-used from `@loop/shared`).
 *
 * The 3 inline shapes (`CreditAdjustmentResult`,
 * `WithdrawalResult`, `AdminCreditTransactionView`) move with
 * the functions — no other consumers, so promoting them to
 * `@loop/shared` would just add indirection. `services/admin.ts`
 * keeps a barrel re-export so existing consumers
 * (`CreditAdjustmentForm.tsx`, `AdminWithdrawalForm.tsx`,
 * `UserCreditTransactionsTable.tsx`, paired tests) don't have
 * to re-target imports.
 */
import type { CreditTransactionType } from '@loop/shared';
import type { AdminWriteEnvelope } from './admin-write-envelope';
import { authenticatedRequest } from './api-client';

/** Result shape from a successful credit-adjustment write (ADR 017). */
export interface CreditAdjustmentResult {
  id: string;
  userId: string;
  currency: string;
  amountMinor: string;
  priorBalanceMinor: string;
  newBalanceMinor: string;
  createdAt: string;
}

/** Result shape from a successful admin withdrawal (ADR 024). */
export interface WithdrawalResult {
  id: string;
  payoutId: string;
  userId: string;
  currency: string;
  amountMinor: string;
  destinationAddress: string;
  priorBalanceMinor: string;
  newBalanceMinor: string;
  createdAt: string;
}

/** Row shape from `/api/admin/users/:userId/credit-transactions` (ADR 009). */
export interface AdminCreditTransactionView {
  id: string;
  type: CreditTransactionType;
  amountMinor: string;
  currency: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}

/** Generates a per-click idempotency key for ADR-017 admin writes. */
function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * `POST /api/admin/users/:userId/credit-adjustments` — ADR 017 admin
 * write. Positive `amountMinor` credits, negative debits.
 */
export async function applyCreditAdjustment(args: {
  userId: string;
  amountMinor: string;
  currency: 'USD' | 'GBP' | 'EUR';
  reason: string;
}): Promise<AdminWriteEnvelope<CreditAdjustmentResult>> {
  return authenticatedRequest<AdminWriteEnvelope<CreditAdjustmentResult>>(
    `/api/admin/users/${encodeURIComponent(args.userId)}/credit-adjustments`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': generateIdempotencyKey() },
      body: {
        amountMinor: args.amountMinor,
        currency: args.currency,
        reason: args.reason,
      },
    },
  );
}

/**
 * `POST /api/admin/users/:userId/withdrawals` — ADR 024 admin write.
 * Debits the off-chain balance and queues a LOOP-asset payout.
 */
export async function applyAdminWithdrawal(args: {
  userId: string;
  amountMinor: string;
  currency: 'USD' | 'GBP' | 'EUR';
  destinationAddress: string;
  reason: string;
}): Promise<AdminWriteEnvelope<WithdrawalResult>> {
  return authenticatedRequest<AdminWriteEnvelope<WithdrawalResult>>(
    `/api/admin/users/${encodeURIComponent(args.userId)}/withdrawals`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': generateIdempotencyKey() },
      body: {
        amountMinor: args.amountMinor,
        currency: args.currency,
        destinationAddress: args.destinationAddress,
        reason: args.reason,
      },
    },
  );
}

/** `GET /api/admin/users/:userId/credit-transactions` — newest-first paginated ledger drill. */
export async function listAdminUserCreditTransactions(opts: {
  userId: string;
  type?: CreditTransactionType;
  before?: string;
  limit?: number;
}): Promise<{ transactions: AdminCreditTransactionView[] }> {
  const params = new URLSearchParams();
  if (opts.type !== undefined) params.set('type', opts.type);
  if (opts.before !== undefined) params.set('before', opts.before);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<{ transactions: AdminCreditTransactionView[] }>(
    `/api/admin/users/${encodeURIComponent(opts.userId)}/credit-transactions${
      qs.length > 0 ? `?${qs}` : ''
    }`,
  );
}
