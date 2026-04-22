/**
 * Admin Discord webhook test ping (ADR 018).
 *
 * `POST /api/admin/discord/test` — admin picks a channel
 * (`orders` / `monitoring` / `admin-audit`), backend fires a benign
 * ping at the corresponding webhook. Lets ops verify wiring after
 * rotating env vars or redeploying without waiting for a real
 * event.
 *
 * 200 on delivery attempted (webhook sends are fire-and-forget per
 * ADR 018 — a 2xx here means "we posted", not "Discord accepted").
 * 409 `WEBHOOK_NOT_CONFIGURED` when the channel's env var is unset
 * so the UI can render "webhook not configured" instead of a silent
 * success. 400 on bad body.
 *
 * Tight 10/min rate limit — this is a manual ops primitive and
 * spamming would be indistinguishable from webhook-URL enumeration.
 * Actor id (truncated to 8 chars) rides along in the Discord embed
 * so the audit trail in the channel itself correlates pings to the
 * admin who triggered them.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { hasWebhookConfigured, notifyWebhookPing, type DiscordChannel } from '../discord.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-discord-test' });

const BodySchema = z.object({
  channel: z.enum(['orders', 'monitoring', 'admin-audit']),
});

export async function adminDiscordTestHandler(c: Context): Promise<Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'body must be JSON' }, 400);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: 'channel must be one of: orders, monitoring, admin-audit',
      },
      400,
    );
  }
  const channel: DiscordChannel = parsed.data.channel;

  // requireAdmin sets `user` context with the resolved admin row.
  // The handler only needs the id for embed correlation; full audit
  // runs on its own path.
  const admin = c.get('user') as { id?: string } | undefined;
  if (admin?.id === undefined) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Admin context missing' }, 401);
  }

  if (!hasWebhookConfigured(channel)) {
    log.warn({ channel, actor: admin.id }, 'Admin discord-test against unconfigured channel');
    return c.json(
      {
        code: 'WEBHOOK_NOT_CONFIGURED',
        message: `Webhook for channel "${channel}" is not configured. Set DISCORD_WEBHOOK_* env var.`,
      },
      409,
    );
  }

  notifyWebhookPing(channel, admin.id);
  return c.json({ status: 'delivered', channel });
}
