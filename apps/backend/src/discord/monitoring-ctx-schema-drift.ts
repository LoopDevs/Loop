// CTX-schema drift notifier + per-surface dedup — A2-1915
import { config } from '../config/index.js';
import {
  DESCRIPTION_MAX,
  FIELD_VALUE_MAX,
  ORANGE,
  escapeMarkdown,
  sendWebhook,
  truncate,
} from './shared.js';

// A2-1915: dedup keyed on surface name to prevent alert flooding; 10-minute window matches CTX-credential dedup
const CTX_SCHEMA_DRIFT_DEDUP_MS = 10 * 60 * 1000;
const ctxSchemaDriftLastNotified = new Map<string, number>();

// A2-1915: runtime companion to PR-time contract test (A2-1706); `surface` must match contract test identifier for ops grep
export function notifyCtxSchemaDrift(args: { surface: string; issuesSummary: string }): void {
  const now = Date.now();
  const last = ctxSchemaDriftLastNotified.get(args.surface);
  if (last !== undefined && now - last < CTX_SCHEMA_DRIFT_DEDUP_MS) {
    return;
  }
  ctxSchemaDriftLastNotified.set(args.surface, now);
  void sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '⚠️ CTX schema drift detected',
    description: truncate(
      `Upstream CTX response no longer matches the expected schema for \`${escapeMarkdown(args.surface)}\`. Cross-check against the recorded fixture in \`apps/backend/src/__fixtures__/ctx/\` (A2-1706) and either update our schema or escalate to CTX.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'Surface', value: `\`${escapeMarkdown(args.surface)}\``, inline: true },
      {
        name: 'Zod issues',
        value: truncate(escapeMarkdown(args.issuesSummary), FIELD_VALUE_MAX),
        inline: false,
      },
    ],
  });
}

export function __resetCtxSchemaDriftDedupForTests(): void {
  ctxSchemaDriftLastNotified.clear();
}
