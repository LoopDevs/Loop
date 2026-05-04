/**
 * Admin home-currency change client (ADR 015 deferred § "self-serve
 * home-currency change — currently support-mediated").
 *
 * `POST /api/admin/users/:userId/home-currency`. Mirrors the
 * `admin-user-credits.ts` slice pattern — generates the
 * `Idempotency-Key`, opts into the step-up auth dance via
 * `withStepUp: true`, and returns the uniform `{ result, audit }`
 * envelope.
 *
 * Inline shape (`HomeCurrencySetResult`) travels with the function —
 * no other consumers. The barrel in `services/admin.ts` re-exports it
 * alongside the credit-adjust / withdrawal types.
 */
import { generateIdempotencyKey, type AdminWriteEnvelope } from './admin-write-envelope';
import { authenticatedRequest } from './api-client';

export interface HomeCurrencySetResult {
  userId: string;
  priorHomeCurrency: string;
  newHomeCurrency: string;
  updatedAt: string;
}

export async function setUserHomeCurrency(args: {
  userId: string;
  homeCurrency: 'USD' | 'GBP' | 'EUR';
  reason: string;
}): Promise<AdminWriteEnvelope<HomeCurrencySetResult>> {
  return authenticatedRequest<AdminWriteEnvelope<HomeCurrencySetResult>>(
    `/api/admin/users/${encodeURIComponent(args.userId)}/home-currency`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': generateIdempotencyKey() },
      body: {
        homeCurrency: args.homeCurrency,
        reason: args.reason,
      },
      // ADR-028 / A4-063: gated by step-up auth.
      withStepUp: true,
    },
  );
}
