/**
 * Admin user-wallet surface (ADR 037 — User 360 wallet card; ADR 030
 * Phase C provisioning):
 *
 * - `GET /api/admin/users/:userId/wallet` — provider, provisioning
 *   state, on-chain LOOP balances, attempt telemetry.
 * - `POST /api/admin/users/:userId/wallet/reprovision` — re-enqueues
 *   the provisioning sweep. Support-allowed (ADR 037 §3: idempotent
 *   re-drive of paid-for work, no money movement) — still sends an
 *   idempotency key per the uniform ADR 017 audit discipline.
 *
 * Wire shapes live in `@loop/shared/admin-user-wallet.ts`.
 */
import type { AdminUserWalletView, AdminWalletReprovisionResult } from '@loop/shared';
import { generateIdempotencyKey } from './admin-write-envelope';
import { authenticatedRequest } from './api-client';

/** `GET /api/admin/users/:userId/wallet` */
export async function getAdminUserWallet(userId: string): Promise<AdminUserWalletView> {
  return authenticatedRequest<AdminUserWalletView>(
    `/api/admin/users/${encodeURIComponent(userId)}/wallet`,
  );
}

/** `POST /api/admin/users/:userId/wallet/reprovision` */
export async function reprovisionAdminUserWallet(
  userId: string,
): Promise<AdminWalletReprovisionResult> {
  return authenticatedRequest<AdminWalletReprovisionResult>(
    `/api/admin/users/${encodeURIComponent(userId)}/wallet/reprovision`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': generateIdempotencyKey() },
    },
  );
}
