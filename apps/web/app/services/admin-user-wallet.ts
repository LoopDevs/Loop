/**
 * Admin user-wallet surface (ADR 037 — User 360 wallet card; ADR 030
 * Phase C provisioning):
 *
 * - `GET /api/admin/users/:userId/wallet` — provider linkage,
 *   provisioning state + attempt telemetry, and the on-chain
 *   trustline snapshot (`onChain: null` when Horizon is unreachable —
 *   deliberately no last-known-good fallback; support needs the
 *   truth, so the card renders a retry hint instead).
 * - `POST /api/admin/users/:userId/wallet/reprovision` — resets the
 *   sweeper's attempt budget and re-enqueues the provisioning drive.
 *   Support-allowed (ADR 037 §3: idempotent re-drive of paid-for
 *   work, no money movement) but carries the full ADR 017 contract:
 *   idempotency key + 2..500 char reason, `{ result, audit }` back.
 *   An already-activated wallet 409s (`WALLET_ALREADY_ACTIVATED`).
 *
 * Wire shapes live in `@loop/shared/admin-support-ops.ts`.
 */
import type { AdminUserWalletResponse, AdminWalletReprovisionResult } from '@loop/shared';
import { generateIdempotencyKey, type AdminWriteEnvelope } from './admin-write-envelope';
import { authenticatedRequest } from './api-client';

/** `GET /api/admin/users/:userId/wallet` */
export async function getAdminUserWallet(userId: string): Promise<AdminUserWalletResponse> {
  return authenticatedRequest<AdminUserWalletResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/wallet`,
  );
}

/** `POST /api/admin/users/:userId/wallet/reprovision` */
export async function reprovisionAdminUserWallet(args: {
  userId: string;
  reason: string;
}): Promise<AdminWriteEnvelope<AdminWalletReprovisionResult>> {
  return authenticatedRequest<AdminWriteEnvelope<AdminWalletReprovisionResult>>(
    `/api/admin/users/${encodeURIComponent(args.userId)}/wallet/reprovision`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': generateIdempotencyKey() },
      body: { reason: args.reason },
    },
  );
}
