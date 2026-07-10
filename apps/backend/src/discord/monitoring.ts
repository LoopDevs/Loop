/**
 * Monitoring-channel Discord notifiers — fires to
 * `env.DISCORD_WEBHOOK_MONITORING`. Signals covering the
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
 *     past stale-threshold), `notifyRedemptionBackfillExhausted`
 *     (redemption-backfill sweeper hit the attempts cap with the
 *     order still missing its redemption payload).
 *   - **Upstream contract** — `notifyCtxSchemaDrift` (A2-1915 —
 *     CTX response failed Zod validation against a recorded
 *     fixture; per-surface 10-minute dedup),
 *     `notifyOperatorPoolExhausted` (every operator in the pool
 *     unhealthy).
 *   - **Circuit-breaker transitions** — `notifyCircuitBreaker`
 *     (per-(name,state) 10-minute dedup so a flapping circuit
 *     doesn't flood the channel — A2-1326).
 *
 * Test seams (`__resetCircuitNotifyDedupForTests` /
 * `__resetCtxSchemaDriftDedupForTests` /
 * `__resetUnrecognizedDepositDedupForTests`) wipe the per-process
 * dedup state so tests can exercise the throttles deterministically.
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
import type { OperatorFloatRunSummary } from '../payments/operator-float-reconciliation.js';

/** Notify: health status changed */
export function notifyHealthChange(status: 'healthy' | 'degraded', details: string): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: status === 'healthy' ? '💚 Service Healthy' : '🟠 Service Degraded',
    description: truncate(details, DESCRIPTION_MAX),
    color: status === 'healthy' ? GREEN : ORANGE,
  });
}

/**
 * Notify: the operator-provided GeoLite2-Country `.mmdb` is stale (built
 * more than `thresholdDays` ago) or configured-but-unopenable
 * (`buildEpoch: null` — bad path / unreadable file / a deploy that forgot
 * the BuildKit secrets). go-live-plan §T1-F: the fix is always the same —
 * redeploy with the two `--build-secret` flags (docs/deployment.md
 * §GeoLite2). This is a "remember to redeploy" nudge, not an incident, so
 * the call site (`health.ts`) throttles it to once per
 * `GEO_DB_NOTIFY_COOLDOWN_MS` (7 days) rather than firing on every
 * `/health` probe while the condition persists.
 */
export function notifyGeoDbStale(args: {
  buildEpoch: string | null;
  ageDays: number | null;
  thresholdDays: number;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🟡 GeoLite2 database stale',
    description: truncate(
      args.buildEpoch === null
        ? `MAXMIND_GEOLITE2_PATH is configured but the .mmdb failed to open — the \`/\` geo-redirect first-guess is silently falling back to the US default (ADR 034). Redeploy with the two --build-secret flags (docs/deployment.md §GeoLite2) to restore it.`
        : `The baked-in GeoLite2-Country .mmdb was built ${args.ageDays ?? '?'} day(s) ago (built ${args.buildEpoch}), past the ${args.thresholdDays}-day staleness threshold. MaxMind ships weekly — redeploy with the two --build-secret flags (docs/deployment.md §GeoLite2) to pick up a fresh database.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'Build epoch', value: args.buildEpoch ?? '_open failed_', inline: true },
      {
        name: 'Age (days)',
        value: args.ageDays === null ? '_n/a_' : String(args.ageDays),
        inline: true,
      },
      { name: 'Threshold (days)', value: String(args.thresholdDays), inline: true },
    ],
  });
}

/** Notify: operator XLM/USDC float conservation drifted or cannot classify wallet flow. */
export function notifyOperatorFloatDrift(args: OperatorFloatRunSummary): void {
  const suffix = args.state === 'error' ? 'check failed' : args.state;
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: `🔴 Operator Float Reconciliation — ${suffix}`,
    description: truncate(
      args.error ??
        `Operator ${args.asset.toUpperCase()} wallet does not reconcile from its active baseline. Triage /api/admin/treasury and unclassified operator wallet movements before treating the float as healthy.`,
      DESCRIPTION_MAX,
    ),
    color: RED,
    fields: [
      { name: 'Asset', value: `\`${args.asset.toUpperCase()}\``, inline: true },
      { name: 'State', value: `\`${args.state}\``, inline: true },
      {
        name: 'Account',
        value: `\`${escapeMarkdown(args.account.slice(0, 8))}…${escapeMarkdown(args.account.slice(-8))}\``,
        inline: true,
      },
      {
        name: 'Expected',
        value:
          args.expectedBalanceStroops === null ? '_n/a_' : `\`${args.expectedBalanceStroops}\``,
        inline: true,
      },
      {
        name: 'Actual',
        value: args.actualBalanceStroops === null ? '_n/a_' : `\`${args.actualBalanceStroops}\``,
        inline: true,
      },
      {
        name: 'Delta',
        value: args.deltaStroops === null ? '_n/a_' : `\`${args.deltaStroops}\``,
        inline: true,
      },
      {
        name: 'Threshold',
        value: `\`${args.thresholdStroops}\``,
        inline: true,
      },
      {
        name: 'Unclassified',
        value: `\`${args.unclassifiedCount}\``,
        inline: true,
      },
    ],
  });
}

