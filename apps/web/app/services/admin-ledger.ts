/**
 * Fleet-wide admin ledger browser (ADR 037 §4.2 / A5-8):
 *
 * - `GET /api/admin/ledger` — paginated, filterable browse of
 *   `credit_transactions` across every user. Complements the
 *   per-user drill at `listAdminUserCreditTransactions`
 *   (`./admin-user-credits.ts`) — that one answers "how did THIS
 *   user's balance get here"; this one answers "where did money
 *   move, fleet-wide" for drift investigation, dispute triage, and
 *   reconciliation without SQL.
 *
 * Read-only — no write function in this module by design.
 *
 * Wire shape lives in `@loop/shared/admin-support-ops.ts`.
 */
import type {
  AdminLedgerEntry,
  AdminLedgerListResponse,
  CreditTransactionType,
} from '@loop/shared';
import { authenticatedRequest } from './api-client';

export type { AdminLedgerEntry, AdminLedgerListResponse };

/** `GET /api/admin/ledger` — newest-first, keyset-paginated. */
export async function listAdminLedger(opts: {
  userId?: string;
  type?: CreditTransactionType;
  referenceType?: string;
  referenceId?: string;
  since?: string;
  before?: string;
  limit?: number;
}): Promise<AdminLedgerListResponse> {
  const params = new URLSearchParams();
  if (opts.userId !== undefined) params.set('userId', opts.userId);
  if (opts.type !== undefined) params.set('type', opts.type);
  if (opts.referenceType !== undefined) params.set('referenceType', opts.referenceType);
  if (opts.referenceId !== undefined) params.set('referenceId', opts.referenceId);
  if (opts.since !== undefined) params.set('since', opts.since);
  if (opts.before !== undefined) params.set('before', opts.before);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<AdminLedgerListResponse>(
    `/api/admin/ledger${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
