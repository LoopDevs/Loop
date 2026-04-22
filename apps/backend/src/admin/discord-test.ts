/**
 * Admin-initiated Discord webhook test (ADR 018).
 *
 * `POST /api/admin/discord/test` — fires a ping to one of the two
 * configured Discord webhooks (`orders` | `monitoring`) so the operator
 * can verify the pipe is live after a redeploy or env-var rotation,
 * without waiting for a real event.
 *
 * Returns 200 when the target channel has a webhook URL configured
 * (delivery attempted, though webhook delivery is fire-and-forget per
 * ADR 018). Returns 409 when the channel's env var is unset, so the
 * admin UI can surface "webhook not configured" rather than a silent
 * success. 400 on bad body.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { notifyWebhookPing } from '../discord.js';
import type { User } from '../db/users.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-discord-test' });

const Body = z.object({
  channel: z.enum(['orders', 'monitoring']),
});

export async function adminDiscordTestHandler(c: Context): Promise<Response> {
  const parsed = Body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: "channel must be 'orders' or 'monitoring'",
      },
      400,
    );
  }

  const admin = c.get('user') as User | undefined;
  if (admin === undefined) {
    // `requireAdmin` middleware should have set this; if it didn't,
    // the handler is mounted wrong.
    return c.json({ code: 'UNAUTHORIZED', message: 'Admin context missing' }, 401);
  }

  const delivered = notifyWebhookPing(parsed.data.channel, admin.id);
  if (!delivered) {
    return c.json(
      {
        code: 'WEBHOOK_NOT_CONFIGURED',
        message: `No webhook URL configured for the ${parsed.data.channel} channel`,
      },
      409,
    );
  }

  log.info(
    { channel: parsed.data.channel, adminId: admin.id },
    'Admin triggered Discord webhook test',
  );
  return c.json({ ok: true, channel: parsed.data.channel }, 200);
}