/**
 * Notify: the payment watcher skipped an incoming deposit for a
 * reason ops should look at immediately (A4-110 missing credit row,
 * or an unexpected processing error). Transient skips
 * (amount_insufficient during an oracle blip, asset_mismatch user
 * error) retry quietly under the skip-table budget and only page on
 * abandonment. Fired once on first record — the upsert keyed on the
 * Horizon payment id keeps retries from re-paging.
 */
export function notifyDepositSkipRecorded(args: {
  paymentId: string;
  orderId: string | null;
  reason: string;
  detail: string | null;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🟠 Deposit Skipped — needs investigation',
    color: ORANGE,
    fields: [
      { name: 'Reason', value: `\`${escapeMarkdown(args.reason)}\``, inline: true },
      { name: 'Payment', value: `\`${args.paymentId.slice(-8)}\``, inline: true },
      {
        name: 'Order',
        value: args.orderId === null ? '_none_' : `\`${args.orderId.slice(-8)}\``,
        inline: true,
      },
      ...(args.detail !== null
        ? [
            {
              name: 'Detail',
              value: truncate(escapeMarkdown(args.detail), FIELD_VALUE_MAX),
              inline: false,
            },
          ]
        : []),
    ],
  });
}

/**
 * AUDIT-2 finding C — throttled + rolled-up notifier for
 * `unrecognized_deposit` skip rows (a payment that delivered value to
 * the deposit address but matched no order rail).
 *
 * WHY THIS IS SEPARATE FROM `notifyDepositSkipRecorded`'s per-row page:
 * unlike `missing_credit_row` / `processing_error` (which need an
 * internal bug or corrupt state to trigger, so a per-row page is safe),
 * the deposit address is PUBLIC — it's the operator account, disclosed
 * to every payer and fully visible on Horizon. A single ~1¢ transaction
 * can carry up to 100 payment ops, each a dust-floor deposit with a
 * garbage memo, so a per-row first-record page would let anyone fire up
 * to ~50 embeds/tick at `DISCORD_WEBHOOK_MONITORING` — which is SHARED
 * with asset-drift / cursor / stuck-payout / ledger-invariant /
 * circuit-breaker pages. Past Discord's ~5-req/2s webhook limit, a real
 * page (a genuine stranded deposit, or a stuck-payout page timed to
 * coincide) gets silently dropped.
 *
 * So this pages at most once per `UNRECOGNIZED_DEPOSIT_NOTIFY_WINDOW_MS`
 * with a ROLLED-UP count of how many rows accumulated since the last
 * page (mirrors the circuit-breaker `CIRCUIT_NOTIFY_DEDUP_MS` +
 * asset-drift per-key dedup precedents — docs/alerting.md). A genuine
 * lone stranded deposit landing into a quiet channel still pages
 * promptly (leading edge); a burst collapses to one count-bearing page.
 * The DURABLE recovery surface is unchanged — every row is still written
 * to `payment_watcher_skips` unconditionally by `recordSkip` and shows
 * on `/admin/skips`; only the Discord page is bounded here.
 *
 * Per-process state (module-level), matching every other dedup in this
 * file. The payment-watcher tick is itself fleet-single-flighted (S4-8
 * advisory lock), so in practice only the lock-holding machine records
 * these rows per tick — the window is effectively fleet-consistent for
 * this path modulo an occasional lock handoff, which is bounded by the
 * same ~window as the circuit-breaker precedent tolerates.
 */
