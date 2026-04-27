/**
 * Admin per-user cashback drill OpenAPI registrations
 * (ADR 009 / 015).
 *
 * Lifted out of `apps/backend/src/openapi/admin-fleet-monthly.ts`
 * so the two per-user cashback drill paths sit together separate
 * from the dozen other monthly / activity / per-user paths in the
 * parent file:
 *
 *   - GET /api/admin/users/{userId}/cashback-by-merchant
 *   - GET /api/admin/users/{userId}/cashback-summary
 *
 * Both paths are admin-scoped mirrors of the user-self
 * `/api/users/me/cashback-{by-merchant,summary}` surfaces — they
 * answer "what has *this* user earned and where" for a support
 * ticket. Read-only, key off the same `{userId}` param, share the
 * `errorResponse` ladder, and use no admin-local schemas
 * (`z.unknown()` for the body since the handler-side TypeScript
 * interface is the source of truth — A2-506 convention).
 *
 * Re-invoked from `registerAdminFleetMonthlyOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the two per-user cashback drill paths on the supplied
 * registry. Called once from `registerAdminFleetMonthlyOpenApi`.
 */
export function registerAdminUserCashbackDrillOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/cashback-by-merchant',
    summary: 'User-drill: cashback earned per merchant (ADR 009).',
    description:
      'Per-merchant breakdown of cashback one user has earned in a window. Companion to `/api/users/me/cashback-by-merchant`; admin-scoped by userId param.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-merchant cashback rows for the target user',
        content: { 'application/json': { schema: z.unknown() } },
      },
      400: {
        description: 'Malformed userId',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/cashback-summary',
    summary: 'User-drill: lifetime + this-month cashback summary (ADR 009 / 015).',
    description:
      'Admin-scoped mirror of `/api/users/me/cashback-summary`. Returns lifetime + month-to-date cashback for the target user, denominated in their current home currency. Used on `/admin/users/:userId` as the compact headline above the ledger drill.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Cashback summary for the target user',
        content: { 'application/json': { schema: z.unknown() } },
      },
      400: {
        description: 'Malformed userId',
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
        description: 'Target user not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
