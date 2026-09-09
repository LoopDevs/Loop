/**
 * Discord wiring surfaces (ADR 018).
 *
 * `GET  /api/admin/discord/config` — is each channel wired up?
 * `POST /api/admin/discord/test`   — fire a benign ping at one.
 *
 * Between them these answer "are our alerts actually going anywhere",
 * which is otherwise unanswerable until the first incident fails to
 * page anyone. The config read renders the badge; the test ping proves
 * the URL, which the badge cannot.
 *
 * Neither ever echoes a webhook URL — those are secrets, and a
 * leaked one lets anybody post into the channel operators trust.
 * The config endpoint returns `'configured'` or `'missing'` and
 * nothing else.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { config } from '../config/index.js';
import { hasWebhookConfigured, notifyWebhookPing, type DiscordChannel } from '../discord.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-discord' });

export interface AdminDiscordConfigResponse {
  /** Customer-facing order events. */
  orders: 'configured' | 'missing';
  /** Infra health paging. */
  monitoring: 'configured' | 'missing';
  /** ADR 017 admin-write audit feed and the bulk-read tripwire. */
  adminAudit: 'configured' | 'missing';
}

function statusOf(url: string | undefined): 'configured' | 'missing' {
  return url !== undefined && url.length > 0 ? 'configured' : 'missing';
}

/** GET /api/admin/discord/config */
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

/**
 * POST /api/admin/discord/test
 *
 * 200 means "we posted" — webhook sends are fire-and-forget, so it is
 * not a promise that Discord accepted it. A 409 when the channel has
 * no URL configured, so the UI says "not configured" instead of
 * showing a success for a message that went nowhere.
 *
 * Tightly rate-limited: this is a manual ops primitive, and spamming
 * it would be indistinguishable from probing which channels exist.
 * The actor's id rides along in the embed (truncated), so the channel
 * itself records who pinged it.
 */
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