const UNRECOGNIZED_DEPOSIT_NOTIFY_WINDOW_MS = 15 * 60 * 1000;
let unrecognizedDepositLastAlertAt = 0;
/** Rows recorded but not yet reflected in a page since the last alert. */
let unrecognizedDepositPending = 0;

/** Test helper — wipe the throttle + roll-up counter. */
export function __resetUnrecognizedDepositDedupForTests(): void {
  unrecognizedDepositLastAlertAt = 0;
  unrecognizedDepositPending = 0;
}

export function notifyUnrecognizedDepositRecorded(args: {
  paymentId: string;
  detail: string | null;
}): void {
  // Each call is one freshly-recorded row — the DB write + /admin/skips
  // visibility already happened unconditionally in recordSkip. Accumulate
  // first so a suppressed burst still rolls into the next page's count.
  unrecognizedDepositPending += 1;
  const now = Date.now();
  if (now - unrecognizedDepositLastAlertAt < UNRECOGNIZED_DEPOSIT_NOTIFY_WINDOW_MS) {
    // Inside the window — hold the page; the count carries forward.
    return;
  }
  const count = unrecognizedDepositPending;
  unrecognizedDepositPending = 0;
  unrecognizedDepositLastAlertAt = now;

  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🟠 Unrecognized inbound deposit — recovery needed',
    color: ORANGE,
    description: truncate(
      count === 1
        ? 'A deposit landed at the deposit address that matched no order rail (wrong/no memo, or an unrecognized asset). It is recorded on /admin/skips for manual reconciliation.'
        : `${count} deposits landed at the deposit address that matched no order rail since the last alert (~15 min). All are recorded on /admin/skips for manual reconciliation. This page is throttled + rolled up — the deposit address is public and can be cheaply spammed with dust, so a burst collapses to one count-bearing page.`,
      DESCRIPTION_MAX,
    ),
    fields: [
      { name: 'Recorded since last alert', value: String(count), inline: true },
      { name: 'Latest payment', value: `\`${args.paymentId.slice(-8)}\``, inline: true },
      ...(args.detail !== null
        ? [
            {
              name: 'Latest detail',
              value: truncate(escapeMarkdown(args.detail), FIELD_VALUE_MAX),
              inline: false,
            },
          ]
        : []),
    ],
  });
}

/**
 * Notify: a skipped deposit exhausted its retry budget or its order
 * left `pending_payment` without it — the user's funds sit in the
 * deposit account with no order to credit. Always pages: this is
 * the "user paid and got nothing" state that needs a manual refund
 * or recovery decision.
 */
