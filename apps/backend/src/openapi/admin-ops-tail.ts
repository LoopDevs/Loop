/**
 * Admin operations-tail OpenAPI registrations
 * (ADR 009 / 011 / 015 / 017 / 018).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts` as the final
 * decomposition slice. Six residual paths that don\'t fit any of
 * the topical clusters (treasury/assets, payouts, orders, users,
 * operators, supplier-spend, dashboard, drill metrics, write
 * surfaces, mix matrices, CSV exports, fleet-monthly, cashback
 * config, misc reads):
 *
 *   - GET  /api/admin/discord/config       (env-var status badges)
 *   - GET  /api/admin/top-users            (lifetime cashback ranking)
 *   - GET  /api/admin/audit-tail           (admin-write audit feed)
 *   - POST /api/admin/merchants/resync     (force CTX catalog sweep)
 *   - GET  /api/admin/discord/notifiers    (frozen catalog)
 *   - POST /api/admin/discord/test         (manual webhook ping)
 *
 * Locally-scoped schemas travel with the slice (none referenced
 * elsewhere in admin.ts after the prior 16 slices have lifted the
 * rest of the surface):
 *
 *   - `TopUserRow` / `TopUsersResponse`
 *   - `AdminAuditTailRow` / `AdminAuditTailResponse`
 *
 * Only `errorResponse` crosses the slice boundary. The discord-
 * config / discord-notifiers / discord-test / merchants-resync
 * paths use inline `z.object` literals for their response shapes
 * — copied verbatim from the source rather than promoted to
 * registered schemas (matches the original openapi.ts behaviour;
 * promoting would change the generated `components.schemas` set
 * and isn\'t this slice\'s responsibility).
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerAdminDiscordMgmtOpenApi } from './admin-ops-tail-discord-mgmt.js';

/**
 * Registers the operations-tail paths + their locally-scoped
 * schemas on the supplied registry. Called once from
 * `registerAdminOpenApi`.
 */
export function registerAdminOpsTailOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Admin — top users (ADR 009 / 015) ─────────────────────────────────────

  const TopUserRow = registry.register(
    'TopUserRow',
    z.object({
      userId: z.string().uuid(),
      email: z.string().email(),
      currency: z.string().length(3),
      count: z.number().int().min(0),
      amountMinor: z.string().openapi({
        description: 'bigint-as-string. Minor units (pence / cents).',
      }),
    }),
  );

  const TopUsersResponse = registry.register(
    'TopUsersResponse',
    z.object({
      since: z.string().datetime(),
      rows: z.array(TopUserRow),
    }),
  );

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
    path: '/api/admin/discord/config',
    summary: 'Discord webhook configuration status (ADR 018).',
    description:
      "Read-only companion to `POST /api/admin/discord/test`. Reports whether each webhook env var is set so the admin panel can render a 'configured' / 'missing' badge next to each channel without POSTing. Never echoes the actual webhook URL — those are secrets.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Config status',
        content: {
          'application/json': {
            schema: z.object({
              orders: z.enum(['configured', 'missing']),
              monitoring: z.enum(['configured', 'missing']),
              adminAudit: z.enum(['configured', 'missing']),
            }),
          },
        },
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
    path: '/api/admin/top-users',
    summary: 'Top users by cashback earned (ADR 009 / 015).',
    description:
      "Ranked list of users with the highest `cashback`-type credit_transactions in the window. Groups by `(user, currency)` — fleet-wide totals across currencies aren't meaningful. Two shoulders use this: ops recognition ('top earners this month') and concentration-risk signal ('one user accounts for 70% — why?'). Default window 30 days, capped at 366. `?limit=` clamped 1..100, default 20.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Ranked rows, highest amountMinor first',
        content: { 'application/json': { schema: TopUsersResponse } },
      },
      400: {
        description: 'Invalid `since` or window over 366 days',
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
        description: 'Internal error computing the ranking',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

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

  registry.registerPath({
    method: 'post',
    path: '/api/admin/merchants/resync',
    summary: 'Force an immediate merchant-catalog sweep of the upstream CTX API.',
    description:
      'Ops override for the 6-hour scheduled `refreshMerchants` timer (ADR 011). Runs the same paginated sweep on-demand and atomically replaces the in-memory merchant cache once the new snapshot is fully built. Two admins clicking simultaneously coalesce into one upstream sweep via the existing refresh mutex: one response sees `triggered: true`, the other `triggered: false` with the same post-sync `loadedAt`. 502 on upstream failure, not 500 — the cached snapshot is retained so `/api/merchants` keeps serving prior data. Tight 2/min rate limit because every hit goes to CTX.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Post-sync snapshot summary',
        content: {
          'application/json': {
            schema: z.object({
              merchantCount: z.number().int().min(0),
              loadedAt: z.string().datetime(),
              triggered: z.boolean(),
            }),
          },
        },
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
        description: 'Rate limit exceeded (2/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      502: {
        description: 'Upstream CTX catalog fetch failed — cached snapshot retained',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // The two trailing Discord-management paths
  // (`/api/admin/discord/notifiers` and `/api/admin/discord/test`)
  // live in `./admin-ops-tail-discord-mgmt.ts`. Same path-
  // registration position as the original block.
  registerAdminDiscordMgmtOpenApi(registry, errorResponse);
}
