// Admin-audit channel Discord notifiers — ADR 017/018, A2-2008, A2-511, CF-10
import { config } from '../config/index.js';
import { BLUE, FIELD_VALUE_MAX, GREEN, escapeMarkdown, sendWebhook, truncate } from './shared.js';

// A2-511: actor email dropped from embed; tail-id is the Discord-side identifier
export function notifyAdminAudit(args: {
  actorUserId: string;
  endpoint: string;
  targetUserId?: string;
  amountMinor?: string;
  currency?: string;
  reason: string;
  idempotencyKey: string;
  replayed: boolean;
}): void {
  const actorTail = args.actorUserId.slice(-8);
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Actor', value: `\`${actorTail}\``, inline: true },
    { name: 'Endpoint', value: `\`${escapeMarkdown(args.endpoint)}\``, inline: true },
  ];
  if (args.targetUserId !== undefined) {
    fields.push({
      name: 'Target user',
      value: `\`${args.targetUserId.slice(-8)}\``,
      inline: true,
    });
  }
  if (args.amountMinor !== undefined && args.currency !== undefined) {
    fields.push({
      name: 'Amount (minor)',
      value: `${escapeMarkdown(args.amountMinor)} ${escapeMarkdown(args.currency)}`,
      inline: true,
    });
  }
  fields.push({
    name: 'Reason',
    value: truncate(escapeMarkdown(args.reason), FIELD_VALUE_MAX),
    inline: false,
  });
  fields.push({
    name: 'Idempotency-Key',
    value: `\`${escapeMarkdown(args.idempotencyKey).slice(0, 32)}\``,
    inline: true,
  });
  if (args.replayed) {
    fields.push({ name: 'Replayed', value: 'yes', inline: true });
  }
  void sendWebhook(config.observability.discord.adminAuditWebhook, {
    title: args.replayed ? '🔁 Admin write (replayed)' : '🛠️ Admin write',
    color: args.replayed ? BLUE : GREEN,
    fields,
  });
}

// A2-2008: bulk-read audit; single-row drills are in the access log, not here
export function notifyAdminBulkRead(args: {
  actorUserId: string;
  endpoint: string;
  /** Optional query string (truncated) for context. */
  queryString?: string;
  /** CF-10: row count for a bulk JSON list read (omitted for CSV exports). */
  rowCount?: number;
}): void {
  const actorTail = args.actorUserId.slice(-8);
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Actor', value: `\`${actorTail}\``, inline: true },
    { name: 'Endpoint', value: `\`${escapeMarkdown(args.endpoint)}\``, inline: true },
  ];
  if (args.rowCount !== undefined) {
    fields.push({ name: 'Rows', value: `${args.rowCount}`, inline: true });
  }
  if (args.queryString !== undefined && args.queryString.length > 0) {
    fields.push({
      name: 'Query',
      value: `\`${truncate(escapeMarkdown(args.queryString), 200)}\``,
      inline: false,
    });
  }
  void sendWebhook(config.observability.discord.adminAuditWebhook, {
    title: '📤 Admin bulk read',
    color: BLUE,
    fields,
  });
}
