/**
 * Monitoring-channel Discord notifiers — fires to
 * `env.DISCORD_WEBHOOK_MONITORING`. Twelve signals covering the
 * fleet-health surfaces operators watch for incidents:
 *
 *   - **Service health flap** — `notifyHealthChange`
 *     (healthy ↔ degraded transitions emitted by the /health
 *     handler's flap-damping window in `health.ts`).
 *   - **Stellar payouts** — `notifyPayoutFailed` (transition to
 *     `failed` with kind/reason for ops triage),
 *     `notifyUsdcBelowFloor` (operator USDC reserve dipped below
 *     the configured floor — procurement falls back to XLM).
 *   - **LOOP asset drift** — `notifyAssetDrift` /
 *     `notifyAssetDriftRecovered` (over→ok closes the incident
 *     so the channel reads as paired open + close events).
 *   - **Stuck-row sweepers** — `notifyStuckProcurementSwept`
 *     (A2-621 — `procuring` → `failed` per-row drilldown),
 *     `notifyPaymentWatcherStuck` (A2-626 — Horizon cursor age
 *     past stale-threshold).
 *   - **Upstream contract** — `notifyCtxSchemaDrift` (A2-1915 —
 *     CTX response failed Zod validation against a recorded
 *     fixture; per-surface 10-minute dedup),
 *     `notifyOperatorPoolExhausted` (every operator in the pool
 *     unhealthy).
 *   - **Circuit-breaker transitions** — `notifyCircuitBreaker`
 *     (per-(name,state) 10-minute dedup so a flapping circuit
 *     doesn't flood the channel — A2-1326).
 *
 * Two test seams (`__resetCircuitNotifyDedupForTests` /
 * `__resetCtxSchemaDriftDedupForTests`) wipe the per-process
 * dedup maps so tests can exercise the throttles deterministically.
 *
 * Pulled out of `discord.ts` so the per-channel surfaces are
 * traceable to one file each. Shared infrastructure
 * (`sendWebhook`, `truncate`, `escapeMarkdown`, colour constants)
 * lives in `./shared.ts`.
 */
import { env } from '../env.js';
import {
  DESCRIPTION_MAX,
  FIELD_VALUE_MAX,
  GREEN,
  ORANGE,
  RED,
  escapeMarkdown,
  sendWebhook,
  truncate,
} from './shared.js';

/** Notify: health status changed */
export function notifyHealthChange(status: 'healthy' | 'degraded', details: string): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: status === 'healthy' ? '💚 Service Healthy' : '🟠 Service Degraded',
    description: truncate(details, DESCRIPTION_MAX),
    color: status === 'healthy' ? GREEN : ORANGE,
  });
}

/**
 * Notify: an outbound Stellar payout has transitioned to `failed`
 * (ADR 015/016). Pages the monitoring channel so ops sees it
 * real-time rather than discovering failed rows on the next
 * admin-treasury refresh. The `kind` (from PayoutSubmitError) tells
 * ops whether it's an ops-actionable issue (op_no_trust,
 * op_underfunded) or a retry-exhausted transient — the former
 * often needs the user to add a trustline, the latter is a cue to
 * check Horizon / operator reserves.
 */
export function notifyPayoutFailed(args: {
  payoutId: string;
  userId: string;
  /** Null for `kind='withdrawal'` payouts (A2-901 / ADR-024 §2). */
  orderId: string | null;
  assetCode: string;
  amount: string;
  kind: string;
  reason: string;
  attempts: number;
}): void {
  // A2-1314: ADR-018 last-8 convention. Prior shape emitted full
  // userId / orderId / payoutId into the monitoring channel, so an
  // admin with Discord access but no DB access could reconstruct a
  // user's full uuid + order history from a stream of failures. The
  // tail-id is enough to pivot into the admin shell where the full
  // id lives alongside the access-controlled context.
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 Stellar Payout Failed',
    color: RED,
    fields: [
      { name: 'Kind', value: `\`${escapeMarkdown(args.kind)}\``, inline: true },
      { name: 'Asset', value: escapeMarkdown(args.assetCode), inline: true },
      { name: 'Amount', value: escapeMarkdown(args.amount), inline: true },
      { name: 'Attempts', value: String(args.attempts), inline: true },
      { name: 'User', value: `\`${args.userId.slice(-8)}\``, inline: true },
      {
        name: 'Order',
        value: args.orderId === null ? '_withdrawal_' : `\`${args.orderId.slice(-8)}\``,
        inline: true,
      },
      { name: 'Payout', value: `\`${args.payoutId.slice(-8)}\``, inline: true },
      {
        name: 'Reason',
        value: truncate(escapeMarkdown(args.reason), FIELD_VALUE_MAX),
        inline: false,
      },
    ],
  });
}

