/**
 * A2-1165 (slice 25): admin payouts surface extracted from
 * `services/admin.ts`. The on-chain payout backlog drilldown
 * that powers `/admin/payouts` (ADR 015 / 016 / 024) — three
 * reads + one ADR-017 retry writer.
 *
 * - `AdminPayoutView` — admin-shaped payout row carrying the
 *   ADR-024 §2 `kind` discriminator (`order_cashback` vs
 *   `withdrawal`), the asset code + issuer, the destination
 *   address + memo, the state-machine timestamps, and Stellar
 *   submission metadata (`txHash`, `lastError`, `attempts`).
 * - `GET /api/admin/payouts` — paginated drilldown for the
 *   backlog list page. Server validates `state` against the
 *   enum, clamps `limit` to [1, 100]. Filters by state / user /
 *   asset / kind.
 * - `GET /api/admin/payouts/:id` — single drill-down. Permalink
 *   for an ops ticket.
 * - `GET /api/admin/orders/:orderId/payout` — payout associated
 *   with an order. 404 when no payout row exists (cashback
 *   hasn't emitted yet, or the payout builder skipped this
 *   order). The order detail page uses this to surface "where
 *   did the on-chain cashback land?" without making ops search
 *   the payouts list.
 * - `POST /api/admin/payouts/:id/retry` — ADR 017 admin write.
 *   Flips a failed row back to pending. The service generates a
 *   per-click `Idempotency-Key` so a double-click produces at
 *   most one state transition. Re-uses the
 *   `AdminWriteEnvelope` primitives from slice 16 / #1121.
 *
 * `AdminPayoutView` was inline in `services/admin.ts` and moves
 * with the functions. No other consumers, so promoting it to
 * `@loop/shared` would just add indirection. `services/admin.ts`
 * keeps a barrel re-export so existing consumers
 * (`AdminPayoutsTable.tsx`, `AdminPayoutDetail.tsx`,
 * `RetryPayoutButton.tsx`, `routes/admin.payouts.tsx`,
 * `routes/admin.payouts.$id.tsx`, paired tests) don't have to
 * re-target imports.
 */
import type { LoopAssetCode, PayoutState } from '@loop/shared';
import { generateIdempotencyKey, type AdminWriteEnvelope } from './admin-write-envelope';
import { authenticatedRequest } from './api-client';

/** Admin-shaped row from `/api/admin/payouts` (ADR 015 / 016 / 024). */
export interface AdminPayoutView {
  id: string;
  userId: string;
  /** NULL for `kind='withdrawal'` rows (ADR-024 §2). */
  orderId: string | null;
  /** ADR-024 §2 discriminator. */
  kind: 'order_cashback' | 'withdrawal';
  assetCode: string;
  assetIssuer: string;
  toAddress: string;
  amountStroops: string;
  memoText: string;
  state: PayoutState;
  txHash: string | null;
  lastError: string | null;
  attempts: number;
  createdAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
}

/** `GET /api/admin/payouts` — paginated drilldown. Server clamps `limit` to [1, 100]. */
export async function listPayouts(opts: {
  state?: PayoutState;
  userId?: string;
  assetCode?: LoopAssetCode;
  /** ADR-024 §2 — filter by payout discriminator (order-cashback vs withdrawal). */
  kind?: 'order_cashback' | 'withdrawal';
  limit?: number;
  before?: string;
}): Promise<{ payouts: AdminPayoutView[] }> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set('state', opts.state);
  if (opts.userId !== undefined) params.set('userId', opts.userId);
  if (opts.assetCode !== undefined) params.set('assetCode', opts.assetCode);
  if (opts.kind !== undefined) params.set('kind', opts.kind);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.before !== undefined) params.set('before', opts.before);
  const qs = params.toString();
  return authenticatedRequest<{ payouts: AdminPayoutView[] }>(
    `/api/admin/payouts${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/** `GET /api/admin/payouts/:id` — single payout drill-down. */
export async function getAdminPayout(id: string): Promise<AdminPayoutView> {
  return authenticatedRequest<AdminPayoutView>(`/api/admin/payouts/${encodeURIComponent(id)}`);
}

/**
 * `GET /api/admin/orders/:orderId/payout` — payout associated with
 * an order. 404 when no payout row exists yet.
 */
export async function getAdminPayoutByOrder(orderId: string): Promise<AdminPayoutView> {
  return authenticatedRequest<AdminPayoutView>(
    `/api/admin/orders/${encodeURIComponent(orderId)}/payout`,
  );
}

/**
 * `POST /api/admin/payouts/:id/retry` — ADR 017 admin write. Flips a
 * failed row back to pending. Service-generated `Idempotency-Key`
 * makes a double-click produce at most one state transition.
 */
export async function retryPayout(args: {
  id: string;
  reason: string;
}): Promise<AdminWriteEnvelope<AdminPayoutView>> {
  return authenticatedRequest<AdminWriteEnvelope<AdminPayoutView>>(
    `/api/admin/payouts/${encodeURIComponent(args.id)}/retry`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': generateIdempotencyKey() },
      body: { reason: args.reason },
    },
  );
}
