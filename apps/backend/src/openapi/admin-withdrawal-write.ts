/**
 * Admin withdrawal-write OpenAPI registration (ADR-024 / A2-901).
 *
 * Lifted out of `./admin-credit-writes.ts`. Withdrawal is the third
 * ADR-017 admin write — same idempotency / reason / audit envelope
 * discipline as adjustment + refund — but it's the only one that
 * cuts both the off-chain credits ledger and the on-chain payout
 * queue in a single atomic txn (ADR-024 §3). Pulling it into its
 * own slice keeps the parent file focused on the homogeneous credit-
 * ledger writes (adjustment + refund) and lets withdrawal carry its
 * extra surface (`destinationAddress`, `payoutId`, 503 for missing
 * issuer config) without bulking the shared file.
 *
 * Path in the slice:
 *   - POST /api/admin/users/{userId}/withdrawals
 *
 * Three locally-scoped schemas travel with it: WithdrawalBody,
 * WithdrawalResult, WithdrawalEnvelope.
 *
 * `AdminWriteAudit` is threaded in by parameter — same pattern as
 * adjustment + refund, since the envelope schema is shared with
 * the cashback-config slice.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the admin withdrawal write path + its locally-scoped
 * schemas on the supplied registry. Called once from
 * `registerAdminCreditWritesOpenApi`.
 */
export function registerAdminWithdrawalWriteOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminWriteAudit: ReturnType<OpenAPIRegistry['register']>,
): void {
  const AdminWriteAudit = adminWriteAudit;

  // ─── Admin — withdrawal write (ADR-024 / A2-901) ──────────────────────────

  const WithdrawalBody = registry.register(
    'WithdrawalBody',
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

  const WithdrawalResult = registry.register(
    'WithdrawalResult',
    z.object({
      id: z
        .string()
        .uuid()
        .openapi({ description: 'credit_transactions.id of the new ledger row.' }),
      payoutId: z
        .string()
        .uuid()
        .openapi({ description: 'pending_payouts.id of the queued on-chain payout.' }),
      userId: z.string().uuid(),
      currency: z.string().length(3),
      amountMinor: z.string().openapi({
        description: 'Unsigned magnitude. The stored credit-tx row is negative.',
      }),
      destinationAddress: z.string(),
      priorBalanceMinor: z.string(),
      newBalanceMinor: z.string(),
      createdAt: z.string().datetime(),
    }),
  );

  const WithdrawalEnvelope = registry.register(
    'WithdrawalEnvelope',
    z.object({
      result: WithdrawalResult,
      audit: AdminWriteAudit,
    }),
  );

  // A2-901 / ADR-024 — admin withdrawal write. Same ADR-017
  // discipline as refund (Idempotency-Key, audit envelope, Discord
  // notify). Atomic two-row write debits user_credits + queues a
  // LOOP-asset pending_payouts row. A semantic unique index on the
  // active withdrawal intent rejects a second in-flight/failed-
  // uncompensated withdrawal for the same
  // (user, asset, issuer, destination, amount) with 409
  // WITHDRAWAL_ALREADY_ISSUED.
  registry.registerPath({
    method: 'post',
    path: '/api/admin/users/{userId}/withdrawals',
    summary:
      'Issue a withdrawal — debit cashback balance + queue on-chain payout (A2-901 / ADR-024).',
    description:
      "Writes a negative-amount `credit_transactions` row (`type='withdrawal'`, `reference_type='payout'`, `reference_id=<pending_payouts.id>`), atomically decrements `user_credits.balance_minor`, and queues a LOOP-asset payout row for the on-chain submit worker. Idempotent in two layers: the admin idempotency key replays the stored snapshot on repeat (ADR 017), and the DB active-withdrawal unique index rejects a second unresolved withdrawal for the same user/asset/destination/amount tuple with 409 `WITHDRAWAL_ALREADY_ISSUED`. Phase 2a is admin-mediated only; user-initiated cash-out is deferred to Phase 2b.",
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
        content: { 'application/json': { schema: WithdrawalBody } },
      },
    },
    responses: {
      200: {
        description: 'Withdrawal applied (or replayed from idempotency snapshot)',
        content: { 'application/json': { schema: WithdrawalEnvelope } },
      },
      400: {
        description:
          'Missing idempotency key, invalid body, non-uuid userId, or insufficient balance (`INSUFFICIENT_BALANCE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      403: {
        description: 'Not an admin',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Target user not found (`NOT_FOUND`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description:
          'A matching active withdrawal already exists for this user/asset/destination/amount (`WITHDRAWAL_ALREADY_ISSUED`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error applying the withdrawal',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description:
          'LOOP issuer for the requested currency not configured in env (`NOT_CONFIGURED`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