/**
 * Notify: a payout's destination account is missing the required
 * trustline (ADR 015 / ADR 016 §"trustline-probe before payout
 * submit"). The payout-worker holds the row in `pending` rather
 * than burning it on `op_no_trust`; ops is paged so the user can
 * be nudged to add the trustline.
 *
 * Throttled to once per (userId, assetCode) per process so a stuck
 * row that the worker re-probes every tick doesn't flood the
 * channel. Reset by `__resetAwaitingTrustlineDedupForTests`.
 */
const awaitingTrustlineFired = new Set<string>();
export function __resetAwaitingTrustlineDedupForTests(): void {
  awaitingTrustlineFired.clear();
}
export function notifyPayoutAwaitingTrustline(args: {
  payoutId: string;
  userId: string;
  account: string;
  assetCode: string;
  assetIssuer: string;
  accountExists: boolean;
}): void {
  const key = `${args.userId}::${args.assetCode}`;
  if (awaitingTrustlineFired.has(key)) return;
  awaitingTrustlineFired.add(key);
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🟡 Payout awaiting trustline',
    description: truncate(
      `User ${args.userId.slice(-8)} has linked ${args.account.slice(0, 8)}…${args.account.slice(-4)} but ${
        args.accountExists
          ? `the account has no trustline to ${args.assetCode}`
          : `the account is not yet activated on Stellar (no balance reserve)`
      }. Payout ${args.payoutId.slice(-8)} stays in \`pending\` and will submit on the next worker tick after the trustline is added.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'User', value: `\`${args.userId.slice(-8)}\``, inline: true },
      { name: 'Asset', value: escapeMarkdown(args.assetCode), inline: true },
      { name: 'Issuer', value: `\`${args.assetIssuer.slice(0, 8)}…\``, inline: true },
      { name: 'Account exists?', value: args.accountExists ? 'yes' : 'no', inline: true },
      { name: 'Payout', value: `\`${args.payoutId.slice(-8)}\``, inline: true },
    ],
  });
}

/**
 * Notify: operator USDC balance has dropped below the configured
 * floor (ADR 015). Procurement is now paying CTX in XLM until the
 * reserve is topped up. Ops needs to know because XLM is the
 * break-glass rail — we're burning the (smaller) XLM reserve to
 * keep orders flowing and the USDC pile isn't earning defindex
 * yield while it's empty.
 *
 * Throttled at the caller (once per `LOOP_BELOW_FLOOR_ALERT_INTERVAL_MS`
 * per process) — this function itself fires every time.
 */
/**
 * Interest-pool depletion alert (ADR 009 / 015 forward-mint pool).
 *
 * Fires when the on-chain pool balance can cover fewer than the
 * configured minimum days of forecast daily interest. Operator's
 * action: mint the next batch into the pool before users would be
 * under-allocated. One-shot per process per cohort — we don't want
 * to re-page every tick during the same low-cover window.
 */
const poolDepletionFired = new Set<string>();

export function __resetPoolDepletionDedupForTests(): void {
  poolDepletionFired.clear();
}

export function notifyInterestPoolLow(args: {
  assetCode: string;
  poolStroops: string;
  dailyInterestStroops: string;
  daysOfCover: number;
  minDaysOfCover: number;
}): void {
  if (poolDepletionFired.has(args.assetCode)) return;
  poolDepletionFired.add(args.assetCode);
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🟠 Interest pool running low',
    description: truncate(
      `${escapeMarkdown(args.assetCode)} forward-mint pool has ${args.daysOfCover.toFixed(1)} days of cover left (minimum ${args.minDaysOfCover}). Mint the next batch into the pool account before users are under-allocated.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'Asset', value: escapeMarkdown(args.assetCode), inline: true },
      { name: 'Pool (stroops)', value: escapeMarkdown(args.poolStroops), inline: true },
      {
        name: 'Daily interest (stroops)',
        value: escapeMarkdown(args.dailyInterestStroops),
        inline: true,
      },
      { name: 'Days of cover', value: args.daysOfCover.toFixed(2), inline: true },
      { name: 'Minimum', value: String(args.minDaysOfCover), inline: true },
    ],
  });
}

export function notifyInterestPoolRecovered(args: {
  assetCode: string;
  poolStroops: string;
  daysOfCover: number;
}): void {
  if (!poolDepletionFired.has(args.assetCode)) return;
  poolDepletionFired.delete(args.assetCode);
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '✅ Interest pool replenished',
    description: truncate(
      `${escapeMarkdown(args.assetCode)} forward-mint pool now has ${args.daysOfCover.toFixed(1)} days of cover. Closing the prior depletion alert.`,
      DESCRIPTION_MAX,
    ),
    color: GREEN,
    fields: [
      { name: 'Asset', value: escapeMarkdown(args.assetCode), inline: true },
      { name: 'Pool (stroops)', value: escapeMarkdown(args.poolStroops), inline: true },
      { name: 'Days of cover', value: args.daysOfCover.toFixed(2), inline: true },
    ],
  });
}

/**
 * A4-023: notify ops when an order's pinned `chargeCurrency`
 * diverges from the user's `homeCurrency` at fulfillment time.
 * The cashback ledger row still writes (off-chain liability is
 * the source of truth, ADR-009) but the on-chain LOOP-asset
 * payout is skipped — the 1:1 peg is broken until ops manually
 * issues the on-chain payout in the right currency. Fires once
 * per affected order; the operator decides whether to manually
 * compensate, change the user's home currency back, or accept
 * the divergence.
 */
export function notifyPegBreakOnFulfillment(args: {
  orderId: string;
  userId: string;
  chargeCurrency: string;
  userHomeCurrency: string;
  cashbackMinor: string;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🚨 LOOP-asset peg break on fulfillment',
    description: truncate(
      `Order ${escapeMarkdown(args.orderId)} fulfilled with chargeCurrency=${escapeMarkdown(args.chargeCurrency)} but user.homeCurrency=${escapeMarkdown(args.userHomeCurrency)}. Off-chain cashback credited; on-chain payout SKIPPED. Manual compensation needed to restore the 1:1 peg.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'Order', value: escapeMarkdown(args.orderId), inline: true },
      { name: 'User', value: escapeMarkdown(args.userId), inline: true },
      { name: 'Charge ccy', value: escapeMarkdown(args.chargeCurrency), inline: true },
      { name: 'Home ccy', value: escapeMarkdown(args.userHomeCurrency), inline: true },
      { name: 'Cashback (minor)', value: escapeMarkdown(args.cashbackMinor), inline: true },
    ],
  });
}

