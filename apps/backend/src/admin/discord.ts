// Discord wiring surfaces — ADR 018
import type { Context } from 'hono';
import { z } from 'zod';
import { config } from '../config/index.js';
import { hasWebhookConfigured, notifyWebhookPing, type DiscordChannel } from '../discord.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-discord' });

export interface AdminDiscordConfigResponse {
  orders: 'configured' | 'missing';
  monitoring: 'configured' | 'missing';
  adminAudit: 'configured' | 'missing';
}

function statusOf(url: string | undefined): 'configured' | 'missing' {
  return url !== undefined && url.length > 0 ? 'configured' : 'missing';
}

export function adminDiscordConfigHandler(c: Context): Response {
  const { discord } = config.observability;
  return c.json<AdminDiscordConfigResponse>({
    orders: statusOf(discord.ordersWebhook),
    monitoring: statusOf(discord.monitoringWebhook),
    adminAudit: statusOf(discord.adminAuditWebhook),
  });
}

const TestBody = z.object({
  channel: z.enum(['orders', 'monitoring', 'admin-audit']),
});

// 200 means "we posted" — fire-and-forget, not a delivery guarantee.
// 409 if channel has no URL, so UI shows "not configured" instead of false success.
export async function adminDiscordTestHandler(c: Context): Promise<Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'body must be JSON' }, 400);
  }
  const parsed = TestBody.safeParse(raw);
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

  const admin = c.get('user') as { id?: string } | undefined;
  if (admin?.id === undefined) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Admin context missing' }, 401);
  }

  if (!hasWebhookConfigured(channel)) {
    log.warn({ channel, actor: admin.id }, 'Admin discord-test against an unconfigured channel');
    return c.json(
      {
        code: 'WEBHOOK_NOT_CONFIGURED',
        message: `No webhook configured for the "${channel}" channel — set observability.discord.* and redeploy.`,
      },
      409,
    );
  }

  notifyWebhookPing(channel, admin.id);
  return c.json({ status: 'delivered', channel });
}
