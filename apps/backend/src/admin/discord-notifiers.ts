/**
 * Admin Discord-notifier catalog (ADR 018).
 *
 * `GET /api/admin/discord/notifiers` — static read of the
 * `DISCORD_NOTIFIERS` catalog so the admin panel can render a
 * "what signals can this system send us?" surface. Keeps the
 * admin-facing view in lockstep with the code rather than with the
 * ADR prose.
 *
 * Zero DB touch — reads the frozen const directly. The 60/min
 * rate limit is conservative for a static read but matches the
 * other admin-read endpoints so ops doesn't have to learn a new
 * cadence per page.
 *
 * No secrets are echoed — `channel` is the symbolic name (`orders`,
 * `monitoring`, `admin-audit`), not the webhook URL.
 */
import type { Context } from 'hono';
import { DISCORD_NOTIFIERS, type DiscordNotifier } from '../discord.js';

export interface AdminDiscordNotifiersResponse {
  notifiers: DiscordNotifier[];
}

export function adminDiscordNotifiersHandler(c: Context): Response {
  const body: AdminDiscordNotifiersResponse = {
    notifiers: [...DISCORD_NOTIFIERS],
  };
  return c.json(body);
}
