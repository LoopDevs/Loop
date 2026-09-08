/**
 * Monitoring-channel Discord notifiers — fires to
 * `config.observability.discord.monitoringWebhook`. Signals covering the
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
 *
 * Test seams (`__resetCtxSchemaDriftDedupForTests` /
 * `__resetUnrecognizedDepositDedupForTests`) wipe the per-process
 * dedup state so tests can exercise the throttles deterministically.
 *
 * Pulled out of `discord.ts` so the per-channel surfaces are
 * traceable to one file each. Shared infrastructure
 * (`sendWebhook`, `truncate`, `escapeMarkdown`, colour constants)
 * lives in `./shared.ts`.
 */
import { config } from '../config/index.js';
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
  void sendWebhook(config.observability.discord.monitoringWebhook, {
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
  void sendWebhook(config.observability.discord.monitoringWebhook, {
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
  void sendWebhook(config.observability.discord.monitoringWebhook, {
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
 * PAYOUT-HASHHISTORY: a re-submit tried to overwrite a payout's durable
 * tx-hash anchor with a DIFFERING hash, and `recordPayoutTxHash` refused —
 * the anchor (the link to the funds that first moved) was preserved and the
 * new hash appended to the `payout_tx_hashes` history. This is rare and
 * benign in the normal case (the prior tx provably expired before the
 * re-submit), but under deep Horizon ingestion lag the prior tx may have
 * actually LANDED while reading 404 past its timebound — in which case the
 * fresh submit is a potential DOUBLE-PAY. Page ops so they can reconcile
 * both hashes against Horizon via `payout_tx_hashes`.
 *
 * Not throttled: a genuine anchor-overwrite refusal is a money-integrity
 * event worth one page each; it fires at most once per re-submit attempt.
 */
export function notifyPayoutTxHashOverwriteRefused(args: {
  payoutId: string;
  userId: string;
  /** The preserved durable anchor hash. */
  anchorTxHash: string;
  /** The re-submit hash that was appended to history (not made the anchor). */
  newTxHash: string;
  attempts: number;
}): void {
  void sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '🟠 Payout tx-hash overwrite refused',
    description: truncate(
      `Re-submit of payout ${args.payoutId.slice(-8)} signed a new tx hash while a durable anchor was already set. The anchor was PRESERVED and the new hash appended to \`payout_tx_hashes\`. If the anchored tx also landed (deep Horizon lag), this may be a double-pay — reconcile both hashes against Horizon.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'User', value: `\`${args.userId.slice(-8)}\``, inline: true },
      { name: 'Payout', value: `\`${args.payoutId.slice(-8)}\``, inline: true },
      { name: 'Attempts', value: String(args.attempts), inline: true },
      { name: 'Anchor hash', value: `\`${args.anchorTxHash.slice(0, 12)}…\``, inline: false },
      { name: 'New hash', value: `\`${args.newTxHash.slice(0, 12)}…\``, inline: false },
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
  void sendWebhook(config.observability.discord.monitoringWebhook, {
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
  return sendWebhook(config.observability.discord.monitoringWebhook, {
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
  return sendWebhook(config.observability.discord.monitoringWebhook, {
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
  void sendWebhook(config.observability.discord.monitoringWebhook, {
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
  void sendWebhook(config.observability.discord.monitoringWebhook, {
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

// `notifyVaultShareDrift` / `notifyVaultShareDriftRecovered` /
// `notifyVaultSolvencyBreach` / `notifyVaultSolvencyRecovered` (the
// paired open-and-close vault-drift-watcher notifiers, ADR 031 §D4,
// V5) live in `./monitoring-vault-drift.ts`. Re-exported below so
// existing import sites resolve unchanged.
export {
  notifyVaultShareDrift,
  notifyVaultShareDriftRecovered,
  notifyVaultSolvencyBreach,
  notifyVaultSolvencyRecovered,
  notifyVaultFloatDesync,
} from './monitoring-vault-drift.js';

// `notifyHotFloatBackingShortfall` (NS-06) — the pager for the hot-float
// USDC-BACKING reconciler (`treasury/hot-float-backing-reconciliation.ts`),
// the balance twin of `notifyVaultFloatDesync`. Lives in its own leaf
// module; re-exported so existing import sites resolve unchanged.
export {
  notifyHotFloatBackingShortfall,
  type HotFloatBackingShortfallArgs,
} from './monitoring-hot-float-backing.js';

// `notifyCtxSchemaDrift` (A2-1915) and its per-surface dedup state
// live in `./monitoring-ctx-schema-drift.ts`. Re-exported below
// alongside `__resetCtxSchemaDriftDedupForTests` so existing import
// sites keep resolving against `discord/monitoring.ts`.
export {
  notifyCtxSchemaDrift,
  __resetCtxSchemaDriftDedupForTests,
} from './monitoring-ctx-schema-drift.js';

/**
 * CF-13 (single-key form): dedup so a rejected API key doesn't flood
 * `#monitoring` with one alert per request while it keeps returning
 * 401. 10-minute window matches the CTX-schema-drift dedup
 * cadence — long enough to stay quiet during
 * a sustained outage, short enough that "still rejected" fires within
 * an ops rotation.
 */
const CTX_CREDENTIAL_DEDUP_MS = 10 * 60 * 1000;
let ctxCredentialLastNotified = 0;

/** Test helper — reset the credential-alert dedup window. */
export function __resetCtxCredentialDedupForTests(): void {
  ctxCredentialLastNotified = 0;
}

/**
 * Notify: CTX returned 401 — the operator API key was rejected
 * (revoked, rotated on the CTX side, or misconfigured). ADR 051:
 * Loop authenticates with a single API key, so this is a full outage
 * of every CTX call until `ctx.credentials` is restored. `ctxFetch` has already forced the upstream breaker
 * OPEN so procurement defers (orders stay retryable) instead of
 * failing paid orders. 10-minute dedup.
 */
export function notifyCtxCredentialInvalid(): void {
  const now = Date.now();
  if (now - ctxCredentialLastNotified < CTX_CREDENTIAL_DEDUP_MS) {
    return;
  }
  ctxCredentialLastNotified = now;
  void sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '🔴 CTX API Key Rejected (401)',
    description: truncate(
      `CTX returned 401 — the operator API key was rejected (revoked, rotated upstream, or misconfigured). Every CTX call fails until \`ctx.credentials\` is restored. Calls raise a transient error, so procurement defers and paid orders stay retryable rather than failing (ADR 051).`,
      DESCRIPTION_MAX,
    ),
    color: RED,
  });
}

// The sweeper/backfill/vault/wallet stuck-row notifiers live in
// `./monitoring-stuck-sweepers.ts`. Re-exported here so existing
// import sites keep resolving.
export {
  notifyRedemptionBackfillExhausted,
  notifyStuckPayouts,
  notifyVaultEmissionFailed,
  notifyVaultRedemptionFailed,
  notifyVaultRedemptionsStuck,
  notifyVaultEmissionsStuck,
  notifyWalletProvisioningStuck,
} from './monitoring-stuck-sweepers.js';

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
  void sendWebhook(config.observability.discord.monitoringWebhook, {
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
