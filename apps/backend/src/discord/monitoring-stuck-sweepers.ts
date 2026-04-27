/**
 * `notifyStuckProcurementSwept` (A2-621) and
 * `notifyPaymentWatcherStuck` (A2-626) — the two stuck-row
 * sweeper notifiers.
 *
 * Lifted out of `apps/backend/src/discord/monitoring.ts` because
 * both notifiers cover the same concern: a worker has noticed that
 * a row that *should* have advanced past a transient state hasn't,
 * and ops needs the per-row drill-down so they can reconcile (in
 * the procurement case) or restart the watcher (in the cursor
 * case).
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
  RED,
  escapeMarkdown,
  sendWebhook,
  truncate,
} from './shared.js';

/**
 * A2-621: notify when a `procuring` order ages out and the recovery
 * sweep flipped it to `failed`. A sweep-swept row is ambiguous — we
 * don't know whether CTX actually minted the gift card (in which
 * case Loop was charged but the user is stuck) or the POST never
 * landed (in which case Loop is whole). Ops has to reconcile
 * manually against CTX's side by looking up the order id or the
 * operator's charge history.
 *
 * Runs per-swept-row (not aggregated) because each row needs
 * individual investigation and the sweep normally catches zero rows
 * per tick — the day this fires is the day the channel needs the
 * full drill-down, not a "1 more swept" counter.
 */
export function notifyStuckProcurementSwept(args: {
  orderId: string;
  userId: string;
  merchantId: string;
  chargeMinor: string;
  chargeCurrency: string;
  ctxOperatorId: string | null;
  procuredAtMs: number;
}): void {
  const stuckForMs = Date.now() - args.procuredAtMs;
  const stuckForMin = Math.round(stuckForMs / 60_000);
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🟡 Stuck Procuring Order Swept to Failed',
    description: truncate(
      `An order sat in \`procuring\` for ${stuckForMin} min and was just swept to \`failed\`. Reconcile against CTX before any user-facing refund — if CTX minted the card, the user is stuck with a paid CTX gift card that Loop thinks never happened.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'Order', value: `\`${escapeMarkdown(args.orderId)}\``, inline: false },
      { name: 'User', value: `\`${escapeMarkdown(args.userId)}\``, inline: true },
      { name: 'Merchant', value: escapeMarkdown(args.merchantId), inline: true },
      { name: 'Charge', value: `${args.chargeMinor} ${args.chargeCurrency}`, inline: true },
      {
        name: 'Operator',
        value: args.ctxOperatorId ? `\`${escapeMarkdown(args.ctxOperatorId)}\`` : '_none_',
        inline: true,
      },
      { name: 'Stuck for (min)', value: String(stuckForMin), inline: true },
    ],
  });
}

/**
 * A2-626: notify when the payment watcher's cursor hasn't advanced
 * past the stale-threshold. Fires once per stuck period — if the
 * cursor moves again, the per-process gate resets and a future stall
 * can alert fresh.
 *
 * Distinct signal from circuit breaker or health-change: the
 * watcher can be "running" (no exception loop-killing) but stuck
 * on an upstream Horizon issue, a DB write failure on cursor
 * persistence, or a subtle bug in the tick. The cursor-age probe
 * is the only independent observation that catches all of those.
 */
export function notifyPaymentWatcherStuck(args: {
  cursorAgeMs: number;
  lastCursor: string;
  lastUpdatedAtMs: number;
}): void {
  const ageMin = Math.round(args.cursorAgeMs / 60_000);
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 Payment Watcher Cursor Stuck',
    description: truncate(
      `The payment watcher cursor has not advanced in ${ageMin} min. Fresh deposits are not being observed. Check the watcher process, Horizon reachability, and the DB's ability to persist the cursor row.`,
      DESCRIPTION_MAX,
    ),
    color: RED,
    fields: [
      { name: 'Cursor age (min)', value: String(ageMin), inline: true },
      {
        name: 'Last cursor',
        value: truncate(`\`${escapeMarkdown(args.lastCursor)}\``, FIELD_VALUE_MAX),
        inline: false,
      },
      {
        name: 'Last updated',
        value: new Date(args.lastUpdatedAtMs).toISOString(),
        inline: true,
      },
    ],
  });
}
