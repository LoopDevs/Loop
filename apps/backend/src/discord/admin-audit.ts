/**
 * Admin-audit channel Discord notifiers — fires to
 * `env.DISCORD_WEBHOOK_ADMIN_AUDIT`. Three signals that read
 * together as the admin-action audit trail:
 *
 *   1. **Admin write** (`notifyAdminAudit`) — generic ADR
 *      017/018 mutation log. Every credit-adjustment, withdrawal,
 *      payout-retry, config-edit, etc. emits one of these
 *      AFTER the DB commit. Actor id last-8-chars only; idempotency-
 *      key first-32-chars only; reason verbatim (truncated to
 *      `FIELD_VALUE_MAX`); replayed flag pulled from the
 *      idempotency-store hit.
 *   2. **Admin bulk read** (`notifyAdminBulkRead`) — A2-2008.
 *      Single-row drills aren't logged here (the access log is
 *      authoritative for line-item reads); CSV exports + large
 *      full-lists are. Discord post is the human-visible "someone
 *      is exporting right now" signal that's hard to ignore on a
 *      shared channel.
 *   3. **Cashback config change** (`notifyCashbackConfigChanged`)
 *      — ADR 011/018 domain-specific embed showing the old → new
 *      pct diff so the commercial impact of the edit is readable
 *      in Discord. Pairs with the generic `notifyAdminAudit` line
 *      (every config edit emits both — generic for compliance
 *      audit, domain-specific for ops/commercial review).
 *
 * `CashbackConfigSnapshot` is exported so the
 * `upsertConfigHandler` call site can stamp both the previous +
 * next state into a single diff'd webhook (rather than emitting
 * two before/after lines).
 *
 * Pulled out of `discord.ts` so the per-channel surfaces are
 * traceable to one file each. Shared infrastructure
 * (`sendWebhook`, `truncate`, `escapeMarkdown`, colour constants)
 * lives in `./shared.ts`.
 */
import { env } from '../env.js';
import { BLUE, FIELD_VALUE_MAX, GREEN, escapeMarkdown, sendWebhook, truncate } from './shared.js';

/**
 * Notify: admin write action (ADR 017/018). Called fire-and-forget
 * AFTER the DB commit of every admin mutation. Actor id truncated
 * to the last 8 chars so the embed doesn't expose a full uuid;
 * full id is still in the ledger for audit. A2-511: actor email
 * dropped from the embed — the tail-id convention is the Discord-
 * side identifier, and admin emails are reserved for the ledger
 * row (where they're useful) rather than the webhook feed (where
 * they aren't).
 */
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
  void sendWebhook(env.DISCORD_WEBHOOK_ADMIN_AUDIT, {
    title: args.replayed ? '🔁 Admin write (replayed)' : '🛠️ Admin write',
    color: args.replayed ? BLUE : GREEN,
    fields,
  });
}

/**
 * A2-2008: bulk-read audit notification. Admin reads are a separate
 * surface from admin writes — logging every single-row drill would
 * flood the channel — but bulk exports (CSV downloads, full-list
 * pulls past a row threshold) are a high-PII surface where a
 * malicious or mis-targeted admin can exfiltrate user data without
 * leaving a trace.
 *
 * Fires on:
 *   - any `GET /api/admin/*.csv` 200 response
 *   - admin GETs flagged as "bulk" by the middleware (large-page
 *     full lists)
 *
 * The Pino access log (server-side, ships off-host via Fly logflow)
 * is the line-item read audit; this Discord post is the human-visible
 * "someone's running an export right now" signal.
 */
export function notifyAdminBulkRead(args: {
  actorUserId: string;
  endpoint: string;
  /** Optional query string (truncated) for context. */
  queryString?: string;
}): void {
  const actorTail = args.actorUserId.slice(-8);
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Actor', value: `\`${actorTail}\``, inline: true },
    { name: 'Endpoint', value: `\`${escapeMarkdown(args.endpoint)}\``, inline: true },
  ];
  if (args.queryString !== undefined && args.queryString.length > 0) {
    fields.push({
      name: 'Query',
      value: `\`${truncate(escapeMarkdown(args.queryString), 200)}\``,
      inline: false,
    });
  }
  void sendWebhook(env.DISCORD_WEBHOOK_ADMIN_AUDIT, {
    title: '📤 Admin bulk read',
    color: BLUE,
    fields,
  });
}

/**
 * Snapshot of one row in `merchant_cashback_configs`. Exported so
 * the `upsertConfigHandler` call site can stamp both the previous
 * + next state into a single `notifyCashbackConfigChanged` post.
 */
export interface CashbackConfigSnapshot {
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  active: boolean;
}

/**
 * Notify: merchant cashback-config create / update (ADR 011 / 018).
 * Called fire-and-forget AFTER the DB upsert commits, from
 * `upsertConfigHandler`. The admin-audit channel already receives a
 * generic `notifyAdminAudit` line; this one is the domain-specific
 * view with the old → new pct diff so the commercial impact of the
 * edit is readable in Discord.
 *
 * `previous` is null for first-time creates (no prior row to diff).
 * Actor id is truncated to the last 8 chars per ADR 018 convention.
 * `merchantName` falls back to merchantId at the call site — we
 * don't redo the fallback here so the embed text reflects what the
 * admin actually saw in the UI.
 */
export function notifyCashbackConfigChanged(args: {
  merchantId: string;
  merchantName: string;
  actorUserId: string;
  previous: CashbackConfigSnapshot | null;
  next: CashbackConfigSnapshot;
}): void {
  const actorTail = args.actorUserId.slice(-8);
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    {
      name: 'Merchant',
      value: truncate(escapeMarkdown(args.merchantName), FIELD_VALUE_MAX),
      inline: true,
    },
    { name: 'Admin', value: `\`${actorTail}\``, inline: true },
    {
      name: 'New',
      value: fmtConfigLine(args.next),
      inline: false,
    },
  ];
  if (args.previous !== null) {
    fields.push({
      name: 'Previous',
      value: fmtConfigLine(args.previous),
      inline: false,
    });
  }
  const isCreate = args.previous === null;
  void sendWebhook(env.DISCORD_WEBHOOK_ADMIN_AUDIT, {
    title: isCreate ? '🟢 Cashback config created' : '🔧 Cashback config updated',
    color: isCreate ? GREEN : BLUE,
    fields,
  });
}

function fmtConfigLine(s: CashbackConfigSnapshot): string {
  const body =
    `wholesale ${escapeMarkdown(s.wholesalePct)}%` +
    ` · cashback ${escapeMarkdown(s.userCashbackPct)}%` +
    ` · margin ${escapeMarkdown(s.loopMarginPct)}%` +
    ` · ${s.active ? 'active' : 'inactive'}`;
  return truncate(body, FIELD_VALUE_MAX);
}
