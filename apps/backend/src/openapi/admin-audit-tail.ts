/**
 * Admin write-audit tail OpenAPI registration (ADR 017 / 018).
 *
 * Lifted out of `./admin-ops-tail.ts`. The audit-tail surface is
 * the read-side companion to the ADR-017 admin-write contract —
 * every credit-adjustment / refund / withdrawal / cashback-config
 * upsert lands a row in `admin_idempotency_keys`, and this endpoint
 * is the "Recent admin activity" feed the admin dashboard surfaces
 * so ops can audit without scrolling the Discord channel.
 *
 * Pulling it into its own slice co-locates the audit-read with the
 * write surfaces it mirrors (each of which is already its own
 * sibling slice — credit-writes, withdrawal-write, cashback-config-
 * upsert) rather than letting it sit in the residual ops-tail.
 *
 * Path in the slice:
 *   - GET /api/admin/audit-tail
 *
 * Two locally-scoped schemas travel with it:
 *   - `AdminAuditTailRow`
 *   - `AdminAuditTailResponse`
 *
 * Only `errorResponse` crosses the boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the audit-tail path + its locally-scoped schemas on
 * the supplied registry. Called once from
 * `registerAdminOpsTailOpenApi`.
 */
export function registerAdminAuditTailOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Admin — audit tail (ADR 017 / 018) ────────────────────────────────────

  const AdminAuditTailRow = registry.register(
    'AdminAuditTailRow',
    z.object({
      actorUserId: z.string().uuid(),
      actorEmail: z.string().email(),
      method: z.string(),
      path: z.string(),
      status: z.number().int(),
      createdAt: z.string().datetime(),
    }),
  );

  const AdminAuditTailResponse = registry.register(
    'AdminAuditTailResponse',
    z.object({ rows: z.array(AdminAuditTailRow) }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/audit-tail',
    summary: 'Newest-first admin write-audit tail (ADR 017 / 018).',
    description:
      "Returns the most recent rows from `admin_idempotency_keys` — the persistent mirror of every admin write. Admin dashboard surfaces this as a 'Recent admin activity' card so ops can review without scrolling the Discord channel. Response body is deliberately stripped (method / path / status / timestamp / actor only) — the audit story is 'who did what, when' not 'here's the stored snapshot'. `?limit=` clamps 1..100, default 25. `?before=<iso>` paginates older rows by `createdAt`.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        before: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: {
        description: 'Audit rows, newest first',
        content: { 'application/json': { schema: AdminAuditTailResponse } },
      },
      400: {
        description: '`before` is not a valid ISO-8601 timestamp',
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
      500: {
        description: 'Internal error reading the audit tail',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
