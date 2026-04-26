/**
 * A2-1165 (slice 1): Discord notifier admin types + reads/writes
 * extracted from `services/admin.ts`. Cohesive ~60-line block —
 * `services/admin.ts` keeps the re-export so existing consumers
 * (DiscordNotifiersCard + test) don't have to re-target their
 * imports in the same PR.
 *
 * Backend pair: `apps/backend/src/admin/discord-config.ts`. Two
 * endpoints: `GET /api/admin/discord/notifiers` (static read of
 * the backend's `DISCORD_NOTIFIERS` const — zero DB, no secrets;
 * `channel` is the symbolic name, not the webhook URL) and
 * `POST /api/admin/discord/test` (benign test ping at a chosen
 * channel's webhook so ops can prove end-to-end wiring after
 * rotating env vars or redeploying).
 */
import { authenticatedRequest } from './api-client';

/** One notifier in the Discord catalog (ADR 018 / #572). */
export interface AdminDiscordNotifier {
  name: string;
  channel: 'orders' | 'monitoring' | 'admin-audit';
  description: string;
}

export interface AdminDiscordNotifiersResponse {
  notifiers: AdminDiscordNotifier[];
}

/**
 * `GET /api/admin/discord/notifiers` — static read of the backend's
 * `DISCORD_NOTIFIERS` const. Zero DB, no secrets (`channel` is the
 * symbolic name, not the webhook URL). Admin UI renders "what
 * signals can this system send us?" from this list.
 */
export async function getAdminDiscordNotifiers(): Promise<AdminDiscordNotifiersResponse> {
  return authenticatedRequest<AdminDiscordNotifiersResponse>('/api/admin/discord/notifiers');
}

/** Channel enum for the test-ping endpoint. Same union as AdminDiscordNotifier.channel. */
export type AdminDiscordChannel = AdminDiscordNotifier['channel'];

export interface AdminDiscordTestResponse {
  status: 'delivered';
  channel: AdminDiscordChannel;
}

/**
 * `POST /api/admin/discord/test` — fires a benign test ping at the
 * chosen channel's webhook. Ops uses this after rotating env vars or
 * redeploying to prove end-to-end wiring without waiting for a real
 * event. 409 WEBHOOK_NOT_CONFIGURED when the channel's env var is
 * unset; the UI surfaces that distinctly from a silent success.
 */
export async function testDiscordChannel(
  channel: AdminDiscordChannel,
): Promise<AdminDiscordTestResponse> {
  return authenticatedRequest<AdminDiscordTestResponse>('/api/admin/discord/test', {
    method: 'POST',
    body: { channel },
  });
}
