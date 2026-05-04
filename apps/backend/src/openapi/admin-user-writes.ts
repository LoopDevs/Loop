/**
 * Admin user-property write OpenAPI registrations
 * (ADR 015 deferred § home-currency change).
 *
 * Sibling of `./admin-credit-writes.ts`. Currently just one
 * surface — `POST /api/admin/users/{userId}/home-currency` — but
 * its own factory keeps the credit-write file's docstring honest
 * (it really is "credits / refunds / withdrawals", not a catch-all
 * for every admin-mediated user write).
 *
 * Three locally-scoped schemas travel with the slice:
 *   - HomeCurrencySetBody / Result / Envelope
 *
 * `AdminWriteAudit` is threaded in as a parameter so the slice
 * shares the same registered schema instance with the rest of the
 * admin-write surface.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

export function registerAdminUserWritesOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminWriteAudit: ReturnType<OpenAPIRegistry['register']>,
): void {
  const AdminWriteAudit = adminWriteAudit;

  const HomeCurrencySetBody = registry.register(
    'HomeCurrencySetBody',
    z.object({
      homeCurrency: z.enum(['USD', 'GBP', 'EUR']).openapi({
        description:
          "Target user's new home currency. Must differ from the current value; the handler rejects no-op writes.",
      }),
      reason: z.string().min(2).max(500),
    }),
  );

  const HomeCurrencySetResult = registry.register(
    'HomeCurrencySetResult',
    z.object({
      userId: z.string().uuid(),
      priorHomeCurrency: z.string().length(3),
      newHomeCurrency: z.string().length(3),
      updatedAt: z.string().datetime(),
    }),
  );

  const HomeCurrencySetEnvelope = registry.register(
    'HomeCurrencySetEnvelope',
    z.object({
      result: HomeCurrencySetResult,
      audit: AdminWriteAudit,
    }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/users/{userId}/home-currency',
    summary: "Change a user's home currency (ADR 015 deferred § support-mediated change).",
    description:
      "Flips `users.home_currency` after preflight invariants confirm the switch is safe. Refuses with 409 if the user has a non-zero credit balance in the OLD currency (`HOME_CURRENCY_HAS_LIVE_BALANCE`) or any in-flight payouts in `pending` / `submitted` state (`HOME_CURRENCY_HAS_IN_FLIGHT_PAYOUTS`); both would be silently orphaned by the switch. ADR-017 admin-write contract: actor from `requireAdmin`, `Idempotency-Key` header required, `reason` body field (2..500 chars), Discord audit fanout AFTER commit. ADR-028 step-up gate is enforced at the route — a captured bearer alone cannot retarget a user's future cashback asset.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
        'x-admin-step-up': z.string().openapi({
          description: 'ADR-028 step-up JWT minted by `POST /api/admin/step-up`. 5-minute TTL.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: HomeCurrencySetBody } },
      },
    },
    responses: {
      200: {
        description: 'Home currency changed (or replayed from idempotency snapshot)',
        content: { 'application/json': { schema: HomeCurrencySetEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid body, or non-uuid userId',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer / missing or invalid step-up token',
        content: { 'application/json': { schema: errorResponse } },
      },
      403: {
        description: 'Not an admin',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Target user does not exist (`USER_NOT_FOUND`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description:
          'No-op (`HOME_CURRENCY_UNCHANGED`), live balance in old currency (`HOME_CURRENCY_HAS_LIVE_BALANCE`), in-flight payouts (`HOME_CURRENCY_HAS_IN_FLIGHT_PAYOUTS`), or concurrent change (`CONCURRENT_CHANGE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error applying the change',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Step-up auth unavailable on this deployment (`STEP_UP_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
