/**
 * `notifyCtxSchemaDrift` — runtime CTX-schema drift notifier
 * (A2-1915), with its per-surface dedup state.
 *
 * Lifted out of `apps/backend/src/discord/monitoring.ts` so the
 * dedup map + the notifier + the test-seam reset live together
 * in one focused ~50-line module instead of being interleaved
 * with the eleven other monitoring-channel notifiers in the
 * parent file.
 *
 * Re-exported through `discord/monitoring.ts` (and by extension
 * the top-level `discord.ts` barrel) so existing import sites
 * keep working unchanged.
 */
import { env } from '../env.js';
import {
  DESCRIPTION_MAX,
  FIELD_VALUE_MAX,
  ORANGE,
  escapeMarkdown,
  sendWebhook,
  truncate,
} from './shared.js';

/**
 * A2-1915: dedup keyed on the surface name so a single CTX endpoint
 * silently breaking doesn't flood `#monitoring` with one alert per
 * failed parse. Same 10-minute window as the circuit-breaker dedup.
 */
const CTX_SCHEMA_DRIFT_DEDUP_MS = 10 * 60 * 1000;
const ctxSchemaDriftLastNotified = new Map<string, number>();

/**
 * A2-1915 — runtime CTX-schema drift detector.
 *
 * Fires when an upstream CTX response fails Zod validation on a
 * surface that has a recorded contract fixture (A2-1706). This is
 * the runtime companion to the PR-time contract test:
 *
 *   - PR-time gate: `apps/backend/src/__tests__/ctx-contract.test.ts`
 *     blocks our-side narrowings against the recorded fixtures.
 *   - Runtime detector: this notifier surfaces CTX-side drift when
 *     a real response no longer matches our expected shape.
 *
 * Per-surface dedup means a sustained drift produces one alert per
 * 10 minutes, not one per failed request. The `surface` arg should
 * be the same identifier used in the contract test
 * (`POST /verify-email`, `GET /merchants`, etc.) so ops can grep
 * back to the fixture / schema pair.
 */
export function notifyCtxSchemaDrift(args: { surface: string; issuesSummary: string }): void {
  const now = Date.now();
  const last = ctxSchemaDriftLastNotified.get(args.surface);
  if (last !== undefined && now - last < CTX_SCHEMA_DRIFT_DEDUP_MS) {
    return;
  }
  ctxSchemaDriftLastNotified.set(args.surface, now);
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
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

/** Test helper — wipe the per-surface dedup map. */
export function __resetCtxSchemaDriftDedupForTests(): void {
  ctxSchemaDriftLastNotified.clear();
}
