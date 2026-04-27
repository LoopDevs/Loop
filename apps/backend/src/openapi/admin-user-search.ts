/**
 * Admin user-search OpenAPI registration (ADR 011).
 *
 * Lifted out of `apps/backend/src/openapi/admin-misc-reads.ts`
 * so the email-substring search path sits alongside its two
 * locally-scoped schemas, separate from the merchant-flows /
 * reconciliation reads in the parent file:
 *
 *   - GET /api/admin/users/search
 *
 * Distinct from the directory `/api/admin/users` (in
 * admin-user-cluster.ts) and the exact-match
 * `/api/admin/users/by-email` — this is the case-insensitive
 * substring lookup with a 20-row cap and the `truncated` flag.
 *
 * Locally-scoped schemas (none referenced elsewhere — they
 * travel with the slice):
 *   - `AdminUserSearchResult`
 *   - `AdminUserSearchResponse`
 *
 * Re-invoked from `registerAdminMiscReadsOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/admin/users/search` plus its two locally-
 * scoped schemas on the supplied registry.
 */
export function registerAdminUserSearchOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  const AdminUserSearchResult = registry.register(
    'AdminUserSearchResult',
    z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      isAdmin: z.boolean(),
      homeCurrency: z.enum(['USD', 'GBP', 'EUR']),
      createdAt: z.string().datetime(),
    }),
  );

  const AdminUserSearchResponse = registry.register(
    'AdminUserSearchResponse',
    z.object({
      users: z.array(AdminUserSearchResult),
      truncated: z.boolean().openapi({
        description:
          'True when more matches exist beyond the 20-row cap. Hint for the caller to narrow the query.',
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/search',
    summary: 'Find users by email fragment (ADR 011).',
    description:
      'Case-insensitive email substring match (ILIKE). Minimum 2 chars, maximum 254 (RFC 5321 email length cap). Ordered by createdAt DESC, limit 20. Returns `truncated: true` when more matches exist beyond the cap. Wildcards (% / _) in the query are escaped so they match literally.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        q: z
          .string()
          .min(2)
          .max(254)
          .openapi({ description: 'Email substring — case-insensitive. 2-254 chars.' }),
      }),
    },
    responses: {
      200: {
        description: 'Search results',
        content: { 'application/json': { schema: AdminUserSearchResponse } },
      },
      400: {
        description: 'q missing, too short, or too long',
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
}
