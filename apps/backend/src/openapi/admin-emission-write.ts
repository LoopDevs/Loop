/**
 * Admin emission-write OpenAPI registration (ADR-024 / A2-901,
 * re-scoped by ADR 036).
 *
 * Lifted out of `./admin-credit-writes.ts`. Emission is the third
 * ADR-017 admin write — same idempotency / reason / audit envelope
 * discipline as adjustment + refund — but unlike them it never
 * touches the `user_credits` mirror (ADR 036: emission materialises
 * the on-chain half of an existing liability, e.g. backfilling a
 * missed/failed cashback payout). Its only persistent write is the
 * `pending_payouts` queue row. Pulling it into its own slice keeps
 * the parent file focused on the homogeneous credit-ledger writes
 * (adjustment + refund) and lets emission carry its extra surface
 * (`destinationAddress`, `payoutId`, 503 for missing issuer config)
 * without bulking the shared file.
 *
 * Path in the slice:
 *   - POST /api/admin/users/{userId}/emissions
 *
 * Three locally-scoped schemas travel with it: EmissionBody,
 * EmissionResult, EmissionEnvelope.
 *
 * `AdminWriteAudit` is threaded in by parameter — same pattern as
 * adjustment + refund, since the envelope schema is shared with
 * the cashback-config slice.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the admin emission write path + its locally-scoped
 * schemas on the supplied registry. Called once from
 * `registerAdminCreditWritesOpenApi`.
 */
export function registerAdminEmissionWriteOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminWriteAudit: ReturnType<OpenAPIRegistry['register']>,
): void {
  const AdminWriteAudit = adminWriteAudit;

  // ─── Admin — emission write (ADR-024 / A2-901 / ADR 036) ──────────────────

  const EmissionBody = registry.register(
    'EmissionBody',
    z.object({
      amountMinor: z.string().openapi({
        description:
          'Positive integer-as-string. 1..10_000_000 minor units. Same cap as refund/adjustment.',
      }),
      currency: z.enum(['USD', 'GBP', 'EUR']),
      destinationAddress: z.string().openapi({
        description: 'User Stellar wallet — `G` + 55 base32 chars.',
      }),
      reason: z.string().min(2).max(500),
    }),
  );

  const EmissionResult = registry.register(
    'EmissionResult',
    z.object({
      payoutId: z
        .string()
        .uuid()
        .openapi({ description: 'pending_payouts.id of the queued on-chain emission.' }),
      userId: z.string().uuid(),
      currency: z.string().length(3),
      amountMinor: z.string().openapi({
        description: 'Unsigned magnitude. The user_credits mirror is NOT debited (ADR 036).',
      }),
      destinationAddress: z.string(),
      balanceMinor: z.string().openapi({
        description: 'Mirror balance at queue time — unchanged by the emission.',
      }),
      createdAt: z.string().datetime(),
    }),
  );

  const EmissionEnvelope = registry.register(
    'EmissionEnvelope',
    z.object({
      result: EmissionResult,
      audit: AdminWriteAudit,
    }),
  );

  // A2-901 / ADR-024 re-scoped by ADR 036 — admin emission write.
  // Same ADR-017 discipline as refund (Idempotency-Key, audit
  // envelope, Discord notify). Queues a LOOP-asset pending_payouts
  // row WITHOUT debiting user_credits. A semantic unique index on
  // the active emission intent rejects a second in-flight/failed-
  // uncompensated emission for the same
  // (user, asset, issuer, destination, amount) with 409
  // EMISSION_ALREADY_ISSUED.
  registry.registerPath({
    method: 'post',
    path: '/api/admin/users/{userId}/emissions',
    summary: 'Queue an emission — on-chain LOOP backfill, no mirror debit (ADR-024 / ADR 036).',
    description:
      "Queues a LOOP-asset payout row for the on-chain submit worker WITHOUT touching the off-chain `user_credits` mirror — per ADR 036 emission materialises the on-chain half of a liability that already exists (e.g. backfilling a missed/failed cashback payout). Refuses with 400 `INSUFFICIENT_BALANCE` when the requested amount exceeds the user's mirror balance (an emission beyond the mirrored liability would mint unbacked LOOP). Idempotent in two layers: the admin idempotency key replays the stored snapshot on repeat (ADR 017), and the DB active-emission unique index rejects a second unresolved emission for the same user/asset/destination/amount tuple with 409 `EMISSION_ALREADY_ISSUED`. Admin-mediated only — user-facing value exit is redemption (ADR 036).",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: EmissionBody } },
      },
    },
    responses: {
      200: {
        description: 'Emission queued (or replayed from idempotency snapshot)',
        content: { 'application/json': { schema: EmissionEnvelope } },
      },
      400: {
        description:
          'Missing idempotency key, invalid body, non-uuid userId, or amount exceeds the mirror balance (`INSUFFICIENT_BALANCE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description:
          'Target user not found (`NOT_FOUND`). Also returned to authenticated non-admin callers: requireAdmin masks the admin surface as 404 by design (see src/auth/require-admin.ts).',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description:
          'A matching active emission already exists for this user/asset/destination/amount (`EMISSION_ALREADY_ISSUED`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error applying the emission (`INTERNAL_ERROR`), or the stored replay snapshot for this Idempotency-Key is unreadable (`IDEMPOTENCY_SNAPSHOT_CORRUPT` — the write is never re-executed)',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description:
          'LOOP issuer for the requested currency not configured in env (`NOT_CONFIGURED`), or the `emissions` kill switch is engaged (`SUBSYSTEM_DISABLED`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
