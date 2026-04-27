/**
 * Admin Discord-management OpenAPI registrations (ADR 018).
 *
 * Lifted out of `apps/backend/src/openapi/admin-ops-tail.ts` so
 * the two trailing Discord operational paths sit together
 * separate from the residual mixed-bag of operational paths in
 * the parent file:
 *
 *   - GET  /api/admin/discord/notifiers  (frozen catalog readout)
 *   - POST /api/admin/discord/test       (manual webhook ping)
 *
 * The pair forms the admin UI's "Discord settings" panel: read
 * the catalog of available signals, then ping a webhook to verify
 * delivery. They're contiguous in the parent file's
 * path-registration order, use no admin-local schemas (only inline
 * `z.object` literals), and depend only on `errorResponse`.
 *
 * Re-invoked from `registerAdminOpsTailOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/admin/discord/notifiers` and
 * `/api/admin/discord/test` on the supplied registry.
 */
export function registerAdminDiscordMgmtOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  registry.registerPath({
    method: 'get',
    path: '/api/admin/discord/notifiers',
    summary: 'Static catalog of Discord notifiers (ADR 018).',
    description:
      'Zero-DB read of the `DISCORD_NOTIFIERS` const in `apps/backend/src/discord.ts`. Powers the admin UI surface that renders "what signals can this system send us?" without rebuilding the list from ADR prose. No secrets — `channel` is the symbolic name (`orders`, `monitoring`, `admin-audit`), not the webhook URL. A new notifier lands with its catalog entry in the same PR, so this response is always in lockstep with the code.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Frozen catalog of notifiers',
        content: {
          'application/json': {
            schema: z.object({
              notifiers: z.array(
                z.object({
                  name: z.string(),
                  channel: z.enum(['orders', 'monitoring', 'admin-audit']),
                  description: z.string(),
                }),
              ),
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
    method: 'post',
    path: '/api/admin/discord/test',
    summary: 'Fire a benign test ping at a Discord webhook (ADR 018).',
    description:
      "Manual ops primitive — admin picks one of the three channels (`orders`, `monitoring`, `admin-audit`), backend posts a test embed at the corresponding webhook URL. A 200 means delivery was attempted (webhook sends are fire-and-forget per ADR 018); a 409 `WEBHOOK_NOT_CONFIGURED` means the channel's env var is unset, so the UI can show 'webhook not configured' instead of a silent success. Tight 10/min rate limit because this is a manual primitive and spamming would be indistinguishable from webhook-URL enumeration.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              channel: z.enum(['orders', 'monitoring', 'admin-audit']),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Delivery attempted; ping sent to the channel',
        content: {
          'application/json': {
            schema: z.object({
              status: z.literal('delivered'),
              channel: z.enum(['orders', 'monitoring', 'admin-audit']),
            }),
          },
        },
      },
      400: {
        description: 'Body missing or channel unknown',
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
      409: {
        description: "The channel's webhook env var is unset (WEBHOOK_NOT_CONFIGURED)",
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