export function notifyDepositSkipAbandoned(args: {
  paymentId: string;
  orderId: string | null;
  reason: string;
  attempts: number;
  note: string;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 Skipped Deposit Abandoned — funds need manual reconciliation',
    color: RED,
    fields: [
      { name: 'Reason', value: `\`${escapeMarkdown(args.reason)}\``, inline: true },
      { name: 'Attempts', value: String(args.attempts), inline: true },
      { name: 'Payment', value: `\`${args.paymentId.slice(-8)}\``, inline: true },
      {
        name: 'Order',
        value: args.orderId === null ? '_none_' : `\`${args.orderId.slice(-8)}\``,
        inline: true,
      },
      { name: 'Note', value: truncate(escapeMarkdown(args.note), FIELD_VALUE_MAX), inline: false },
    ],
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
  /** Null for `kind='emission'` / `kind='interest_mint'` payouts (ADR-024 §2 / ADR 036 / ADR 031). */
  orderId: string | null;
  /**
   * `pending_payouts.kind` — labels the Order field for order-less
   * rows so an interest mint doesn't read as an emission. Optional
   * for caller compatibility; absent + null orderId renders the
   * historical `_emission_`.
   */
  payoutKind?: string | undefined;
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
        value:
          args.orderId === null
            ? `_${escapeMarkdown(args.payoutKind ?? 'emission')}_`
            : `\`${args.orderId.slice(-8)}\``,
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
 * under-allocated.
 *
 * C10a: these are now PURE SENDERS — the low↔ok transition dedup moved
 * to `interest_pool_alert_state` (durable + fleet-consistent +
 * at-least-once). They return the `sendWebhook` promise so the watcher
 * only advances `last_paged_state` after delivery confirms. No
 * internal Set: a per-process Set made the recovery close drop
 * whenever a different machine handled it than had paged the low.
 */
export function notifyInterestPoolLow(args: {
  assetCode: string;
  poolStroops: string;
  dailyInterestStroops: string;
  daysOfCover: number;
  minDaysOfCover: number;
}): Promise<boolean> {
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
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
}): Promise<boolean> {
  // C10a: recovery is now driven by persisted state, so it can fire on
  // a low→ok flip where daily interest has since dropped to 0 (cohort
  // drained) → daysOfCover = +Infinity. Render that as "ample" rather
  // than the literal "Infinity".
  const coverText = Number.isFinite(args.daysOfCover) ? args.daysOfCover.toFixed(1) : 'ample';
  const coverField = Number.isFinite(args.daysOfCover) ? args.daysOfCover.toFixed(2) : 'ample';
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '✅ Interest pool replenished',
    description: truncate(
      `${escapeMarkdown(args.assetCode)} forward-mint pool now has ${coverText} days of cover. Closing the prior depletion alert.`,
      DESCRIPTION_MAX,
    ),
    color: GREEN,
    fields: [
      { name: 'Asset', value: escapeMarkdown(args.assetCode), inline: true },
      { name: 'Pool (stroops)', value: escapeMarkdown(args.poolStroops), inline: true },
      { name: 'Days of cover', value: coverField, inline: true },
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

/**
 * CF-20 (x-flows F1-1, v-orders P2-02): notify ops when an order fails
 * after the user has already paid Loop (every order reaches this path
 * from `state='paid'`). Two shapes:
 *
 *   - `ctxPaid=true` — Loop has ALSO already paid CTX (operator XLM/USDC
 *     spent) before the failure. The procurement worker auto-refunds the
 *     user's off-chain balance, but Loop's operator-side settlement to
 *     CTX is now an outstanding debt — ops must chase a refund/credit
 *     from CTX for the wholesale cost.
 *   - `ctxPaid=false` (CF2-05, 2026-06-30 cold audit) — the failure
 *     happened BEFORE Loop ever paid CTX (a bad CTX response, schema
 *     drift, a malformed payment URL/SEP-7 URI) — this is actually the
 *     larger share of real procurement failures. No operator-side CTX
 *     debt exists; only the user needs to be made whole. Lower severity
 *     (no treasury exposure) but still needs paging when the auto-refund
 *     itself fails.
 *
 * Unlike the generic `markOrderFailed` (a silent `log.error`), this pages
 * because there is a recovery action only a human can verify happened
 * correctly. `refunded` distinguishes "user made whole" from "auto-refund
 * itself failed too" (the worst case for the ctxPaid branch — both user
 * AND treasury are out, needs immediate manual intervention).
 */
export function notifyOrderFailedAfterCtxPaid(args: {
  orderId: string;
  ctxOrderId: string | null;
  userId: string;
  chargeMinor: string;
  chargeCurrency: string;
  reason: string;
  refunded: boolean;
  ctxPaid: boolean;
}): void {
  const title = args.ctxPaid
    ? args.refunded
      ? '🔴 Order failed after CTX paid — user refunded, CTX debt open'
      : '🚨 Order failed after CTX paid — AUTO-REFUND FAILED (user + treasury out)'
    : args.refunded
      ? '🟡 Order failed before CTX paid — user refunded, no CTX debt'
      : '🚨 Order failed before CTX paid — AUTO-REFUND FAILED (user out, no CTX debt)';
  const description = args.ctxPaid
    ? args.refunded
      ? `Loop already paid CTX for this order but procurement then failed. The user's off-chain balance has been auto-refunded; chase the wholesale cost back from CTX (operator-side debt).`
      : `Loop already paid CTX AND the automatic user refund FAILED. The user is debited with no gift card and the operator is out of pocket. Manual refund + CTX reconciliation needed NOW.`
    : args.refunded
      ? `Procurement failed before Loop paid CTX (bad response / schema drift / malformed payment URL) — no operator-side debt. The user's off-chain balance has been auto-refunded.`
      : `Procurement failed before Loop paid CTX AND the automatic user refund FAILED. The user is debited with no gift card. No CTX-side debt, but the user needs a manual refund NOW.`;
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title,
    color: args.ctxPaid || !args.refunded ? RED : ORANGE,
    description: truncate(description, DESCRIPTION_MAX),
    fields: [
      { name: 'Order', value: `\`${args.orderId.slice(-8)}\``, inline: true },
      {
        name: 'CTX order',
        value: args.ctxOrderId === null ? '_none_' : `\`${args.ctxOrderId.slice(-8)}\``,
        inline: true,
      },
      { name: 'User', value: `\`${args.userId.slice(-8)}\``, inline: true },
      { name: 'Charge (minor)', value: escapeMarkdown(args.chargeMinor), inline: true },
      { name: 'Currency', value: escapeMarkdown(args.chargeCurrency), inline: true },
      { name: 'User refunded?', value: args.refunded ? 'yes' : 'NO', inline: true },
      { name: 'CTX paid?', value: args.ctxPaid ? 'yes (operator debt open)' : 'no', inline: true },
      {
        name: 'Reason',
        value: truncate(escapeMarkdown(args.reason), FIELD_VALUE_MAX),
        inline: false,
      },
    ],
  });
}

/**
 * CF2-06 (2026-06-30 cold audit): fires when a price-feed rate (XLM
 * oracle or fiat FX feed) jumps by more than the configured sanity
 * bound between two refreshes — the feed's own request is rejected
 * (the caller throws and defers) rather than accepted, but this is
 * still page-worthy: either a real, unusual market move (rare for a
 * 60s window) or a compromised/glitching feed that needs operator
 * attention before it's trusted again.
 */
export function notifyPriceFeedAnomaly(args: {
  currency: string;
  feed: 'xlm' | 'fx';
  previousValue: number | null;
  newValue: number;
  maxRatio: number;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: `🚨 Price feed anomaly — ${args.currency} rate jump rejected`,
    color: RED,
    description: truncate(
      `The ${args.feed === 'xlm' ? 'XLM oracle' : 'fiat FX'} feed returned a ${args.currency} rate that deviates by more than ${Math.round(args.maxRatio * 100)}% from the last known-good value. Rejected as implausible rather than accepted — the affected order-creation/procurement path defers to the next tick. Investigate the upstream feed before this recurs.`,
      DESCRIPTION_MAX,
    ),
    fields: [
      { name: 'Currency', value: escapeMarkdown(args.currency), inline: true },
      { name: 'Feed', value: args.feed, inline: true },
      {
        name: 'Previous value',
        value: args.previousValue === null ? '_none_' : String(args.previousValue),
        inline: true,
      },
      { name: 'New value', value: String(args.newValue), inline: true },
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

/**
 * Notify: a LOOP-asset payment overpaid its order charge (hardening
 * A7). The order still fulfils — the user paid enough — but
 * `markOrderPaid` debits + burns only the charged amount, so the
 * excess sits at the deposit account (stranded, reads as positive
 * drift). Ops should return the excess LOOP to the user. Attributed
 * (order / user / excess) so a return can be issued directly, unlike
 * the drift watcher's aggregate signal.
 */
export function notifyLoopAssetOverpayment(args: {
  orderId: string;
  userId: string;
  assetCode: string;
  chargeMinor: string;
  chargeCurrency: string;
  /** Excess in stroops (bigint-as-string). */
  excessStroops: string;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🟡 LOOP-asset Overpayment — return excess to user',
    color: ORANGE,
    description: truncate(
      `A \`${escapeMarkdown(args.assetCode)}\` payment overpaid its order. The order fulfilled (the user paid enough), but the excess LOOP is parked at the deposit account and was NOT burned/debited — return it to the user. It reads as positive asset drift until then.`,
      DESCRIPTION_MAX,
    ),
    fields: [
      { name: 'Order', value: `\`${escapeMarkdown(args.orderId.slice(-8))}\``, inline: true },
      { name: 'User', value: `\`${escapeMarkdown(args.userId.slice(-8))}\``, inline: true },
      { name: 'Asset', value: escapeMarkdown(args.assetCode), inline: true },
      {
        name: 'Charged',
        value: `${escapeMarkdown(args.chargeMinor)} ${escapeMarkdown(args.chargeCurrency)}`,
        inline: true,
      },
      { name: 'Excess (stroops)', value: escapeMarkdown(args.excessStroops), inline: true },
    ],
  });
}

/**
 * Notify: the off-chain ledger invariant is violated (hardening C1;
 * ADR 009). `user_credits.balance_minor` no longer equals
 * `SUM(credit_transactions.amount_minor)` for at least one
 * (user, currency) pair — a writer desynced the mirror or the DB was
 * hand-edited; either way the money ledger cannot be trusted until
 * explained. Fired by the ledger-invariant watcher every tick
 * (default daily) WHILE the drift persists — deliberately no
 * transition dedup: an unresolved ledger-integrity incident should
 * re-page daily, not go quiet after one message.
 */
export function notifyLedgerDrift(args: {
  driftCount: number;
  /** True when the query limit was hit — the real count may be higher. */
  limitHit: boolean;
  sample: Array<{
    userId: string;
    currency: string;
    balanceMinor: string;
    ledgerSumMinor: string;
    deltaMinor: string;
  }>;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🚨 Ledger Invariant Violated',
    color: RED,
    description: truncate(
      `${args.driftCount}${args.limitHit ? '+' : ''} (user, currency) pair(s) where user_credits.balance_minor ≠ SUM(credit_transactions). The mirror can no longer be trusted until this is explained — triage via /api/admin/reconciliation. This page repeats daily while the drift persists.`,
      DESCRIPTION_MAX,
    ),
    fields: args.sample.slice(0, 5).map((d) => ({
      name: `${escapeMarkdown(d.userId.slice(0, 8))}… ${escapeMarkdown(d.currency)}`,
      value: truncate(
        `balance=${escapeMarkdown(d.balanceMinor)} ledger=${escapeMarkdown(d.ledgerSumMinor)} Δ=${escapeMarkdown(d.deltaMinor)}`,
        FIELD_VALUE_MAX,
      ),
      inline: false,
    })),
  });
}

// `notifyAssetDrift` and `notifyAssetDriftRecovered` (the paired
// open-and-close drift-watcher notifiers, ADR 015) live in
// `./monitoring-asset-drift.ts`. Re-exported below so existing
// import sites resolve unchanged.
export {
  notifyAssetDrift,
  notifyAssetDriftRecovered,
  notifyDriftFailedRows,
  notifyDriftFailedRowsCleared,
} from './monitoring-asset-drift.js';

// `notifyStuckProcurementSwept` (A2-621) and
// `notifyPaymentWatcherStuck` (A2-626) — the two stuck-row sweeper
// notifiers — live in `./monitoring-stuck-sweepers.ts`. Re-exported
// below so existing import sites resolve unchanged.
export {
  notifyStuckProcurementSwept,
  notifyPaymentWatcherStuck,
  notifyStuckPayouts,
  notifyRedemptionBackfillExhausted,
  notifyWalletProvisioningStuck,
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

/**
 * CF-13: per-operator dedup so a single expired operator bearer
 * doesn't flood `#monitoring` with one alert per request while it
 * keeps returning 401. 10-minute window matches the circuit-breaker
 * and CTX-schema-drift dedup cadence — long enough to stay quiet
 * during a sustained outage, short enough that "still expired" fires
 * within an ops rotation.
 */
const OPERATOR_CREDENTIAL_DEDUP_MS = 10 * 60 * 1000;
const operatorCredentialLastNotified = new Map<string, number>();

/** Test helper — wipe the per-operator credential-alert dedup map. */
export function __resetOperatorCredentialDedupForTests(): void {
  operatorCredentialLastNotified.clear();
}

/**
 * Notify: a CTX operator returned 401 ("token invalid") — its bearer
 * has expired or been revoked (CF-13). Operator bearers are static
 * and not yet auto-rotated (ADR 013 / `project_ctx_refresh_rotation`),
 * so the operator-side action is to re-mint and re-deploy the bearer
 * in `CTX_OPERATOR_POOL`. `operatorFetch` has already pulled the
 * operator from rotation (forced its breaker OPEN) and failed over to
 * a healthy sibling, so this is a degraded-not-down signal unless it
 * fires for every operator. Per-operator 10-minute dedup so a sustained
 * 401 produces one alert per operator per ten minutes, not one per
 * request.
 */
export function notifyOperatorCredentialExpired(args: {
  operatorId: string;
  poolSize: number;
  failedOver: boolean;
}): void {
  const now = Date.now();
  const last = operatorCredentialLastNotified.get(args.operatorId);
  if (last !== undefined && now - last < OPERATOR_CREDENTIAL_DEDUP_MS) {
    return;
  }
  operatorCredentialLastNotified.set(args.operatorId, now);
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 CTX Operator Credential Expired (401)',
    description: truncate(
      `Operator \`${escapeMarkdown(args.operatorId)}\` returned 401 from CTX — its bearer has expired or been revoked. It has been pulled from rotation. Re-mint the bearer and update \`CTX_OPERATOR_POOL\` (ADR 013). ${
        args.failedOver
          ? 'A healthy sibling operator served the request, so procurement continues degraded.'
          : 'No healthy sibling was available — procurement is blocked until a bearer is restored.'
      }`,
      DESCRIPTION_MAX,
    ),
    color: RED,
    fields: [
      { name: 'Operator', value: `\`${escapeMarkdown(args.operatorId)}\``, inline: true },
      { name: 'Pool size', value: String(args.poolSize), inline: true },
      { name: 'Failed over', value: args.failedOver ? 'yes' : 'no', inline: true },
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

/**
 * Notify: ADR 045 (B-3) duplicate-account signal — a fresh
 * `fraud_signals` row (first occurrence of this user pair, never a
 * re-page for an already-known pair; see
 * `fraud/duplicate-account-signals.ts`). Flag only — this is ops
 * visibility, not an automated account action; nothing about either
 * user's ability to transact changes because of this page.
 */
export function notifyDuplicateAccountSignal(args: {
  userId: string;
  relatedUserId: string;
  sourceAccount: string;
  orderId: string;
  relatedOrderId: string;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🟡 Duplicate-account signal — shared funding source',
    description: truncate(
      `The same on-chain funding account paid orders for two distinct Loop users. Flag only (ADR 045) — no account action was taken; review both accounts before deciding whether this is a shared household wallet or account-farming.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'User', value: `\`${escapeMarkdown(args.userId.slice(0, 8))}…\``, inline: true },
      {
        name: 'Related user',
        value: `\`${escapeMarkdown(args.relatedUserId.slice(0, 8))}…\``,
        inline: true,
      },
      {
        name: 'Funding account',
        value: `\`${escapeMarkdown(args.sourceAccount.slice(0, 8))}…${escapeMarkdown(args.sourceAccount.slice(-4))}\``,
        inline: true,
      },
      { name: 'Order', value: `\`${escapeMarkdown(args.orderId.slice(0, 8))}…\``, inline: true },
      {
        name: 'Related order',
        value: `\`${escapeMarkdown(args.relatedOrderId.slice(0, 8))}…\``,
        inline: true,
      },
    ],
  });
}
