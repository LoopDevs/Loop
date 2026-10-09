/**
 * Admin stable-currency change client.
 *
 * `POST /api/admin/users/:userId/stable-currency`. Mirrors the
 * `admin-user-credits.ts` slice pattern — generates the
 * `Idempotency-Key`, opts into the step-up auth dance via
 * `withStepUp: true`, and returns the uniform `{ result, audit }`
 * envelope. The barrel in `services/admin.ts` re-exports it.
 */
import { generateIdempotencyKey, type AdminWriteEnvelope } from './admin-write-envelope';
import { authenticatedRequest } from './api-client';

export interface StableCurrencySetResult {
  userId: string;
  priorStableCurrency: string;
  newStableCurrency: string;
  updatedAt: string;
}

export async function setUserStableCurrency(args: {
  userId: string;
  stableCurrency: string;
  reason: string;
  /** CF-09: reuse one key across the step-up retry + re-click. */
  idempotencyKey?: string;
}): Promise<AdminWriteEnvelope<StableCurrencySetResult>> {
  return authenticatedRequest<AdminWriteEnvelope<StableCurrencySetResult>>(
    `/api/admin/users/${encodeURIComponent(args.userId)}/stable-currency`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': args.idempotencyKey ?? generateIdempotencyKey() },
      body: {
        stableCurrency: args.stableCurrency,
        reason: args.reason,
      },
      // ADR-028 / A4-063: gated by step-up auth.
      withStepUp: true,
    },
  );
}
