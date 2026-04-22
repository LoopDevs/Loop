/**
 * Admin Discord config status (ADR 018).
 *
 * `GET /api/admin/discord/config` — read-only companion to
 * `POST /api/admin/discord/test` (#436). That one fires a ping and
 * surfaces delivery success; this one just tells the admin UI
 * whether each webhook env var is configured at all, so the panel
 * can render a "unconfigured" badge without needing to POST.
 *
 * Never echoes the actual webhook URL — those are secrets. Returns
 * one of two string values per channel: `'configured'` or `'missing'`.
 */
import type { Context } from 'hono';
import { env } from '../env.js';

export interface AdminDiscordConfigResponse {
  /** Customer-facing order events (notifyOrderCreated / Fulfilled). */
  orders: 'configured' | 'missing';
  /** Admin audit + health paging (notifyHealthChange et al). */
  monitoring: 'configured' | 'missing';
}

function statusOf(url: string | undefined): 'configured' | 'missing' {
  return url !== undefined && url.length > 0 ? 'configured' : 'missing';
}

export async function adminDiscordConfigHandler(c: Context): Promise<Response> {
  return c.json<AdminDiscordConfigResponse>({
    orders: statusOf(env.DISCORD_WEBHOOK_ORDERS),
    monitoring: statusOf(env.DISCORD_WEBHOOK_MONITORING),
  });
}