export function notifyUsdcBelowFloor(args: {
  balanceStroops: string;
  floorStroops: string;
  account: string;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🟡 USDC Reserve Below Floor',
    description: truncate(
      `Procurement has fallen back to XLM. Top up ${escapeMarkdown(args.account)} with USDC to re-enable the yield-earning path.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'Balance (stroops)', value: escapeMarkdown(args.balanceStroops), inline: true },
      { name: 'Floor (stroops)', value: escapeMarkdown(args.floorStroops), inline: true },
    ],
  });
}

// `notifyAssetDrift` and `notifyAssetDriftRecovered` (the paired
// open-and-close drift-watcher notifiers, ADR 015) live in
// `./monitoring-asset-drift.ts`. Re-exported below so existing
// import sites resolve unchanged.
export { notifyAssetDrift, notifyAssetDriftRecovered } from './monitoring-asset-drift.js';

// `notifyStuckProcurementSwept` (A2-621) and
// `notifyPaymentWatcherStuck` (A2-626) — the two stuck-row sweeper
// notifiers — live in `./monitoring-stuck-sweepers.ts`. Re-exported
// below so existing import sites resolve unchanged.
export {
  notifyStuckProcurementSwept,
  notifyPaymentWatcherStuck,
  notifyStuckPayouts,
} from './monitoring-stuck-sweepers.js';

// `notifyCtxSchemaDrift` (A2-1915) and its per-surface dedup state
// live in `./monitoring-ctx-schema-drift.ts`. Re-exported below
// alongside `__resetCtxSchemaDriftDedupForTests` so existing import
// sites keep resolving against `discord/monitoring.ts`.
export {
  notifyCtxSchemaDrift,
  __resetCtxSchemaDriftDedupForTests,
} from './monitoring-ctx-schema-drift.js';

/**
 * Notify: the CTX operator pool has no healthy operators (ADR 013).
 * Fires from `operatorFetch` after every breaker in the pool tripped.
 * Paired with a 15-minute throttle at the call site so sustained
 * outages don't flood the monitoring channel.
 */
export function notifyOperatorPoolExhausted(args: { poolSize: number; reason: string }): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 CTX Operator Pool Exhausted',
    description: truncate(
      `Every operator in the pool is unhealthy. Loop-native procurement is blocked until at least one circuit recovers.`,
      DESCRIPTION_MAX,
    ),
    color: RED,
    fields: [
      { name: 'Pool size', value: String(args.poolSize), inline: true },
      {
        name: 'Last error',
        value: truncate(escapeMarkdown(args.reason), FIELD_VALUE_MAX),
        inline: false,
      },
    ],
  });
}

// `notifyCircuitBreaker` (A2-1326) and its per-(name, state) dedup
// state live in `./monitoring-circuit-breaker.ts`. Re-exported below
// alongside `__resetCircuitNotifyDedupForTests` so existing import
// sites — including `circuit-breaker.ts` and the discord test
// suite — resolve unchanged.
export {
  notifyCircuitBreaker,
  __resetCircuitNotifyDedupForTests,
} from './monitoring-circuit-breaker.js';
