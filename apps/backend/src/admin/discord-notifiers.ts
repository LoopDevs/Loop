/**
 * Admin Discord notifier catalog (ADR 018).
 *
 * `GET /api/admin/discord/notifiers` — returns the static `DISCORD_NOTIFIERS`
 * catalog from `discord.ts` so the admin UI can render a "what can this
 * system send us?" surface without hardcoding the list on the client.
 *
 * Zero DB touch, no admin-identifying data, no secrets — just the
 * published taxonomy. The same list backs ADR 018 so there's a single
 * source of truth in code.
 */
import type { Context } from 'hono';
import { DISCORD_NOTIFIERS } from '../discord.js';

export interface AdminDiscordNotifiersResponse {
  notifiers: ReadonlyArray<{
    name: string;
    channel: 'orders' | 'monitoring';
    description: string;
  }>;
}

export async function adminDiscordNotifiersHandler(c: Context): Promise<Response> {
  return c.json<AdminDiscordNotifiersResponse>({ notifiers: DISCORD_NOTIFIERS });
}
